import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import { getAgentByName } from "agents";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import EvalRunsDAL from "@/data-access-layer/EvalRunsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import EvalRefusalProvider from "@/providers/evalRefusal";
import HostToolCallProvider from "@/providers/hostToolCall";
import AppLogger from "@/providers/logger";
import ActionEngineRepo from "@/repositories/ActionEngineRepo";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: The eval harness's API (M5-2): /eval/* as the platform's harness drives it, one Repo method per route.
// Every call is authenticated first (authenticateEval → EvalAuthRepo): the identity names one company and its active
// Staging connection. Everything here is scoped to that company (withTenant), and a run to the connection it started
// on: a step whose token names another connection is NotFound.
//   startRun: a Running eval_runs row for one config (any status), its staging connection and its case set
//     (eval_case_ids): the config's chatbot's active cases and every active platform case, upgraded to the current
//     shapes (a case that won't load refuses the run: the gate must never pass on a case it skipped).
//   runAttempt: one attempt of one of the run's cases: a new conversation of the run (pinned to its config and the
//     staging connection) that the Conversation DO runs in one turn over DO RPC (runEvalAttempt), every write
//     auto-approved.
//   readBack: a readback assert, the same request live verification sends, on the staging connection.
//   recordResult: one graded attempt of one of the run's cases (eval_results, append-only).
//   reset: the connection's reset_op, once after the attempts.
//   finish: Done (every case of the set ran its k attempts) or Failed, with pass^k over the whole set.
// Trust: the harness is platform code holding the platform key. The messages of an attempt are the harness's (its
// case's input with {case.tag} filled in), not compared to the stored case; the grading is the harness's too.
// The host bearer token (the harness's, from the host's own login) only passes through: to the DO's memory or the
// adapter. It is never stored or logged (pattern rule 3.11). Case text and host data stay out of every log.
export default class EvalHarnessRepo {
  private env: Env;
  private db: NodePgDatabase;
  private chatbotsDal: ChatbotsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private evalCasesDal: EvalCasesDAL;
  private evalRunsDal: EvalRunsDAL;
  private conversationsDal: ConversationsDAL;
  private conversationsRepo: ConversationsRepo;
  private actionEngineRepo: ActionEngineRepo;

