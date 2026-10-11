import * as Schemas from "@app/schemas";

// DEV_NOTE: The change request rules ActionEngineRepo applies (M3-4), pure so they are unit-tested on their own: the
// approval deadline, the status a commit's host call ends in, the error code a refused step stores, and the widget's
// view of a row.
export default class ChangeRequestsProvider {
  // DEV_NOTE: The one approval deadline: the row's created_at + CHANGE_REQUEST_APPROVAL_EXPIRY_MS (the DO schedules
  // its expiry at the same time; the database enforces it on an approval)
  static deadline(row: Pick<Schemas.ChangeRequest, "createdAt">): number {
    return row.createdAt.getTime() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS;
  }

  static isPastDeadline(row: Pick<Schemas.ChangeRequest, "createdAt">, now: number): boolean {
    return now >= ChangeRequestsProvider.deadline(row);
  }

  // DEV_NOTE: The change request's status from how its commit's host call ended: Succeeded or AlreadyApplied →
  // Committed (verified by read-after in M3-6); Unknown → NeedsHuman; any other outcome → Failed when nothing may have
  // landed, else NeedsHuman (a token refused after a send that may have landed is never resent here: M3-8). A resume
  // that sent nothing this time (attempts 0) proves nothing about the earlier attempt, so it can't end Failed either.
  static commitEnd(
    hostCall: Schemas.FinishCommitRequest["hostCall"],
    isResume: boolean,
  ): {
    status: Schemas.ChangeRequestStatusIntEnum;
    errorCode: Schemas.ChangeRequestErrorCodeEnum | null;
  } {
    switch (hostCall.outcome) {
      case Schemas.HostCallOutcomeEnum.Succeeded:
      case Schemas.HostCallOutcomeEnum.AlreadyApplied:
        return { status: Schemas.ChangeRequestStatusIntEnum.Committed, errorCode: null };
      case Schemas.HostCallOutcomeEnum.Unknown:
        return {
          status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
          errorCode: Schemas.ChangeRequestErrorCodeEnum.HostUnknown,
        };
      case Schemas.HostCallOutcomeEnum.TokenNeeded:
      case Schemas.HostCallOutcomeEnum.TokenRejected:
      case Schemas.HostCallOutcomeEnum.Refused:
      case Schemas.HostCallOutcomeEnum.Failed: {
        const mayHaveLanded =
          hostCall.mayHaveLanded === true || (isResume && (hostCall.attempts ?? 0) === 0);
        return {
          status: mayHaveLanded
            ? Schemas.ChangeRequestStatusIntEnum.NeedsHuman
            : Schemas.ChangeRequestStatusIntEnum.Failed,
          errorCode: HOST_OUTCOME_ERROR_CODE_MAP[hostCall.outcome],
        };
      }
    }
  }

  // DEV_NOTE: What a commit refused before its host call stores as error_code
  static refusalErrorCode(
    failure: Schemas.ChangeRequestFailureEnum,
  ): Schemas.ChangeRequestErrorCodeEnum {
    switch (failure) {
      case Schemas.ChangeRequestFailureEnum.ConversationClosed:
        return Schemas.ChangeRequestErrorCodeEnum.ConversationClosed;
      case Schemas.ChangeRequestFailureEnum.ChatbotUnavailable:
        return Schemas.ChangeRequestErrorCodeEnum.ChatbotUnavailable;
      case Schemas.ChangeRequestFailureEnum.ReadOnly:
        return Schemas.ChangeRequestErrorCodeEnum.ReadOnly;
      case Schemas.ChangeRequestFailureEnum.ToolUnavailable:
        return Schemas.ChangeRequestErrorCodeEnum.ToolUnavailable;
      case Schemas.ChangeRequestFailureEnum.NotFound:
      case Schemas.ChangeRequestFailureEnum.InvalidTransition:
      case Schemas.ChangeRequestFailureEnum.ServerError:
        return Schemas.ChangeRequestErrorCodeEnum.ServerError;
    }
  }

  // DEV_NOTE: The widget's view. Without a readable payload (purged, M3-7) changes are null, and kind is known only
  // for a destructive tool.
  static toView(
    row: Schemas.ChangeRequestRow,
    payload: Schemas.ChangeRequestPayload | null,
  ): Schemas.WidgetChangeRequest {
    const kind =
      payload?.kind ??
      (row.toolRisk === Schemas.ToolDefinitionRiskIntEnum.Destructive
        ? Schemas.ChangeRequestKindEnum.Delete
        : null);
    const isProposed = row.status === Schemas.ChangeRequestStatusIntEnum.Proposed;
    return {
      publicId: row.publicId,
      toolName: row.toolName ?? "",
      kind,
      changeRequestStatus: row.status,
      changeRequestStatusLabel: Schemas.CHANGE_REQUEST_STATUS_LABEL_MAP[row.status],
      summary: row.summary,
      changes: payload?.changes ?? null,
      changeCount: row.changeCount,
      expiresAt: isProposed ? ChangeRequestsProvider.deadline(row) : null,
      isUndoable: row.isUndoable,
    };
  }
}

const HOST_OUTCOME_ERROR_CODE_MAP: Record<
  | Schemas.HostCallOutcomeEnum.TokenNeeded
  | Schemas.HostCallOutcomeEnum.TokenRejected
  | Schemas.HostCallOutcomeEnum.Refused
  | Schemas.HostCallOutcomeEnum.Failed,
  Schemas.ChangeRequestErrorCodeEnum
> = {
  [Schemas.HostCallOutcomeEnum.TokenNeeded]: Schemas.ChangeRequestErrorCodeEnum.TokenNeeded,
  [Schemas.HostCallOutcomeEnum.TokenRejected]: Schemas.ChangeRequestErrorCodeEnum.TokenRejected,
  [Schemas.HostCallOutcomeEnum.Refused]: Schemas.ChangeRequestErrorCodeEnum.HostRefused,
  [Schemas.HostCallOutcomeEnum.Failed]: Schemas.ChangeRequestErrorCodeEnum.HostFailed,
};
