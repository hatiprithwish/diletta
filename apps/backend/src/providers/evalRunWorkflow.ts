import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: M7-9 (ADR 0007). Starts the first EvalRunWorkflow instance of a run's chain on the hosted runner
// (apps/eval-runner, a Python Worker; EVAL_RUN_WORKFLOW binds its Workflow by script name) for a run the dashboard
// queued. The instance id is the run's public id (<run>-r<n> for its n-th resume), so a run, or a resume, is started
// once; its params are public ids and the resume count only (instance params are persisted). Called only after
// EvalRunnerRepo committed the Queued run. Returns { isSuccess, message } and never throws.
export default class EvalRunWorkflowProvider {
  static async start(
    env: Env,
    params: Schemas.EvalRunWorkflowStartParams,
  ): Promise<Schemas.ApiResponse> {
    // DEV_NOTE: Bound in staging and production only (wrangler.jsonc): a local worker has no runner
    if (!env.EVAL_RUN_WORKFLOW) {
      AppLogger.warn({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.StartEvalRunWorkflow,
        message: "No eval runner bound in this environment",
        metadata: params,
      });
      return { isSuccess: false, message: "No eval runner in this environment" };
    }
    try {
      const id =
        params.resumedCount > 0
          ? `${params.runPublicId}-r${params.resumedCount}`
          : params.runPublicId;
      await env.EVAL_RUN_WORKFLOW.create({ id, params });
      return { isSuccess: true, message: "Eval run handed to the runner" };
    } catch (error) {
      const message = "Unknown error in starting the eval runner";
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.StartEvalRunWorkflow,
        message,
        error,
        metadata: params,
      });
      return { isSuccess: false, message };
    }
  }
}
