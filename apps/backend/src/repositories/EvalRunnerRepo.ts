import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import EvalRunsDAL from "@/data-access-layer/EvalRunsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import EvalRunWorkflowProvider from "@/providers/evalRunWorkflow";
import AppLogger from "@/providers/logger";
import { recordAuditOrRollback } from "@/repositories/audit";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

type QueuedRun = Schemas.WithOutboxIds<Schemas.StartEvalRunApiResponse> & {
  companyPublicId?: string;
};

// DEV_NOTE: The hosted eval runner (M7-9, ADR 0007), the backend's side:
//   startRun: the dashboard's Run gate / Run tests. One withTenant: the version locked, a Gate run only of a Testing
//     version, one Queued or Running run per version at a time (a Queued one older than EVAL_RUN_QUEUED_STALE_MINUTES
//     is failed instead: it never reached the runner), the company's first Active Staging connection with a
//     test sign-in, a Queued eval_runs row (startedBy) and its audit row. After the commit the runner's Workflow is
//     started; if it can't be, the run is failed (RunnerUnavailable), never left Queued.
//   getRunLogin / failQueuedRun: the runner's service binding (EvalRunnerEntrypoint), never a route. getRunLogin hands
//     the runner the decrypted test sign-in of a run's connection, only while the run is Queued or Running and only for
//     a run the dashboard started; the plaintext is never logged or stored anywhere else.
// The run itself is driven by the runner over /eval/*, exactly as the CLI drives one (EvalHarnessRepo).
export default class EvalRunnerRepo {
  private env: Env;
  private db: NodePgDatabase;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private chatbotsDal: ChatbotsDAL;
  private companiesDal: CompaniesDAL;
  private companyConnectionsDal: CompanyConnectionsDAL;
  private companySecretsDal: CompanySecretsDAL;
  private evalRunsDal: EvalRunsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.companiesDal = new CompaniesDAL();
    this.companyConnectionsDal = new CompanyConnectionsDAL();
    this.companySecretsDal = new CompanySecretsDAL();
    this.evalRunsDal = new EvalRunsDAL();
  }

  private refuse(failure: Schemas.EvalRunStartFailureEnum, message: string): QueuedRun {
    return { isSuccess: false, message, failure, outboxIds: [] };
  }

  async startRun(
    params: Schemas.StartEvalRunApiRequest & {
      companyId: string;
      adminId: string;
      actor: Schemas.AuditActor;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.StartEvalRunApiResponse>> {
    const { companyId } = params;
    const isGate = params.trigger === Schemas.EvalRunTriggerIntEnum.Gate;

    const queued: QueuedRun = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<QueuedRun> => {
        // DEV_NOTE: The version's row is locked, so two presses (or a Back to draft) take turns with this check
        const config = await this.chatbotConfigsDal.getChatbotConfigDetails(tx, {
          companyId,
          publicId: params.chatbotConfigId,
          isForUpdate: true,
        });
        if (!config.isSuccess || !config.chatbotConfig) {
          return {
            isSuccess: false,
            message: config.message,
            isNotFound: config.isNotFound,
            outboxIds: [],
          };
        }
        const { chatbotConfig } = config;
        if (isGate && chatbotConfig.status !== Schemas.ChatbotConfigStatusIntEnum.Testing) {
          return this.refuse(
            Schemas.EvalRunStartFailureEnum.NotTesting,
            "Only a version sent to testing can have a gate run",
          );
        }

        const active = await this.evalRunsDal.getActiveEvalRunForConfig(tx, {
          companyId,
          chatbotConfigId: chatbotConfig.id,
        });
        if (active.isSuccess && active.evalRun) {
          const staleBefore = Date.now() - Schemas.EVAL_RUN_QUEUED_STALE_MINUTES * 60_000;
          const isStaleQueued =
            active.evalRun.status === Schemas.EvalRunStatusIntEnum.Queued &&
            active.evalRun.createdAt.getTime() < staleBefore;
          if (!isStaleQueued) {
            return this.refuse(
              Schemas.EvalRunStartFailureEnum.AlreadyRunning,
              "This version's tests are already running",
            );
          }
          const failed = await this.evalRunsDal.failQueuedEvalRun(tx, {
            companyId,
            id: active.evalRun.id,
            failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
          });
          if (!failed.isSuccess)
            return { isSuccess: false, message: failed.message, outboxIds: [] };
        } else if (!active.isNotFound) {
          return { isSuccess: false, message: active.message, outboxIds: [] };
        }

        const connections = await this.companySecretsDal.getEvalHostLoginConnections(tx, {
          companyId,
        });
        if (!connections.isSuccess || !connections.connectionIds) {
          return { isSuccess: false, message: connections.message, outboxIds: [] };
        }
        const [connectionId] = connections.connectionIds;
        if (!connectionId) {
          return this.refuse(
            Schemas.EvalRunStartFailureEnum.NoTestLogin,
            "Tests can't run yet: the staging connection has no test sign-in",
          );
        }

        const [chatbot, company] = await Promise.all([
          this.chatbotsDal.getChatbotDetails(tx, { companyId, id: chatbotConfig.chatbotId }),
          this.companiesDal.getCompanyDetails(tx, { companyId }),
        ]);
        if (!chatbot.isSuccess || !chatbot.chatbot || !company.isSuccess || !company.company) {
          return {
            isSuccess: false,
            message: chatbot.isSuccess ? company.message : chatbot.message,
            outboxIds: [],
          };
        }

        const created = await this.evalRunsDal.queueEvalRun(tx, {
          companyId,
          chatbotConfigId: chatbotConfig.id,
          companyConnectionId: connectionId,
          trigger: params.trigger,
          k: Schemas.DASHBOARD_EVAL_RUN_K[params.trigger],
          startedBy: params.adminId,
        });
        if (!created.isSuccess || !created.evalRun) {
          return { isSuccess: false, message: created.message, outboxIds: [] };
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId,
          actor: params.actor,
          entityType: Schemas.AuditEntityTypeEnum.ChatbotConfig,
          entityAction: isGate
            ? Schemas.AuditEntityActionEnum.GateRunStarted
            : Schemas.AuditEntityActionEnum.TestRunStarted,
          entity: chatbotConfig,
          entityVersion: chatbotConfig.configVersion,
          label: Schemas.chatbotConfigLabel(chatbot.chatbot.name, chatbotConfig.configVersion),
        });
        return {
          isSuccess: true,
          message: "Eval run queued",
          evalRun: { publicId: created.evalRun.publicId },
          companyPublicId: company.company.publicId,
          outboxIds: [outboxId],
        };
      },
    );
    const { companyPublicId, ...answer } = queued;
    if (!answer.isSuccess || !answer.evalRun || !companyPublicId) return answer;

    const runPublicId = answer.evalRun.publicId;
    const started = await EvalRunWorkflowProvider.start(this.env, { companyPublicId, runPublicId });
    if (!started.isSuccess) {
      await this.failRun(companyId, runPublicId);
      return {
        ...this.refuse(
          Schemas.EvalRunStartFailureEnum.RunnerUnavailable,
          "The test runner couldn't take the run; try again in a minute",
        ),
        outboxIds: answer.outboxIds,
      };
    }
    AppLogger.info({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.QueueEvalRun,
      message: "Eval run queued on the hosted runner",
      metadata: { companyId, runPublicId, trigger: params.trigger },
    });
    return answer;
  }

  // DEV_NOTE: The runner's binding. The company by public id (withPlatform: the runner names it, as an eval JWT does),
  // then everything else in its withTenant.
  private async companyIdOf(companyPublicId: string): Promise<string | null> {
    const company: Schemas.CompanyDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.companiesDal.getCompanyByPublicId(tx, { publicId: companyPublicId });
    });
    return company.isSuccess && company.company ? company.company.id : null;
  }

  // DEV_NOTE: The decrypted test sign-in of a run's connection, for the runner only: the run must be one the dashboard
  // started (startedBy), still Queued or Running, on an Active Staging connection. Any other run is NotFound.
  async getRunLogin(params: Schemas.EvalRunWorkflowParams): Promise<Schemas.EvalRunLoginResponse> {
    const notFound = { isSuccess: false, message: "Eval run not found", isNotFound: true };
    const companyId = await this.companyIdOf(params.companyPublicId);
    if (!companyId) return notFound;

    const result = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.EvalRunLoginResponse> => {
        const run = await this.evalRunsDal.getEvalRun(tx, {
          companyId,
          publicId: params.runPublicId,
        });
        if (!run.isSuccess || !run.evalRun)
          return run.isNotFound ? notFound : { isSuccess: false, message: run.message };
        const { evalRun } = run;
        const isOpen =
          evalRun.status === Schemas.EvalRunStatusIntEnum.Queued ||
          evalRun.status === Schemas.EvalRunStatusIntEnum.Running;
        if (!isOpen || evalRun.startedBy === null || evalRun.companyConnectionId === null) {
          return notFound;
        }

        const connection = await this.companyConnectionsDal.getCompanyConnectionDetails(tx, {
          companyId,
          id: evalRun.companyConnectionId,
        });
        if (!connection.isSuccess || !connection.companyConnection) {
          return { isSuccess: false, message: connection.message };
        }
        const { companyConnection } = connection;
        if (
          companyConnection.environment !== Schemas.CompanyConnectionEnvironmentIntEnum.Staging ||
          companyConnection.status !== Schemas.CompanyConnectionStatusIntEnum.Active
        ) {
          return {
            isSuccess: false,
            message: "The run's connection isn't an active staging connection",
          };
        }

        const login = await this.decryptLogin(tx, companyId, companyConnection.id);
        if (!login.isSuccess || !login.login) return { isSuccess: false, message: login.message };
        const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
        if (!company.isSuccess || !company.company)
          return { isSuccess: false, message: company.message };
        return {
          isSuccess: true,
          message: "Run login fetched",
          runLogin: {
            companyPublicId: company.company.publicId,
            connectionPublicId: companyConnection.publicId,
            login: login.login,
          },
        };
      },
    );
    AppLogger.info({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.GetEvalRunLogin,
      message: result.isSuccess ? "Run login handed to the runner" : "Run login refused",
      metadata: { companyId, runPublicId: params.runPublicId, isSuccess: result.isSuccess },
    });
    return result;
  }

  // DEV_NOTE: A connection's Active test sign-in, decrypted and read with ZEvalHostLogin. Server side only.
  private async decryptLogin(
    tx: Tx,
    companyId: string,
    connectionId: string,
  ): Promise<Schemas.ApiResponse & { login?: Schemas.EvalHostLogin }> {
    const secret = await this.companySecretsDal.getConnectionEvalHostLogin(tx, {
      companyId,
      connectionId,
    });
    if (!secret.isSuccess || !secret.companySecret)
      return { isSuccess: false, message: secret.message };
    const decrypted = await CompanyKeyProvider.decryptCompanySecret(
      this.env,
      tx,
      secret.companySecret,
    );
    if (!decrypted.isSuccess || decrypted.secret === undefined) {
      return { isSuccess: false, message: decrypted.message };
    }
    const login = Schemas.ZEvalHostLogin.safeParse(Utility.parseJson(decrypted.secret));
    if (!login.success)
      return { isSuccess: false, message: "The stored test sign-in can't be read" };
    return { isSuccess: true, message: "Test sign-in read", login: login.data };
  }

  // DEV_NOTE: The runner couldn't start a run (its sign-in or its first step failed before /eval/runs): Queued → Failed
  // with RunnerUnavailable. A run that already started is left to the runner's own finish.
  async failQueuedRun(params: Schemas.EvalRunWorkflowParams): Promise<Schemas.ApiResponse> {
    const companyId = await this.companyIdOf(params.companyPublicId);
    if (!companyId) return { isSuccess: false, message: "Eval run not found", isNotFound: true };
    return await this.failRun(companyId, params.runPublicId);
  }

  private async failRun(companyId: string, runPublicId: string): Promise<Schemas.ApiResponse> {
    return await withTenant(this.db, companyId, async (tx): Promise<Schemas.ApiResponse> => {
      const run = await this.evalRunsDal.getEvalRun(tx, {
        companyId,
        publicId: runPublicId,
        isLocked: true,
      });
      if (!run.isSuccess || !run.evalRun)
        return { isSuccess: false, message: run.message, isNotFound: run.isNotFound };
      if (run.evalRun.status !== Schemas.EvalRunStatusIntEnum.Queued) {
        return { isSuccess: true, message: "Eval run already started" };
      }
      const failed = await this.evalRunsDal.failQueuedEvalRun(tx, {
        companyId,
        id: run.evalRun.id,
        failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
      });
      return { isSuccess: failed.isSuccess, message: failed.message };
    });
  }
}