  // DEV_NOTE: The Repos it hands a step to (an attempt's conversation, a readback's plan) are built once, here
  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.chatbotsDal = new ChatbotsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.evalCasesDal = new EvalCasesDAL();
    this.evalRunsDal = new EvalRunsDAL();
    this.conversationsDal = new ConversationsDAL();
    this.conversationsRepo = new ConversationsRepo(env);
    this.actionEngineRepo = new ActionEngineRepo(env);
  }

  // DEV_NOTE: A Running run of the config, and the cases it runs. The config's chatbot must be active and the config
  // must load (loadConfigSpec), else nothing is created. Cases are read in the same transaction as the insert, which
  // stores them as the run's case set, with the token's staging connection.
  async startRun(params: {
    identity: Schemas.EvalIdentity;
    request: Schemas.CreateEvalRunApiRequest;
  }): Promise<Schemas.CreateEvalRunResponse> {
    const { identity, request } = params;
    const companyId = identity.companyId;
    const refuse = (failure: Schemas.EvalRunStepFailureEnum, message: string | undefined) =>
      this.refuseStep(Schemas.LogAction.StartEvalRun, failure, message, { companyId });

    const result: Schemas.CreateEvalRunResponse = await withTenant(
      this.db,
      companyId,
      async (tx) => {
        const config = await this.chatbotConfigsDal.getChatbotConfigDetails(tx, {
          companyId,
          publicId: request.chatbotConfigId,
        });
        if (!config.isSuccess || !config.chatbotConfig) {
          return this.stepFailure(config.isNotFound, config.message);
        }
        const { chatbotConfig } = config;
        const loaded = Schemas.loadConfigSpec({
          schemaVersion: chatbotConfig.schemaVersion,
          body: chatbotConfig.body,
        });
        if (!loaded.isSuccess) {
          return {
            isSuccess: false,
            message: "The config doesn't load",
            failure: Schemas.EvalRunStepFailureEnum.Invalid,
          };
        }
        const chatbot = await this.activeChatbot(tx, companyId, chatbotConfig.chatbotId);
        if (!chatbot.isSuccess || !chatbot.chatbot) return chatbot;

        // DEV_NOTE: One over the limit, so a run with too many cases is refused instead of cut short
        const runnable = await this.evalCasesDal.getRunnableEvalCases(tx, {
          companyId,
          chatbotId: chatbotConfig.chatbotId,
          limit: Schemas.EVAL_RUN_MAX_CASES + 1,
        });
        if (!runnable.isSuccess || !runnable.evalCases) {
          return this.stepFailure(false, runnable.message);
        }
        if (runnable.evalCases.length > Schemas.EVAL_RUN_MAX_CASES) {
          return {
            isSuccess: false,
            message: `The chatbot has more than ${Schemas.EVAL_RUN_MAX_CASES} active eval cases`,
            failure: Schemas.EvalRunStepFailureEnum.Invalid,
          };
        }
        const cases: Schemas.EvalHarnessCase[] = [];
        const evalCaseIds: string[] = [];
        for (const row of runnable.evalCases) {
          const body = Schemas.readEvalCaseBody(row.input, row.expectations);
          const expectations = Schemas.loadEvalCaseExpectations(row.expectations);
          if (!body || !expectations) {
            return {
              isSuccess: false,
              message: `Eval case ${row.publicId} can't be read`,
              failure: Schemas.EvalRunStepFailureEnum.Invalid,
            };
          }
          cases.push({
            publicId: row.publicId,
            name: row.name,
            isSafety: row.isSafety,
            input: {
              schemaVersion: Schemas.EVAL_CASE_INPUT_SCHEMA_VERSION,
              messages: body.messages,
            },
            expectations,
          });
          evalCaseIds.push(row.id);
        }
        if (cases.length === 0) {
          return {
            isSuccess: false,
            message: "The chatbot has no active eval case",
            failure: Schemas.EvalRunStepFailureEnum.Invalid,
          };
        }

        const created = await this.evalRunsDal.createEvalRun(tx, {
          companyId,
          chatbotConfigId: chatbotConfig.id,
          companyConnectionId: identity.connectionId,
          evalCaseIds,
          trigger: request.trigger,
          harnessVersion: request.harnessVersion,
          k: request.k,
        });
        if (!created.isSuccess || !created.evalRun) return this.stepFailure(false, created.message);
        const { evalRun } = created;
        return {
          isSuccess: true,
          message: "Eval run started",
          run: { publicId: evalRun.publicId, k: evalRun.k, harnessVersion: evalRun.harnessVersion },
          cases,
        };
      },
    );
    if (!result.isSuccess) {
      return refuse(result.failure ?? Schemas.EvalRunStepFailureEnum.ServerError, result.message);
    }
    AppLogger.info({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.StartEvalRun,
      message: "Eval run started",
      metadata: { companyId, runPublicId: result.run?.publicId, caseCount: result.cases?.length },
    });
    return result;
  }

  // DEV_NOTE: The run, case and attempt are checked first (one withTenant, the run row locked so a finish can't slip
  // in), then the conversation is started (ConversationsRepo.startEvalConversation) and run by its DO. The attempt's
  // conversation is unique per run: a repeat is Duplicate before any model call. The DO answers the turn's outcome; a
  // turn that couldn't start (paused chatbot, no model key, a budget) is an attempt failure. An attempt that started
  // runs to its end even if the run is finished meanwhile; its result can't be recorded then. outboxIds are relayed by
  // the route.
  async runAttempt(params: {
    identity: Schemas.EvalIdentity;
    runPublicId: string;
    request: Schemas.RunEvalAttemptApiRequest;
    hostToken: string;
  }): Promise<Schemas.RunEvalAttemptResponse> {
    const { identity, request } = params;
    const companyId = identity.companyId;
    const metadata = { companyId, runPublicId: params.runPublicId, attempt: request.attempt };

    const checked: Schemas.EvalAttemptCheckResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.EvalAttemptCheckResponse> => {
        const running = await this.runningRun(tx, identity, params.runPublicId, true);
        if (!running.isSuccess || !running.run || !running.chatbotId) return running;
        if (request.attempt > running.run.k) {
          return {
            isSuccess: false,
            message: "Attempt is past the run's k",
            failure: Schemas.EvalRunStepFailureEnum.Invalid,
          };
        }
        const evalCase = await this.runCase(tx, companyId, running.run, request.caseId);
        if (!evalCase.isSuccess || !evalCase.evalCaseId) return evalCase;
        const chatbot = await this.activeChatbot(tx, companyId, running.chatbotId);
        if (!chatbot.isSuccess || !chatbot.chatbot) return chatbot;
        return {
          isSuccess: true,
          run: running.run,
          chatbot: chatbot.chatbot,
          evalCaseId: evalCase.evalCaseId,
        };
      },
    );
    if (!checked.isSuccess || !checked.run || !checked.chatbot || !checked.evalCaseId) {
      const failure = checked.failure ?? Schemas.EvalRunStepFailureEnum.ServerError;
      return {
        ...this.refuseStep(Schemas.LogAction.RunEvalAttempt, failure, checked.message, metadata),
        kind: "step",
      };
    }

    const started = await this.conversationsRepo.startEvalConversation({
      identity,
      evalRunId: checked.run.id,
      evalCaseId: checked.evalCaseId,
      evalAttempt: request.attempt,
      chatbotConfigId: checked.run.chatbotConfigId,
      chatbot: checked.chatbot,
    });
    if (started.isDuplicate) {
      return {
        ...this.refuseStep(
          Schemas.LogAction.RunEvalAttempt,
          Schemas.EvalRunStepFailureEnum.Duplicate,
          started.message,
          metadata,
        ),
        kind: "step",
      };
    }
    if (!started.isSuccess || !started.session) {
      return {
        isSuccess: false,
        message: started.message ?? "Eval conversation not started",
        kind: "attempt",
        failure: started.failure ?? Schemas.EvalAttemptFailureEnum.ServerError,
        outboxIds: [],
      };
    }
    const { session } = started;
    const outboxIds = started.outboxId ? [started.outboxId] : [];

    const startedAt = Date.now();
    let ran: Schemas.EvalAttemptRunResponse;
    try {
      const stub = await getAgentByName(this.env.CONVERSATION_DO, session.conversationPublicId);
      const answered = Schemas.ZEvalAttemptRunResponse.safeParse(
        Utility.parseJson(
          await stub.runEvalAttempt({
            session,
            hostToken: params.hostToken,
            messages: request.messages,
          }),
        ),
      );
      ran = answered.success
        ? answered.data
        : {
            isSuccess: false,
            message: "Conversation DO answered something else",
            failure: Schemas.EvalAttemptFailureEnum.ServerError,
          };
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.RunEvalAttempt,
        message: "Conversation DO unreachable",
        error,
        metadata,
      });
      ran = {
        isSuccess: false,
        message: "Conversation DO unreachable",
        failure: Schemas.EvalAttemptFailureEnum.ServerError,
      };
    }
    const latencyMs = Date.now() - startedAt;
    if (!ran.isSuccess || !ran.turnStatus) {
      AppLogger.warn({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.RunEvalAttempt,
        message: ran.message ?? "Eval attempt didn't run",
        metadata: { ...metadata, failure: ran.failure ?? null },
      });
      return {
        isSuccess: false,
        message: ran.message ?? "Eval attempt didn't run",
        kind: "attempt",
        failure: ran.failure ?? Schemas.EvalAttemptFailureEnum.ServerError,
        outboxIds,
      };
    }

    return {
      isSuccess: true,
      message: "Eval attempt ran",
      outboxIds,
      attempt: {
        conversationId: session.conversationPublicId,
        turnStatus: ran.turnStatus,
        reply: ran.reply ?? "",
        toolCalls: ran.toolCalls ?? [],
        latencyMs,
      },
    };
  }

  // DEV_NOTE: A readback assert: the conversation must be one of this run's, the change request one of the
  // conversation's, its tool the readback's toolName. The record is read through the tool's readback_op with the
  // change request's args and the commit's result, on the token's staging connection, and compared by
  // Schemas.checkEvalReadback. A read the host refused or couldn't answer is an Unknown verdict, not a refusal.
  async readBack(params: {
    identity: Schemas.EvalIdentity;
    runPublicId: string;
    request: Schemas.EvalReadbackApiRequest;
    hostToken: string;
  }): Promise<Schemas.EvalReadbackResponse> {
    const { identity, request } = params;
    const companyId = identity.companyId;
    const metadata = { companyId, runPublicId: params.runPublicId };
    const refuse = (failure: Schemas.EvalRunStepFailureEnum, message: string | undefined) =>
      this.refuseStep(Schemas.LogAction.ReadBackEvalRecord, failure, message, metadata);

    const conversation: Schemas.EvalRunConversationResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.EvalRunConversationResponse> => {
        const running = await this.runningRun(tx, identity, params.runPublicId);
        if (!running.isSuccess || !running.run) return running;
        const found = await this.conversationsDal.getConversationDetails(tx, {
          companyId,
          publicId: request.conversationId,
        });
        if (!found.isSuccess || !found.conversation) {
          return this.stepFailure(found.isNotFound, found.message);
        }
        if (found.conversation.evalRunId !== running.run.id) {
          return this.stepFailure(true, "Conversation is not this run's");
        }
        return { isSuccess: true, conversationId: found.conversation.id };
      },
    );
    if (!conversation.isSuccess || !conversation.conversationId) {
      return refuse(
        conversation.failure ?? Schemas.EvalRunStepFailureEnum.ServerError,
        conversation.message,
      );
    }

    const planned = await this.actionEngineRepo.getEvalReadbackPlan({
      companyId,
      conversationId: conversation.conversationId,
      evalConnectionId: identity.connectionId,
      changeRequestPublicId: request.changeRequestId,
    });
    if (!planned.isSuccess || !planned.plan) {
      return refuse(
        planned.isNotFound
          ? Schemas.EvalRunStepFailureEnum.NotFound
          : Schemas.EvalRunStepFailureEnum.ServerError,
        planned.message,
      );
    }
    const { plan } = planned;
    const { readbackOp } = plan.tool.ops;
    if (plan.tool.name !== request.readback.toolName || !readbackOp) {
      return refuse(
        Schemas.EvalRunStepFailureEnum.Invalid,
        "The change request is another tool's, or its tool has no readback",
      );
    }

    const readback = await HostToolCallProvider.readAfter({
      plan,
      getHostToken: () => params.hostToken,
    });
    const check = Schemas.checkEvalReadback({
      readbackOp,
      expect: request.readback.expect,
      readback,
    });
    if (check.verdict === Schemas.EvalReadbackVerdictEnum.Unknown) {
      AppLogger.warn({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.ReadBackEvalRecord,
        message: check.reason ?? "Readback verdict unknown",
        metadata: { ...metadata, toolName: plan.tool.name, outcome: readback.outcome },
      });
    }
    return { isSuccess: true, message: "Record read back", check };
  }

  // DEV_NOTE: One graded attempt of a case of this run; a second result for the same attempt is Duplicate (append-only)
  async recordResult(params: {
    identity: Schemas.EvalIdentity;
    runPublicId: string;
    request: Schemas.RecordEvalResultApiRequest;
  }): Promise<Schemas.EvalRunStepResponse> {
    const { identity, request } = params;
    const companyId = identity.companyId;
    const metadata = { companyId, runPublicId: params.runPublicId, attempt: request.attempt };

    const result: Schemas.EvalRunStepResponse = await withTenant(this.db, companyId, async (tx) => {
      const running = await this.runningRun(tx, identity, params.runPublicId, true);
      if (!running.isSuccess || !running.run) return running;
      if (request.attempt > running.run.k) {
        return {
          isSuccess: false,
          message: "Attempt is past the run's k",
          failure: Schemas.EvalRunStepFailureEnum.Invalid,
        };
      }
      const evalCase = await this.runCase(tx, companyId, running.run, request.caseId);
      if (!evalCase.isSuccess || !evalCase.evalCaseId) return evalCase;

      const created = await this.evalRunsDal.createEvalResult(tx, {
        companyId,
        evalRunId: running.run.id,
        evalCaseId: evalCase.evalCaseId,
        attempt: request.attempt,
        hasPassed: request.hasPassed,
        graderOutput: request.graderOutput,
        latencyMs: request.latencyMs,
      });
      if (created.isConflict) {
        return {
          isSuccess: false,
          message: created.message,
          failure: Schemas.EvalRunStepFailureEnum.Duplicate,
        };
      }
      if (!created.isSuccess) return this.stepFailure(false, created.message);
      return { isSuccess: true, message: "Eval result recorded" };
    });
    if (!result.isSuccess) {
      return this.refuseStep(
        Schemas.LogAction.RecordEvalResult,
        result.failure ?? Schemas.EvalRunStepFailureEnum.ServerError,
        result.message,
        metadata,
      );
    }
    return result;
  }

  // DEV_NOTE: The staging connection's reset_op, once per run after its attempts (cases are state-independent: each
  // names its own records with {case.tag}, so attempts within a run don't need a reset between them), as the host test
  // user, under one key per run. No reset_op = nothing to put back (isReset false). A reset_op that no longer parses,
  // or a host that didn't answer 2xx, is HostFailed. Either way that went through marks the run reset (reset_at), which
  // a Done finish needs.
  async reset(params: {
    identity: Schemas.EvalIdentity;
    runPublicId: string;
    hostToken: string;
  }): Promise<Schemas.ResetEvalRunResponse> {
    const { identity } = params;
    const companyId = identity.companyId;
    const metadata = { companyId, runPublicId: params.runPublicId };
    const refuse = (failure: Schemas.EvalRunStepFailureEnum, message: string | undefined) =>
      this.refuseStep(Schemas.LogAction.ResetEvalRun, failure, message, metadata);

    const running: Schemas.EvalRunningRunResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.EvalRunningRunResponse> =>
        await this.runningRun(tx, identity, params.runPublicId),
    );
    if (!running.isSuccess || !running.run) {
      return refuse(running.failure ?? Schemas.EvalRunStepFailureEnum.ServerError, running.message);
    }
    if (identity.resetOp === null) {
      const marked = await this.markReset(companyId, running.run.id);
      if (!marked.isSuccess) return refuse(marked.failure, marked.message);
      return { isSuccess: true, message: "The connection has no reset op", isReset: false };
    }
    const op = Schemas.ZConnectionResetOp.safeParse(identity.resetOp);
    if (!op.success) {
      return refuse(
        Schemas.EvalRunStepFailureEnum.HostFailed,
        "The connection's reset op is invalid",
      );
    }

    const reset = await HostToolCallProvider.reset({
      connection: identity.connection,
      op: op.data,
      idempotencyKey: `eval-reset:${running.run.publicId}`,
      getHostToken: () => params.hostToken,
    });
    if (reset.outcome !== Schemas.HostCallOutcomeEnum.Succeeded) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.ResetEvalRun,
        message: reset.message ?? "Reset failed",
        metadata: { ...metadata, outcome: reset.outcome, httpStatus: reset.httpStatus ?? null },
      });
      return {
        isSuccess: false,
        message: "The host reset failed",
        failure: Schemas.EvalRunStepFailureEnum.HostFailed,
      };
    }
    const marked = await this.markReset(companyId, running.run.id);
    if (!marked.isSuccess) return refuse(marked.failure, marked.message);
    return { isSuccess: true, message: "Staging data reset", isReset: true };
  }

  // DEV_NOTE: reset_at on the run, only while it is still Running (a finish meanwhile is NotRunning)
  private async markReset(
    companyId: string,
    evalRunId: string,
  ): Promise<
    | { isSuccess: true }
    | { isSuccess: false; message?: string; failure: Schemas.EvalRunStepFailureEnum }
  > {
    const marked: Schemas.EvalRunDALResponse = await withTenant(this.db, companyId, async (tx) => {
      return await this.evalRunsDal.markEvalRunReset(tx, { companyId, id: evalRunId });
    });
    if (marked.isSuccess) return { isSuccess: true };
    return {
      isSuccess: false,
      message: marked.message,
      failure: marked.isNotFound
        ? Schemas.EvalRunStepFailureEnum.NotRunning
        : Schemas.EvalRunStepFailureEnum.ServerError,
    };
  }

  // DEV_NOTE: Ends a Running run (its row locked, so no result lands after the tally). isComplete: every case of the
  // run's set has all k attempts and the reset went through (else Incomplete, nothing written) → Done; otherwise
  // Failed. pass^k: a case passes when all k attempts did; the run passes when it is Done
  // and every case of the set passed (the safety hard gate on top is M5-4's). case_count = the set's size. cost_usd is
  // already the run's (every model call adds to it, ModelCallsRepo) and keeps settling after the finish.
  async finish(params: {
    identity: Schemas.EvalIdentity;
    runPublicId: string;
    request: Schemas.FinishEvalRunApiRequest;
  }): Promise<Schemas.FinishEvalRunResponse> {
    const { identity, request } = params;
    const companyId = identity.companyId;
    const metadata = { companyId, runPublicId: params.runPublicId, isComplete: request.isComplete };

    const result: Schemas.FinishEvalRunResponse = await withTenant(
      this.db,
      companyId,
      async (tx) => {
        const running = await this.runningRun(tx, identity, params.runPublicId, true);
        if (!running.isSuccess || !running.run) return running;
        const { run } = running;

        const tallied = await this.evalRunsDal.getEvalRunTallies(tx, {
          companyId,
          evalRunId: run.id,
        });
        if (!tallied.isSuccess || !tallied.tallies) return this.stepFailure(false, tallied.message);
        const caseIds = run.evalCaseIds ?? [];
        const tallies = new Map(tallied.tallies.map((tally) => [tally.evalCaseId, tally]));
        const isEveryCaseRun =
          caseIds.length > 0 &&
          caseIds.every((caseId) => (tallies.get(caseId)?.attemptCount ?? 0) >= run.k);
        if (request.isComplete && !isEveryCaseRun) {
          return {
            isSuccess: false,
            message: "Some cases haven't run all their attempts",
            failure: Schemas.EvalRunStepFailureEnum.Incomplete,
          };
        }
        if (request.isComplete && run.resetAt === null) {
          return {
            isSuccess: false,
            message: "The run's staging data wasn't reset",
            failure: Schemas.EvalRunStepFailureEnum.Incomplete,
          };
        }
        const passAllKCount = caseIds.filter(
          (caseId) => (tallies.get(caseId)?.passedAttemptCount ?? 0) >= run.k,
        ).length;

        const finished = await this.evalRunsDal.finishEvalRun(tx, {
          companyId,
          id: run.id,
          status: request.isComplete
            ? Schemas.EvalRunStatusIntEnum.Done
            : Schemas.EvalRunStatusIntEnum.Failed,
          caseCount: caseIds.length,
          passAllKCount,
          hasPassed: request.isComplete && passAllKCount === caseIds.length,
        });
        if (!finished.isSuccess || !finished.evalRun) {
          return finished.isNotFound
            ? {
                isSuccess: false,
                message: "Eval run is not running",
                failure: Schemas.EvalRunStepFailureEnum.NotRunning,
              }
            : this.stepFailure(false, finished.message);
        }
        const { evalRun } = finished;
        return {
          isSuccess: true,
          message: "Eval run finished",
          run: {
            status: evalRun.status,
            caseCount: evalRun.caseCount,
            passAllKCount: evalRun.passAllKCount,
            hasPassed: evalRun.hasPassed,
            costUsd: evalRun.costUsd,
          },
        };
      },
    );
    if (!result.isSuccess) {
      return this.refuseStep(
        Schemas.LogAction.EndEvalRun,
        result.failure ?? Schemas.EvalRunStepFailureEnum.ServerError,
        result.message,
        metadata,
      );
    }
    AppLogger.info({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.EndEvalRun,
      message: "Eval run finished",
      metadata: { ...metadata, hasPassed: result.run?.hasPassed ?? null },
    });
    return result;
  }

  // DEV_NOTE: isLocked: the run row FOR UPDATE for the rest of the step's transaction (results, attempt starts and the
  // finish take turns). The token company's run by public id, started on the token's connection (another connection's run is
  // NotFound, so one run's attempts and reset never go to two hosts), still Running, with its config's chatbot
  private async runningRun(
    tx: Tx,
    identity: Schemas.EvalIdentity,
    runPublicId: string,
    isLocked = false,
  ): Promise<Schemas.EvalRunningRunResponse> {
    const { companyId } = identity;
    const found = await this.evalRunsDal.getEvalRun(tx, {
      companyId,
      publicId: runPublicId,
      isLocked,
    });
    if (!found.isSuccess || !found.evalRun) {
      return this.stepFailure(found.isNotFound, found.message);
    }
    if (found.evalRun.companyConnectionId !== identity.connectionId) {
      return this.stepFailure(true, "Eval run is another connection's");
    }
    if (found.evalRun.status !== Schemas.EvalRunStatusIntEnum.Running) {
      return {
        isSuccess: false,
        message: "Eval run is not running",
        failure: Schemas.EvalRunStepFailureEnum.NotRunning,
      };
    }
    const config = await this.chatbotConfigsDal.getChatbotConfigDetails(tx, {
      companyId,
      id: found.evalRun.chatbotConfigId,
    });
    if (!config.isSuccess || !config.chatbotConfig) return this.stepFailure(false, config.message);
    return { isSuccess: true, run: found.evalRun, chatbotId: config.chatbotConfig.chatbotId };
  }

  // DEV_NOTE: A case of the run's set (the cases startRun handed out). Any other case is NotFound: one turned off, made
  // after the start, or another chatbot's never counts toward the run.
  private async runCase(
    tx: Tx,
    companyId: string,
    run: Pick<Schemas.EvalRun, "evalCaseIds">,
    casePublicId: string,
  ): Promise<Schemas.EvalRunCaseResponse> {
    const found = await this.evalCasesDal.getEvalCase(tx, {
      companyId,
      publicId: casePublicId,
    });
    if (!found.isSuccess || !found.evalCase)
      return this.stepFailure(found.isNotFound, found.message);
    if (!(run.evalCaseIds ?? []).includes(found.evalCase.id)) {
      return this.stepFailure(true, "Eval case is not one of the run's");
    }
    return { isSuccess: true, evalCaseId: found.evalCase.id };
  }

  // DEV_NOTE: The config's chatbot, which must be active (a paused chatbot can't be tested, as it can't answer)
  private async activeChatbot(
    tx: Tx,
    companyId: string,
    chatbotId: string,
  ): Promise<Schemas.EvalRunChatbotResponse> {
    const found = await this.chatbotsDal.getChatbotDetails(tx, { companyId, id: chatbotId });
    if (!found.isSuccess || !found.chatbot)
      return this.stepFailure(found.isNotFound, found.message);
    if (found.chatbot.status !== Schemas.ChatbotStatusIntEnum.Active) {
      return {
        isSuccess: false,
        message: "Chatbot is paused",
        failure: Schemas.EvalRunStepFailureEnum.Invalid,
      };
    }
    return { isSuccess: true, chatbot: found.chatbot };
  }

  private stepFailure(
    isNotFound: boolean | undefined,
    message: string | undefined,
  ): Schemas.EvalRunStepResponse {
    return {
      isSuccess: false,
      message,
      failure: isNotFound
        ? Schemas.EvalRunStepFailureEnum.NotFound
        : Schemas.EvalRunStepFailureEnum.ServerError,
    };
  }

  private refuseStep(
    action: Schemas.LogAction,
    failure: Schemas.EvalRunStepFailureEnum,
    message: string | undefined,
    metadata: Record<string, unknown>,
  ): { isSuccess: false; message: string; failure: Schemas.EvalRunStepFailureEnum } {
    return EvalRefusalProvider.refuse({
      action,
      failure,
      serverError: Schemas.EvalRunStepFailureEnum.ServerError,
      message: message ?? "Eval run step refused",
      metadata,
    });
  }
}
