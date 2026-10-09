import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Starts one KnowledgeSyncWorkflow instance (M2-5). The instance id names the source and a fresh ULID, so
// every sync is its own instance (ids are unique per workflow) and sorts by start time in the dashboard. Called only
// after the Repo has claimed the source (status Syncing), so two instances never run for one source. Returns
// { isSuccess, message } and never throws.
export default class KnowledgeSyncWorkflowProvider {
  static async start(
    env: Env,
    params: Schemas.KnowledgeSyncWorkflowParams,
  ): Promise<Schemas.ApiResponse> {
    try {
      await env.KNOWLEDGE_SYNC_WORKFLOW.create({
        id: `ks-${params.knowledgeSourcePublicId}-${Utility.generateUlid()}`,
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
