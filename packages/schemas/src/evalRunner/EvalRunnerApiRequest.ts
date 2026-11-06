import { z } from "zod";
import { EvalRunTriggerIntEnum } from "../evalRuns/EvalRunsCommon";
import { DASHBOARD_EVAL_RUN_TRIGGERS, ZEvalHostLogin } from "./EvalRunnerCommon";

// DEV_NOTE: POST /dashboard/eval-runs (ADR 0007): run one version's tests on the hosted runner. The company is the
// signed-in admin's (or the acting operator's); the version is named by public id. k follows the trigger
// (DASHBOARD_EVAL_RUN_K), never the client.
// failedCasesOfRunId (ADR 0007 › Resume): a Manual run of only the cases that didn't pass every attempt in that run
// (one of the same chatbot), still active; never a Gate, which runs every case.
export const ZStartEvalRunApiRequest = z
  .strictObject({
    chatbotConfigId: z.string().trim().min(1).max(64),
    trigger: z.literal(DASHBOARD_EVAL_RUN_TRIGGERS),
    failedCasesOfRunId: z.string().trim().min(1).max(64).optional(),
  })
  .refine(
    (request) =>
      request.failedCasesOfRunId === undefined || request.trigger === EvalRunTriggerIntEnum.Manual,
    { message: "Only a manual run can run some cases", path: ["failedCasesOfRunId"] },
  );
export type StartEvalRunApiRequest = z.infer<typeof ZStartEvalRunApiRequest>;

// DEV_NOTE: PUT /operator/companies/:companyPublicId/connections/:id/eval-login: the connection's test sign-in, set or
// replaced whole (the password is never read back, so an edit sends it again)
export const ZSetEvalHostLoginApiRequest = z.strictObject({
  evalHostLogin: ZEvalHostLogin,
});
export type SetEvalHostLoginApiRequest = z.infer<typeof ZSetEvalHostLoginApiRequest>;
