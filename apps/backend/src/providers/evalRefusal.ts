import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: An eval refusal (M5-2), logged once where it is decided: a server error as an error, anything else (a bad
// token, a run that isn't Running, a case not in the run) as a warning. Shared by EvalAuthRepo (EvalAuthFailureEnum)
// and EvalHarnessRepo (EvalRunStepFailureEnum); serverError names the failure that is the server's own. The message
// is the refusal's, never case text, host data or the token.
export default class EvalRefusalProvider {
  static refuse<F extends string>(params: {
    action: Schemas.LogAction;
    failure: F;
    serverError: F;
    message: string | undefined;
    metadata?: Record<string, unknown>;
  }): { isSuccess: false; message: string; failure: F } {
    const entry = {
      category: Schemas.LogCategory.Eval,
      action: params.action,
      message: params.message ?? "Eval request refused",
      metadata: { ...params.metadata, failure: params.failure },
    };
    if (params.failure === params.serverError) {
      AppLogger.error(entry);
    } else {
      AppLogger.warn(entry);
    }
    return { isSuccess: false, message: entry.message, failure: params.failure };
  }
}
