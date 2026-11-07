import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
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
//     version, one Queued or Running run per version at a time (a stale one is failed instead: Queued for longer than
//     EVAL_RUN_QUEUED_STALE_MINUTES never reached the runner, Running with no change for EVAL_RUN_RUNNING_STALE_MINUTES
//     lost it), the company's first Active Staging connection with a test sign-in, a Queued eval_runs row (startedBy;
//     with failedCasesOfRunId, holding that run's failed cases as its set) and its audit row. After the commit the
//     runner's Workflow is started; if it can't be, the run is failed (RunnerUnavailable), never left Queued.
//   resumeRun: a Failed run reopened with its results (ADR 0007 › Resume), started again the same way.
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
  private evalCasesDal: EvalCasesDAL;
  private evalRunsDal: EvalRunsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.companiesDal = new CompaniesDAL();
    this.companyConnectionsDal = new CompanyConnectionsDAL();
    this.companySecretsDal = new CompanySecretsDAL();
    this.evalCasesDal = new EvalCasesDAL();
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
        const blocked = await this.clearActiveRun(tx, companyId, chatbotConfig.id);
        if (blocked) return blocked;

        let evalCaseIds: string[] | null = null;
        if (params.failedCasesOfRunId) {
          const failed = await this.failedCasesOf(tx, {
            companyId,
            runPublicId: params.failedCasesOfRunId,
            chatbotId: chatbotConfig.chatbotId,
          });
          if (!failed.isSuccess || !failed.evalCaseIds) return failed;
          evalCaseIds = failed.evalCaseIds;
        }

        const connections = await this.companySecretsDal.getEvalHostLoginConnections(tx, {
          companyId,
        });
        if (!connections.isSuccess || !connections.connectionIds) {
          return { isSuccess: false, message: connections.message, outboxIds: [] };
        }
        const [connectionId] = connections.connectionIds;
        if (!connectionId) return this.noTestLogin();

        const labelled = await this.versionLabel(tx, companyId, chatbotConfig);
        if (!labelled.isSuccess || !labelled.label || !labelled.companyPublicId) return labelled;

        const created = await this.evalRunsDal.queueEvalRun(tx, {
          companyId,
          chatbotConfigId: chatbotConfig.id,
          companyConnectionId: connectionId,
          trigger: params.trigger,
          k: Schemas.DASHBOARD_EVAL_RUN_K[params.trigger],
          startedBy: params.adminId,
          evalCaseIds,
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
          label: labelled.label,
        });
        return {
          isSuccess: true,
          message: "Eval run queued",
          evalRun: { publicId: created.evalRun.publicId },
          companyPublicId: labelled.companyPublicId,
          outboxIds: [outboxId],
        };
      },
    );
    return await this.handOff(companyId, queued, 0, { trigger: params.trigger });
  }

  // DEV_NOTE: Resume (ADR 0007 › Resume): a Failed run the dashboard started and the runner reached, or a Running one
  // that lost its runner (canResumeEvalRun; failed here first) goes back to Queued with its case set and results, resumed_count one up, then the runner's
  // chain starts again as <run>-r<n> and runs only the attempts without a result. A Gate run's version must still be
  // Testing (an incomplete gate run leaves it there). Same one-run-per-version rule and test sign-in check as startRun,
  // the version locked; audited RunResumed.
  async resumeRun(params: {
    companyId: string;
    publicId: string;
    actor: Schemas.AuditActor;
  }): Promise<Schemas.WithOutboxIds<Schemas.StartEvalRunApiResponse>> {
    const { companyId } = params;
    let resumedCount = 0;
    const queued: QueuedRun = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<QueuedRun> => {
        const found = await this.evalRunsDal.getEvalRun(tx, {
          companyId,
          publicId: params.publicId,
        });
        if (!found.isSuccess || !found.evalRun) {
          return {
            isSuccess: false,
            message: found.message,
            isNotFound: found.isNotFound,
            outboxIds: [],
          };
        }
        const config = await this.chatbotConfigsDal.getChatbotConfigDetails(tx, {
          companyId,
          id: found.evalRun.chatbotConfigId,
          isForUpdate: true,
        });
        if (!config.isSuccess || !config.chatbotConfig) {
          return { isSuccess: false, message: config.message, outboxIds: [] };
        }
        const { chatbotConfig } = config;
        // DEV_NOTE: Read again under the version's lock, then locked itself
        const locked = await this.evalRunsDal.getEvalRun(tx, {
          companyId,
          publicId: params.publicId,
          isLocked: true,
        });
        if (!locked.isSuccess || !locked.evalRun) {
          return { isSuccess: false, message: locked.message, outboxIds: [] };
        }
        const run = locked.evalRun;
        if (!Schemas.canResumeEvalRun(run, Date.now()) || run.companyConnectionId === null) {
          return this.refuse(
            Schemas.EvalRunStartFailureEnum.NotResumable,
            "Only a run that stopped on the way can be resumed",
          );
        }
        if (
          run.trigger === Schemas.EvalRunTriggerIntEnum.Gate &&
          chatbotConfig.status !== Schemas.ChatbotConfigStatusIntEnum.Testing
        ) {
          return this.refuse(
            Schemas.EvalRunStartFailureEnum.NotTesting,
            "This version isn't in testing any more; send it to testing and run its tests again",
          );
        }
        // DEV_NOTE: A Running run that lost its runner is failed here first (as the next Run press would), so it is
        // resumed instead of a new run starting
        if (run.status === Schemas.EvalRunStatusIntEnum.Running) {
          const failed = await this.evalRunsDal.failOpenEvalRun(tx, {
            companyId,
            id: run.id,
            status: Schemas.EvalRunStatusIntEnum.Running,
            failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
          });
          if (!failed.isSuccess)
            return { isSuccess: false, message: failed.message, outboxIds: [] };
        }
        const blocked = await this.clearActiveRun(tx, companyId, chatbotConfig.id);
        if (blocked) return blocked;

        const connections = await this.companySecretsDal.getEvalHostLoginConnections(tx, {
          companyId,
        });
        if (!connections.isSuccess || !connections.connectionIds) {
          return { isSuccess: false, message: connections.message, outboxIds: [] };
        }
        if (!connections.connectionIds.includes(run.companyConnectionId)) return this.noTestLogin();

        const labelled = await this.versionLabel(tx, companyId, chatbotConfig);
        if (!labelled.isSuccess || !labelled.label || !labelled.companyPublicId) return labelled;

        const reopened = await this.evalRunsDal.reopenEvalRun(tx, { companyId, id: run.id });
        if (!reopened.isSuccess || !reopened.evalRun) {
          return { isSuccess: false, message: reopened.message, outboxIds: [] };
        }
        const outboxId = await recordAuditOrRollback(tx, {
          companyId,
          actor: params.actor,
          entityType: Schemas.AuditEntityTypeEnum.ChatbotConfig,
          entityAction: Schemas.AuditEntityActionEnum.RunResumed,
          entity: chatbotConfig,
          entityVersion: chatbotConfig.configVersion,
          label: labelled.label,
        });
        resumedCount = reopened.evalRun.resumedCount;
        return {
          isSuccess: true,
          message: "Eval run resumed",
          evalRun: { publicId: run.publicId },
          companyPublicId: labelled.companyPublicId,
          outboxIds: [outboxId],
        };
      },
    );
    return await this.handOff(companyId, queued, resumedCount, { resumed: true });
  }

  // DEV_NOTE: After the commit: the runner's chain is started (its first instance <run>, or <run>-r<n> for a resume);
  // if it can't be, the run is failed (RunnerUnavailable), never left Queued
  private async handOff(
    companyId: string,
    queued: QueuedRun,
    resumedCount: number,
    detail: Record<string, unknown>,
  ): Promise<Schemas.WithOutboxIds<Schemas.StartEvalRunApiResponse>> {
    const { companyPublicId, ...answer } = queued;
    if (!answer.isSuccess || !answer.evalRun || !companyPublicId) return answer;

    const runPublicId = answer.evalRun.publicId;
    const started = await EvalRunWorkflowProvider.start(this.env, {
      companyPublicId,
      runPublicId,
      resumedCount,
    });
    if (!started.isSuccess) {
      await this.failRun(companyId, runPublicId, Schemas.EvalRunFailureIntEnum.RunnerUnavailable);
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
      action: resumedCount > 0 ? Schemas.LogAction.ResumeEvalRun : Schemas.LogAction.QueueEvalRun,
      message: "Eval run queued on the hosted runner",
      metadata: { companyId, runPublicId, resumedCount, ...detail },
    });
    return answer;
  }

  // DEV_NOTE: One Queued or Running run per version: null when there is none, or when the one there is stale and was
  // failed here (Queued or Running with no change for its stale limit: it never reached, or lost, the runner); else
  // the refusal
  private async clearActiveRun(
    tx: Tx,
    companyId: string,
    chatbotConfigId: string,
  ): Promise<QueuedRun | null> {
    const active = await this.evalRunsDal.getActiveEvalRunForConfig(tx, {
      companyId,
      chatbotConfigId,
    });
    if (active.isNotFound) return null;
    if (!active.isSuccess || !active.evalRun) {
      return { isSuccess: false, message: active.message, outboxIds: [] };
    }
    const { evalRun } = active;
    const isQueued = evalRun.status === Schemas.EvalRunStatusIntEnum.Queued;
    if (!Schemas.isEvalRunStale(evalRun, Date.now())) {
      return this.refuse(
        Schemas.EvalRunStartFailureEnum.AlreadyRunning,
        "This version's tests are already running",
      );
    }
    const failed = await this.evalRunsDal.failOpenEvalRun(tx, {
      companyId,
      id: evalRun.id,
      status: isQueued ? Schemas.EvalRunStatusIntEnum.Queued : Schemas.EvalRunStatusIntEnum.Running,
      failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
    });
    if (!failed.isSuccess) return { isSuccess: false, message: failed.message, outboxIds: [] };
    return null;
  }

  // DEV_NOTE: The cases a run of the same chatbot didn't pass every attempt of (Schemas.failedEvalCaseIds, never run
  // included), still active: what "Run failed cases" runs. None = NothingToRun.
  private async failedCasesOf(
    tx: Tx,
    params: { companyId: string; runPublicId: string; chatbotId: string },
  ): Promise<QueuedRun & { evalCaseIds?: string[] }> {
    const { companyId } = params;
    const nothing = this.refuse(
      Schemas.EvalRunStartFailureEnum.NothingToRun,
      "That run has no failed case that can still run",
    );
    const found = await this.evalRunsDal.getEvalRun(tx, {
      companyId,
      publicId: params.runPublicId,
    });
    if (!found.isSuccess || !found.evalRun) {
      return {
        isSuccess: false,
        message: found.message,
        isNotFound: found.isNotFound,
        outboxIds: [],
      };
    }
    const run = found.evalRun;
    const runConfig = await this.chatbotConfigsDal.getChatbotConfigDetails(tx, {
      companyId,
      id: run.chatbotConfigId,
    });
    if (!runConfig.isSuccess || !runConfig.chatbotConfig) {
      return { isSuccess: false, message: runConfig.message, outboxIds: [] };
    }
    if (runConfig.chatbotConfig.chatbotId !== params.chatbotId) {
      return {
        isSuccess: false,
        message: "That run is another chatbot's",
        isNotFound: true,
        outboxIds: [],
      };
    }
    const caseIds = run.evalCaseIds ?? [];
    if (caseIds.length === 0) return nothing;
    const tallied = await this.evalRunsDal.getEvalRunTallies(tx, {
      companyId,
      evalRunId: run.id,
      evalCaseIds: caseIds,
    });
    if (!tallied.isSuccess || !tallied.tallies) {
      return { isSuccess: false, message: tallied.message, outboxIds: [] };
    }
    const failedIds = Schemas.failedEvalCaseIds({ caseIds, k: run.k, tallies: tallied.tallies });
    if (failedIds.length === 0) return nothing;
    const runnable = await this.evalCasesDal.getRunnableEvalCases(tx, {
      companyId,
      chatbotId: params.chatbotId,
      limit: Schemas.EVAL_RUN_MAX_CASES + 1,
      evalCaseIds: failedIds,
    });
    if (!runnable.isSuccess || !runnable.evalCases) {
      return { isSuccess: false, message: runnable.message, outboxIds: [] };
    }
    if (runnable.evalCases.length === 0) return nothing;
    return {
      isSuccess: true,
      message: "Failed cases found",
      outboxIds: [],
      evalCaseIds: runnable.evalCases.map((row) => row.id),
    };
  }

  // DEV_NOTE: The audit row's label (the chatbot's name and the version) and the company's public id (the runner's)
  private async versionLabel(
    tx: Tx,
    companyId: string,
    chatbotConfig: Schemas.ChatbotConfig,
  ): Promise<QueuedRun & { label?: string }> {
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
    return {
      isSuccess: true,
      message: "Version labelled",
      outboxIds: [],
      label: Schemas.chatbotConfigLabel(chatbot.chatbot.name, chatbotConfig.configVersion),
      companyPublicId: company.company.publicId,
    };
  }

  private noTestLogin(): QueuedRun {
    return this.refuse(
      Schemas.EvalRunStartFailureEnum.NoTestLogin,
      "Tests can't run yet: the staging connection has no test sign-in",
    );
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
  // with the stop it hit. A run that already started is left to the runner's own finish.
  async failQueuedRun(params: Schemas.FailQueuedEvalRunParams): Promise<Schemas.ApiResponse> {
    const companyId = await this.companyIdOf(params.companyPublicId);
    if (!companyId) return { isSuccess: false, message: "Eval run not found", isNotFound: true };
    return await this.failRun(companyId, params.runPublicId, params.failure);
  }

  private async failRun(
    companyId: string,
    runPublicId: string,
    failure: Schemas.EvalRunFailureIntEnum,
  ): Promise<Schemas.ApiResponse> {
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
      const failed = await this.evalRunsDal.failOpenEvalRun(tx, {
        companyId,
        id: run.evalRun.id,
        status: Schemas.EvalRunStatusIntEnum.Queued,
        failure,
      });
      return { isSuccess: failed.isSuccess, message: failed.message };
    });
  }
}
