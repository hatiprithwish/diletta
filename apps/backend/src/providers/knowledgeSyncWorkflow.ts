import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Starts one KnowledgeSyncWorkflow instance (M2-5) under the id the claim stored on the source
// (params.syncRunId: the source and a fresh ULID, so every sync is its own instance and sorts by start time). Called
// only after KnowledgeSourcesRepo claimed the source; a run whose id the source no longer holds writes nothing and
// stops, so at most one run ever works on a source. Returns { isSuccess, message } and never throws.
export default class KnowledgeSyncWorkflowProvider {
  static async start(
    env: Env,
    params: Schemas.KnowledgeSyncWorkflowParams,
  ): Promise<Schemas.ApiResponse> {
    try {
      await env.KNOWLEDGE_SYNC_WORKFLOW.create({
        id: params.syncRunId,
        params,
      });
      return { isSuccess: true, message: "Knowledge sync started" };
    } catch (error) {
      const message = "Unknown error in starting knowledge sync";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.StartKnowledgeSync,
        message,
        error,
        metadata: params,
      });
      return { isSuccess: false, message };
    }
  }
}
