import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import EvalTranscriptsRepo from "@/repositories/EvalTranscriptsRepo";

// DEV_NOTE: Every hour (M5-3): remove eval transcripts whose result was never written (files rows still pending their
// owner after Constants.EVAL_TRANSCRIPT_PENDING_MAX_AGE_MS) with their R2 objects. Goes through EvalTranscriptsRepo,
// never a DAL (pattern rule 1.1). Failures are logged by the DAL or the storage provider; a missed hour only leaves an
// unused object an hour longer.
export default async function runEvalTranscriptSweep(env: Env): Promise<void> {
  const swept = await new EvalTranscriptsRepo(env).sweepPending();
  if (!swept.isSuccess || swept.sweptCount) {
    const entry = {
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.SweepEvalTranscripts,
      message: swept.message ?? "Pending eval transcripts swept",
      metadata: { sweptCount: swept.sweptCount ?? 0 },
    };
    if (swept.isSuccess) {
      AppLogger.info(entry);
    } else {
      AppLogger.error(entry);
    }
  }
}
