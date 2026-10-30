import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import getDbClient from "@/db/dbClient";
import EvalJudgeProvider from "@/providers/evalJudge";
import EvalRefusalProvider from "@/providers/evalRefusal";
import EvalTranscriptProvider from "@/providers/evalTranscript";
import EvalHarnessRepo from "@/repositories/EvalHarnessRepo";
import EvalTranscriptsRepo from "@/repositories/EvalTranscriptsRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The pinned LLM judge on one eval attempt (M5-3), POST /eval/runs/:runId/judge. Its own Repo, so only this
// route builds the model router (and needs the request's ctx: the judge's model_calls row is written in its waitUntil).
//   1. The conversation must be one of the token company's Running run (EvalHarnessRepo.getRunConversationSource, else
//      NotFound), which also gives the run config's routing and pins.
//   2. The attempt is read from its DO (EvalTranscriptsRepo.read), never taken from the harness, and graded on the
//      judge's view (EvalTranscriptProvider.judgeView: every tool call, the last reply whole, held to the model-safe
//      budget).
//   3. The judge is the pinned model (Schemas.EVAL_JUDGE_MODELS) of the run config's default tier's provider, never a
//      model of the config under test, called through the model router: the company's key, the company budget (no
//      per-user caps: an eval has none), the run's id (its cost adds to the run), the attempt's conversation.
// Any router, provider or answer failure is JudgeUnavailable (503): the harness stops the run on it, so a case with a
// rubric never passes ungraded. Transcript, rubric and answer stay out of every log.
export default class EvalJudgeRepo {
  private evalHarnessRepo: EvalHarnessRepo;
  private evalTranscriptsRepo: EvalTranscriptsRepo;
  private modelRouterRepo: ModelRouterRepo;

  constructor(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
    const db: NodePgDatabase = getDbClient(env);
    this.evalHarnessRepo = new EvalHarnessRepo(env, db);
    this.evalTranscriptsRepo = new EvalTranscriptsRepo(env, db);
    this.modelRouterRepo = new ModelRouterRepo(env, ctx);
  }

  async judge(params: {
    identity: Schemas.EvalIdentity;
    runPublicId: string;
    request: Schemas.EvalJudgeApiRequest;
  }): Promise<Schemas.EvalJudgeResponse> {
    const { identity, request } = params;
    const companyId = identity.companyId;
    const metadata = { companyId, runPublicId: params.runPublicId };
    const refuse = (failure: Schemas.EvalRunStepFailureEnum, message: string | undefined) =>
      EvalRefusalProvider.refuse({
        action: Schemas.LogAction.JudgeEvalAttempt,
        failure,
        serverError: Schemas.EvalRunStepFailureEnum.ServerError,
        message,
        metadata,
      });

    const found = await this.evalHarnessRepo.getRunConversationSource({
      identity,
      runPublicId: params.runPublicId,
      conversationPublicId: request.conversationId,
    });
    if (!found.isSuccess || !found.source) {
      return refuse(found.failure ?? Schemas.EvalRunStepFailureEnum.ServerError, found.message);
    }
    const { source } = found;

    const read = await this.evalTranscriptsRepo.read({ companyId, source });
    if (!read.isSuccess || !read.record) {
      return refuse(read.failure ?? Schemas.EvalRunStepFailureEnum.ServerError, read.message);
    }

    const { provider } = source.routing[source.routing.defaultTier];
    const pinned = { provider, model: Schemas.EVAL_JUDGE_MODELS[provider] };
    const routed = await this.modelRouterRepo.getModel({
      companyId,
      chatbotId: source.chatbotId,
      chatbotUserId: null,
      conversationId: source.conversationId,
      evalRunId: source.evalRunId,
      turnId: null,
      taskType: Schemas.ModelTaskTypeEnum.EvalJudge,
      tier: Schemas.ModelTierEnum.Top,
      routing: {
        small: pinned,
        mid: pinned,
        top: pinned,
        defaultTier: Schemas.ModelTierEnum.Top,
      },
      caps: null,
    });
    if (!routed.isSuccess) {
      return refuse(
        Schemas.EvalRunStepFailureEnum.JudgeUnavailable,
        `The judge (${pinned.model}) couldn't be reached: ${routed.failure}`,
      );
    }
    const judged = await EvalJudgeProvider.judge(
      routed.model,
      { transcript: EvalTranscriptProvider.judgeView(read.record), rubric: request.rubric },
      { ...metadata, provider, model: pinned.model },
    );
    if (!judged.isSuccess) {
      return refuse(
        Schemas.EvalRunStepFailureEnum.JudgeUnavailable,
        `${judged.message} (${pinned.model})`,
      );
    }
    return {
      isSuccess: true,
      message: "Attempt judged",
      verdict: {
        hasPassed: judged.verdict.hasPassed,
        reason: judged.verdict.reason,
        provider,
        model: pinned.model,
        promptVersion: Schemas.EVAL_JUDGE_PROMPT_VERSION,
      },
    };
  }
}
