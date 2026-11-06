import { z } from "zod";
import { DASHBOARD_EVAL_RUN_TRIGGERS, ZEvalHostLogin } from "./EvalRunnerCommon";

// DEV_NOTE: POST /dashboard/eval-runs (ADR 0007): run one version's tests on the hosted runner. The company is the
// signed-in admin's (or the acting operator's); the version is named by public id. k follows the trigger
// (DASHBOARD_EVAL_RUN_K), never the client.
export const ZStartEvalRunApiRequest = z.strictObject({
  chatbotConfigId: z.string().trim().min(1).max(64),
  trigger: z.literal(DASHBOARD_EVAL_RUN_TRIGGERS),
});
export type StartEvalRunApiRequest = z.infer<typeof ZStartEvalRunApiRequest>;

// DEV_NOTE: PUT /operator/companies/:companyPublicId/connections/:id/eval-login: the connection's test sign-in, set or
// replaced whole (the password is never read back, so an edit sends it again)
export const ZSetEvalHostLoginApiRequest = z.strictObject({
  evalHostLogin: ZEvalHostLogin,
});
export type SetEvalHostLoginApiRequest = z.infer<typeof ZSetEvalHostLoginApiRequest>;
