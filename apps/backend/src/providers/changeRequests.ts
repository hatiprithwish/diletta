import * as Schemas from "@app/schemas";

// DEV_NOTE: The change request rules ActionEngineRepo applies (M3-4), pure so they are unit-tested on their own: the
// approval deadline, the status a commit's host call ends in, the status its read-after and auto-undo end in (M3-6),
// the error code a refused step stores, and the widget's view of a row.
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
  // Committed (then read back: verifyEnd); Unknown → NeedsHuman; any other outcome → Failed when nothing may have
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

  // DEV_NOTE: The read-after's end (Schemas.checkReadAfter, step Commit): the record shows the change → Verified; it
  // shows something else → Mismatch (then auto-undone: undoStart); the read couldn't tell → NeedsHuman, never an
  // undo on a guess. (A read that couldn't even be sent for want of the token is the DO's to wait on, never here.)
  static verifyEnd(check: Schemas.ChangeRequestReadAfterCheck): {
    status: Schemas.ChangeRequestStatusIntEnum;
    errorCode: Schemas.ChangeRequestErrorCodeEnum | null;
  } {
    switch (check.verdict) {
      case Schemas.ChangeRequestCheckVerdictEnum.Matches:
        return { status: Schemas.ChangeRequestStatusIntEnum.Verified, errorCode: null };
      case Schemas.ChangeRequestCheckVerdictEnum.Differs:
        return { status: Schemas.ChangeRequestStatusIntEnum.Mismatch, errorCode: null };
      case Schemas.ChangeRequestCheckVerdictEnum.Unknown:
        return {
          status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
          errorCode: Schemas.ChangeRequestErrorCodeEnum.VerifyUnknown,
        };
    }
  }

  // DEV_NOTE: The auto-undo's end: its host call succeeded (or an Emulated check proved it already landed) and the
  // record reads back as before → Undone; it succeeded but doesn't read back so → NeedsHuman undo_unconfirmed; it
  // didn't succeed → NeedsHuman undo_failed (the commit landed, so a person must look, whatever the undo did)
  static undoEnd(
    undo: Schemas.FinishUndoRequest["undo"],
    check: Schemas.ChangeRequestReadAfterCheck | null,
  ): {
    status: Schemas.ChangeRequestStatusIntEnum;
    errorCode: Schemas.ChangeRequestErrorCodeEnum | null;
  } {
    const isSent =
      undo.outcome === Schemas.HostCallOutcomeEnum.Succeeded ||
      undo.outcome === Schemas.HostCallOutcomeEnum.AlreadyApplied;
    if (!isSent) {
      return {
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
      };
    }
    if (check?.verdict === Schemas.ChangeRequestCheckVerdictEnum.Matches) {
      return { status: Schemas.ChangeRequestStatusIntEnum.Undone, errorCode: null };
    }
    return {
      status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
      errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoUnconfirmed,
    };
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
      case Schemas.ChangeRequestFailureEnum.PastDeadline:
      case Schemas.ChangeRequestFailureEnum.InvalidEdit:
      case Schemas.ChangeRequestFailureEnum.NoChange:
      case Schemas.ChangeRequestFailureEnum.ServerError:
        return Schemas.ChangeRequestErrorCodeEnum.ServerError;
    }
  }

  // DEV_NOTE: The widget's view. Without a readable payload (purged, M3-7) changes are null, and kind is known only
  // for a destructive tool. editableFields (M3-5) count only while Proposed. toolCallId is the DO's to fill (it holds
  // the open entries by Think tool call id).
  static toView(
    row: Schemas.ChangeRequestRow,
    payload: Schemas.ChangeRequestPayload | null,
    editableFields: Schemas.ChangeRequestEditableField[] = [],
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
      toolCallId: null,
      kind,
      changeRequestStatus: row.status,
      changeRequestStatusLabel: Schemas.CHANGE_REQUEST_STATUS_LABEL_MAP[row.status],
      summary: row.summary,
      changes: payload?.changes ?? null,
      changeCount: row.changeCount,
      expiresAt: isProposed ? ChangeRequestsProvider.deadline(row) : null,
      isUndoable: row.isUndoable,
      wasEdited: row.wasEdited,
      editableFields: isProposed && payload ? editableFields : [],
      mismatches: payload?.mismatches ?? null,
    };
  }

  // DEV_NOTE: A Proposed change request's editable fields (M3-5), from its tool's ops and its payload's kind
  static editableFields(
    tool: Schemas.RuntimeTool,
    payload: Schemas.ChangeRequestPayload,
  ): Schemas.ChangeRequestEditableField[] {
    return Schemas.getEditableFields({
      kind: payload.kind,
      callOp: tool.ops.callOp,
      inputSchema: tool.ops.inputSchema,
    });
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
