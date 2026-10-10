import * as Schemas from "@app/schemas";

// DEV_NOTE: What a failed connect means (pure). After RESUME_FAILURES refused upgrades the saved conversation is
// dropped (closed, or not this user's any more); a failed getToken never drops it. After UNAVAILABLE_FAILURES failures
// of either kind the widget shows its unavailable state and stops trying until the visitor retries.
export const RESUME_FAILURES = 2;
export const UNAVAILABLE_FAILURES = 5;

export const NO_CONNECT_FAILURES: Schemas.WidgetConnectFailures = { refused: 0, failed: 0 };

export function nextConnectFailure(params: {
  failures: Schemas.WidgetConnectFailures;
  kind: Schemas.WidgetConnectFailureKindEnum;
  hasConversation: boolean;
}): Schemas.WidgetConnectFailureDecision {
  const isRefused = params.kind === Schemas.WidgetConnectFailureKindEnum.Refused;
  const failures = {
    refused: params.failures.refused + (isRefused ? 1 : 0),
    failed: params.failures.failed + 1,
  };
  if (failures.failed >= UNAVAILABLE_FAILURES) {
    return {
      failures: NO_CONNECT_FAILURES,
      action: Schemas.WidgetConnectFailureActionEnum.Unavailable,
    };
  }
  if (isRefused && params.hasConversation && failures.refused >= RESUME_FAILURES) {
    return {
      failures: NO_CONNECT_FAILURES,
      action: Schemas.WidgetConnectFailureActionEnum.DropConversation,
    };
  }
  return { failures, action: Schemas.WidgetConnectFailureActionEnum.None };
}
