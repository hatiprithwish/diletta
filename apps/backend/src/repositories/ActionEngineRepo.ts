import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import ToolCallsDAL from "@/data-access-layer/ToolCallsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ChangeRequestsProvider from "@/providers/changeRequests";
import CompanyKeyProvider from "@/providers/companyKey";
import ConversationCheckProvider from "@/providers/conversationCheck";
import CriticalEventProvider from "@/providers/criticalEvent";
import HostToolsProvider from "@/providers/hostTools";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The action engine's database side (M3-4): host tool calls and the change requests of writes, from the
// Conversation DO. Every internal id comes from the DO's verified session; the widget names a change request only by
// its public id, and only one of this very conversation matches. Statuses are re-checked on every step, never only at
// connect (rule 3.23): the conversation open, the company and chatbot active, and for anything that writes to the host
// the company not read-only (is_read_only: the agent may only read).
//
// Values: args and the change payload (args, read-before response, diff) are encrypted here, before the DAL, under the
// company key (CompanyKeyProvider), and decrypted only for the DO (the commit, the user's own widget). Never in a log.
//
// Timeline: every change request status change writes its critical event (change_request.<action>) in the same
// transaction (CriticalEventProvider), under the conversation's root log; the DO relays outboxIds after the commit.
// A status change matches the statuses it may start from (the row is locked first), so a step that lost a race to
// another (an approval and the expiry) changes nothing and answers InvalidTransition with the row as it stands. Every
// refused step names a failure: a rolled-back transaction (TenantRollbackError, a lost connection) is ServerError, so
// the DO can tell "try again" from "this is settled".
export default class ActionEngineRepo {
  private db: NodePgDatabase;
  private env: Env;
  private toolDefinitionsDal: ToolDefinitionsDAL;
  private toolCallsDal: ToolCallsDAL;
  private changeRequestsDal: ChangeRequestsDAL;
  private conversationsDal: ConversationsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.toolDefinitionsDal = new ToolDefinitionsDAL();
    this.toolCallsDal = new ToolCallsDAL();
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.conversationsDal = new ConversationsDAL();
  }

  // DEV_NOTE: The config's exact {name, version} pins, as the turn will run them. A pin whose version is not Active,
  // whose connection can't serve calls, whose ops don't load or fit its risk, or whose input_schema can't be checked is
  // left out of the turn and logged (the bot answers without it; M4-10 keeps a published config from pinning one). A
  // read-only company (isReadOnly) gets its read tools only.
  async loadTurnTools(
    params: Schemas.LoadTurnToolsRequest,
  ): Promise<Schemas.LoadTurnToolsResponse> {
    const { session, pins } = params;
    if (pins.length === 0) {
      return { isSuccess: true, message: "No tools pinned", tools: [], skippedCount: 0 };
    }

    return await withTenant(this.db, session.companyId, async (tx) => {
      const found = await this.toolDefinitionsDal.getPinnedToolDefinitions(tx, {
        companyId: session.companyId,
        pins,
      });
      if (!found.isSuccess || !found.toolDefinitions) {
        return { isSuccess: false, message: found.message };
      }

      const tools: Schemas.RuntimeTool[] = [];
      let skippedCount = 0;
      for (const pin of pins) {
        const row = found.toolDefinitions.find(
          (candidate) => candidate.name === pin.name && candidate.version === pin.version,
        );
        const loaded = row
          ? HostToolsProvider.toRuntimeTool(row)
          : { tool: null, reason: "Pinned version not found" };
        if (loaded.tool) {
          if (!params.isReadOnly || loaded.tool.risk === Schemas.ToolDefinitionRiskIntEnum.Read) {
            tools.push(loaded.tool);
          }
          continue;
        }
        skippedCount += 1;
        AppLogger.warn({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.LoadTurnTools,
          message: `Pinned tool left out of the turn: ${loaded.reason}`,
          metadata: {
            companyId: session.companyId,
            chatbotId: session.chatbotId,
            toolName: pin.name,
            toolVersion: pin.version,
          },
        });
      }
      return { isSuccess: true, message: "Turn tools loaded", tools, skippedCount };
    });
  }

  // DEV_NOTE: A tool call that proposed nothing: a read (Ok or Error), a call refused before it ran (invalid args, the
  // loop guard, a blocked or read-only tool), or a write that changes nothing. args null = never valid, not stored.
  async recordToolCall(
    params: Schemas.RecordToolCallRequest,
  ): Promise<Schemas.RecordToolCallResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const encrypted = params.args
        ? await this.encrypt(
            tx,
            session.companyId,
            Schemas.EncryptedColumnEnum.ToolCallArgs,
            params.args,
          )
        : null;
      if (params.args && !encrypted) {
        return { isSuccess: false, message: "Tool call args not encrypted" };
      }
      const created = await this.toolCallsDal.createToolCall(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        turnId: params.turnId,
        toolId: params.tool.id,
        toolVersion: params.tool.version,
        encryptedArgs: encrypted?.encryptedValue.ciphertext ?? null,
        iv: encrypted?.encryptedValue.iv ?? null,
        encryptionKeyVersion: encrypted?.encryptionKeyVersion ?? null,
        hasUntrustedContext: params.hasUntrustedContext,
        status: params.status,
        errorCode: params.errorCode,
        latencyMs: params.latencyMs,
      });
      return { isSuccess: created.isSuccess, message: created.message };
    });
  }

  // DEV_NOTE: A write's proposal, in one transaction: its tool call (args encrypted), the change request (payload
  // encrypted; Proposed, or Approved when no approval is needed) and its events. Anything failing rolls all of it back.
  // Its approval deadline is the row's created_at + CHANGE_REQUEST_APPROVAL_EXPIRY_MS (the view's expiresAt).
  async proposeChange(
    params: Schemas.ProposeChangeRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session, tool } = params;
    return await this.step(session, async (tx) => {
      const checked = await this.checkConversation(tx, session, true);
      if (!checked.isSuccess) {
        return { isSuccess: false, message: checked.message, failure: checked.failure };
      }

      const encryptedArgs = await this.encrypt(
        tx,
        session.companyId,
        Schemas.EncryptedColumnEnum.ToolCallArgs,
        params.args,
      );
      // DEV_NOTE: Args and the read-before response are parsed JSON already; a value that isn't JSON fails the proposal
      const parsedPayload = Schemas.ZChangeRequestPayload.safeParse({
        version: 1,
        kind: params.kind,
        args: params.args,
        before: params.before ?? null,
        changes: params.changes,
      });
      if (!parsedPayload.success) {
        return {
          isSuccess: false,
          message: "Change request payload is not JSON",
          failure: Schemas.ChangeRequestFailureEnum.ServerError,
        };
      }
      const payload = parsedPayload.data;
      const encryptedPayload = await this.encrypt(
        tx,
        session.companyId,
        Schemas.EncryptedColumnEnum.ChangeRequestChanges,
        payload,
      );
      if (!encryptedArgs || !encryptedPayload) {
        throw new TenantRollbackError("Change request values not encrypted");
      }

      const toolCall = await this.toolCallsDal.createToolCall(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        turnId: params.turnId,
        toolId: tool.id,
        toolVersion: tool.version,
        encryptedArgs: encryptedArgs.encryptedValue.ciphertext,
        iv: encryptedArgs.encryptedValue.iv,
        encryptionKeyVersion: encryptedArgs.encryptionKeyVersion,
        hasUntrustedContext: params.hasUntrustedContext,
        status: Schemas.ToolCallStatusIntEnum.Ok,
        errorCode: null,
        latencyMs: params.latencyMs,
      });
      if (!toolCall.isSuccess || !toolCall.toolCall) {
        throw new TenantRollbackError(toolCall.message ?? "Tool call not recorded");
      }

      const changeCount = Schemas.countChangedFields(params.changes);
      const status = params.isApprovalRequired
        ? Schemas.ChangeRequestStatusIntEnum.Proposed
        : Schemas.ChangeRequestStatusIntEnum.Approved;
      const created = await this.changeRequestsDal.createChangeRequest(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        toolCallId: toolCall.toolCall.id,
        status,
        encryptedChanges: encryptedPayload.encryptedValue.ciphertext,
        iv: encryptedPayload.encryptedValue.iv,
        encryptionKeyVersion: encryptedPayload.encryptionKeyVersion,
        summary: Schemas.buildChangeRequestSummary(tool.name, params.kind, changeCount),
        changeCount,
      });
      if (!created.isSuccess || !created.changeRequest) {
        throw new TenantRollbackError(created.message ?? "Change request not created");
      }
      const changeRequest = created.changeRequest;

      const outboxIds: string[] = [];
      const statuses = params.isApprovalRequired
        ? [Schemas.ChangeRequestStatusIntEnum.Proposed]
        : [
            Schemas.ChangeRequestStatusIntEnum.Proposed,
            Schemas.ChangeRequestStatusIntEnum.Approved,
          ];
      for (const eventStatus of statuses) {
        outboxIds.push(
          await this.recordEvent(tx, {
            session,
            changeRequest,
            rootLogId: checked.rootLogId,
            status: eventStatus,
            actorType: Schemas.ActivityLogActorTypeIntEnum.System,
            detail: {
              toolCallId: toolCall.toolCall.id,
              toolId: tool.id,
              toolVersion: tool.version,
              hasUntrustedContext: params.hasUntrustedContext,
              isAutomatic: !params.isApprovalRequired,
            },
          }),
        );
      }

      return {
        isSuccess: true,
        message: "Change proposed",
        outboxIds,
        changeRequest: ChangeRequestsProvider.toView(
          {
            ...changeRequest,
            toolId: tool.id,
            toolVersion: tool.version,
            turnId: params.turnId,
            toolName: tool.name,
            toolRisk: tool.risk,
            isUndoable: tool.ops.inverseOp !== null,
          },
          payload,
        ),
      };
    });
  }

  // DEV_NOTE: The user's answer (Approve → Approved, Reject → Rejected) or the expiry (→ Expired), only from Proposed.
  // An approval re-checks everything a commit needs, and must come before the deadline (created_at +
  // CHANGE_REQUEST_APPROVAL_EXPIRY_MS): one after it ends the proposal Expired instead (by the system), whatever the
  // widget still showed. A rejection or an expiry ends the proposal whatever else changed.
  async decideChangeRequest(
    params: Schemas.DecideChangeRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session } = params;
    const isApprove =
      params.decision === Schemas.ChangeRequestDecisionEnum.Approve && !params.isExpired;

    return await this.step(session, async (tx) => {
      let rootLogId: string | null;
      if (isApprove) {
        const checked = await this.checkConversation(tx, session, true);
        if (!checked.isSuccess) {
          return { isSuccess: false, message: checked.message, failure: checked.failure };
        }
        rootLogId = checked.rootLogId;
      } else {
        rootLogId = await this.findRootLogId(tx, session);
      }

      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.Proposed) {
        return await this.refuseTransition(tx, row);
      }

      const isExpired =
        params.isExpired || (isApprove && ChangeRequestsProvider.isPastDeadline(row, Date.now()));
      const status = isExpired
        ? Schemas.ChangeRequestStatusIntEnum.Expired
        : isApprove
          ? Schemas.ChangeRequestStatusIntEnum.Approved
          : Schemas.ChangeRequestStatusIntEnum.Rejected;
      const updated = await this.changeRequestsDal.updateChangeRequestStatus(tx, {
        companyId: session.companyId,
        id: row.id,
        status,
        fromStatuses: [Schemas.ChangeRequestStatusIntEnum.Proposed],
      });
      if (!updated.isSuccess || !updated.changeRequest) {
        throw new TenantRollbackError(updated.message ?? "Change request not updated");
      }
      const outboxId = await this.recordEvent(tx, {
        session,
        changeRequest: updated.changeRequest,
        rootLogId,
        status,
        actorType: isExpired
          ? Schemas.ActivityLogActorTypeIntEnum.System
          : Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
        detail: { toolCallId: row.toolCallId },
      });

      const next = { ...row, ...updated.changeRequest };
      return {
        isSuccess: true,
        message: isExpired && !params.isExpired ? "Approval came after the deadline" : "Decided",
        outboxIds: [outboxId],
        changeRequest: ChangeRequestsProvider.toView(next, await this.decryptPayload(tx, next)),
      };
    });
  }

  // DEV_NOTE: Approved → Committing (the commit's key stored), or a Committing one again (an eviction or a failed write
  // cut its commit: isResume, since that attempt may have reached the host). The tool version is read again by its id
  // and must still be Active on an Active connection; if it isn't, the change request ends Failed (nothing was sent)
  // or, on a resume, NeedsHuman (something may have been). Each attempt's committing event is its own (attemptId).
  async startCommit(params: Schemas.StartCommitRequest): Promise<Schemas.StartCommitResponse> {
    const { session } = params;
    return await this.step(session, async (tx): Promise<Schemas.StartCommitResponse> => {
      const checked = await this.checkConversation(tx, session, true);
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const isResume = row.status === Schemas.ChangeRequestStatusIntEnum.Committing;
      if (!isResume && row.status !== Schemas.ChangeRequestStatusIntEnum.Approved) {
        return await this.refuseTransition(tx, row);
      }
      if (!checked.isSuccess && checked.failure === Schemas.ChangeRequestFailureEnum.ServerError) {
        return { isSuccess: false, message: checked.message, failure: checked.failure };
      }
      const rootLogId = checked.isSuccess
        ? checked.rootLogId
        : await this.findRootLogId(tx, session);

      const toolRow = await this.toolDefinitionsDal.getToolDefinitionById(tx, {
        companyId: session.companyId,
        id: row.toolId,
      });
      if (!toolRow.isSuccess && !toolRow.isNotFound) {
        return {
          isSuccess: false,
          message: toolRow.message,
          failure: Schemas.ChangeRequestFailureEnum.ServerError,
        };
      }
      const runtime = toolRow.toolDefinition
        ? HostToolsProvider.toRuntimeTool(toolRow.toolDefinition)
        : { tool: null, reason: "Tool definition not found" };
      const payload = await this.decryptPayload(tx, row);

      // DEV_NOTE: The step can't go on: end the change request here, in this transaction
      if (!checked.isSuccess || !runtime.tool || !payload) {
        const failure = !checked.isSuccess
          ? checked.failure
          : !runtime.tool
            ? Schemas.ChangeRequestFailureEnum.ToolUnavailable
            : Schemas.ChangeRequestFailureEnum.ServerError;
        const errorCode =
          checked.isSuccess && runtime.tool && !payload
            ? Schemas.ChangeRequestErrorCodeEnum.PayloadUnreadable
            : ChangeRequestsProvider.refusalErrorCode(failure);
        const ended = await this.moveStatus(tx, {
          session,
          row,
          rootLogId,
          status: isResume
            ? Schemas.ChangeRequestStatusIntEnum.NeedsHuman
            : Schemas.ChangeRequestStatusIntEnum.Failed,
          errorCode,
          detail: { reason: errorCode },
        });
        AppLogger.warn({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.CommitChangeRequest,
          message: `Commit not started: ${checked.isSuccess ? (runtime.reason ?? "payload unreadable") : checked.message}`,
          metadata: { companyId: session.companyId, changeRequestPublicId: row.publicId, isResume },
        });
        return {
          isSuccess: false,
          message: "Commit not started",
          failure,
          outboxIds: ended.outboxIds,
          changeRequest: ChangeRequestsProvider.toView(ended.row, payload),
        };
      }

      const idempotencyKey = Schemas.changeRequestCommitIdempotencyKey(row.publicId);
      const started = await this.moveStatus(tx, {
        session,
        row,
        rootLogId,
        status: Schemas.ChangeRequestStatusIntEnum.Committing,
        idempotencyKey,
        detail: { isResume },
        dedupeParts: isResume ? [`resume-${params.attemptId}`] : [],
      });

      return {
        isSuccess: true,
        message: isResume ? "Commit resumed" : "Commit started",
        outboxIds: started.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(started.row, payload),
        plan: {
          changeRequestPublicId: row.publicId,
          tool: runtime.tool,
          payload,
          idempotencyKey,
          isResume,
        },
      };
    });
  }

  // DEV_NOTE: Committing → the commit's end, from the host call (@app/adapter): ChangeRequestsProvider.commitEnd
  async finishCommit(
    params: Schemas.FinishCommitRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session, hostCall } = params;
    return await this.step(session, async (tx) => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.Committing) {
        return await this.refuseTransition(tx, row);
      }

      const ended = ChangeRequestsProvider.commitEnd(hostCall, params.isResume);
      const moved = await this.moveStatus(tx, {
        session,
        row,
        rootLogId: await this.findRootLogId(tx, session),
        status: ended.status,
        errorCode: ended.errorCode,
        detail: { outcome: hostCall.outcome, mayHaveLanded: hostCall.mayHaveLanded === true },
      });
      return {
        isSuccess: true,
        message: "Commit finished",
        outboxIds: moved.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(
          moved.row,
          await this.decryptPayload(tx, moved.row),
        ),
      };
    });
  }

  async setExecutionId(params: Schemas.SetExecutionIdRequest): Promise<Schemas.ApiResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const updated = await this.changeRequestsDal.setChangeRequestExecutionId(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        publicId: params.changeRequestPublicId,
        thinkExecutionId: params.thinkExecutionId,
      });
      return {
        isSuccess: updated.isSuccess,
        isNotFound: updated.isNotFound,
        message: updated.message,
      };
    });
  }

  // DEV_NOTE: The widget's views of some of this conversation's change requests (values decrypted: the user's own
  // widget only), oldest first, each key version unwrapped once. One whose payload can't be read is sent without its
  // changes.
  async getChangeRequestViews(
    params: Schemas.GetChangeRequestViewsRequest,
  ): Promise<Schemas.ChangeRequestViewsResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const listed = await this.changeRequestsDal.listConversationChangeRequests(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        publicIds: params.changeRequestPublicIds,
      });
      if (!listed.isSuccess || !listed.changeRequests) {
        return { isSuccess: false, message: listed.message };
      }
      const payloads = await this.decryptPayloads(tx, session.companyId, listed.changeRequests);
      const changeRequests = listed.changeRequests.map((row, index) =>
        ChangeRequestsProvider.toView(row, payloads[index] ?? null),
      );
      return { isSuccess: true, message: "Change requests fetched", changeRequests };
    });
  }

  // DEV_NOTE: One change request step in withTenant. A refusal always names its failure: a rolled-back transaction
  // (TenantRollbackError, a lost connection) comes back from withTenant without one, and is a ServerError (try again),
  // never mistaken for a settled change request.
  private async step<T extends Schemas.ChangeRequestStepResponse>(
    session: Schemas.ConversationSession,
    callback: (tx: NodePgTransaction<EmptyRelations>) => Promise<T>,
  ): Promise<T | Schemas.ChangeRequestStepResponse> {
    const result: T | Schemas.ChangeRequestStepResponse = await withTenant(
      this.db,
      session.companyId,
      callback,
    );
    if (result.isSuccess || ("failure" in result && result.failure)) return result;
    return { ...result, failure: Schemas.ChangeRequestFailureEnum.ServerError };
  }

  // DEV_NOTE: The conversation open, its company and chatbot active (ConversationCheckProvider) and, for a host write,
  // the company not read-only; re-checked on every step. A conversation missing from the company reads as closed.
  private async checkConversation(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
    isHostWrite: boolean,
  ): Promise<Schemas.ChangeRequestConversationCheck> {
    const checked = await ConversationCheckProvider.check(tx, session);
    if (!checked.isSuccess) {
      return {
        isSuccess: false,
        failure: CHANGE_REQUEST_CHECK_FAILURE_MAP[checked.failure],
        message: checked.message,
      };
    }
    if (isHostWrite && checked.company.isReadOnly) {
      return {
        isSuccess: false,
        failure: Schemas.ChangeRequestFailureEnum.ReadOnly,
        message: "Company is read-only",
      };
    }
    return {
      isSuccess: true,
      rootLogId: checked.conversation.rootLogId,
      isReadOnly: checked.company.isReadOnly,
    };
  }

  // DEV_NOTE: The conversation's root log, for a step that doesn't re-check the conversation (a rejection, an expiry, a
  // commit's end). A failed read rolls the step back (retried later), so no event is cut off from its conversation.
  private async findRootLogId(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
  ): Promise<string | null> {
    const conversation = await this.conversationsDal.getConversationDetails(tx, {
      companyId: session.companyId,
      publicId: session.conversationPublicId,
    });
    if (!conversation.isSuccess && !conversation.isNotFound) {
      throw new TenantRollbackError(conversation.message ?? "Conversation not read");
    }
    return conversation.conversation?.rootLogId ?? null;
  }

  private async findChangeRequest(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
    publicId: string,
  ): Promise<
    | { isSuccess: true; changeRequest: Schemas.ChangeRequestRow }
    | { isSuccess: false; response: Schemas.ChangeRequestStepResponse }
  > {
    const found = await this.changeRequestsDal.getChangeRequestDetails(tx, {
      companyId: session.companyId,
      conversationId: session.conversationId,
      publicId,
      isForUpdate: true,
    });
    if (!found.isSuccess || !found.changeRequest) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          isNotFound: found.isNotFound,
          message: found.message,
          failure: found.isNotFound
            ? Schemas.ChangeRequestFailureEnum.NotFound
            : Schemas.ChangeRequestFailureEnum.ServerError,
        },
      };
    }
    return { isSuccess: true, changeRequest: found.changeRequest };
  }

  // DEV_NOTE: A step that doesn't start from this status: nothing changes, and the caller gets the row as it stands
  private async refuseTransition(
    tx: NodePgTransaction<EmptyRelations>,
    row: Schemas.ChangeRequestRow,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    AppLogger.warn({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.UpdateChangeRequestStatus,
      message: "Change request not in a status this step starts from",
      metadata: {
        companyId: row.companyId,
        changeRequestPublicId: row.publicId,
        status: row.status,
      },
    });
    return {
      isSuccess: false,
      message: "Change request not in a status this step starts from",
      failure: Schemas.ChangeRequestFailureEnum.InvalidTransition,
      changeRequest: ChangeRequestsProvider.toView(row, await this.decryptPayload(tx, row)),
    };
  }

  // DEV_NOTE: One status change and its event, in the caller's transaction (rolled back with it on failure)
  private async moveStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      session: Schemas.ConversationSession;
      row: Schemas.ChangeRequestRow;
      rootLogId: string | null;
      status: Schemas.ChangeRequestStatusIntEnum;
      idempotencyKey?: string;
      errorCode?: Schemas.ChangeRequestErrorCodeEnum | null;
      detail: Record<string, string | number | boolean | null>;
      dedupeParts?: string[];
    },
  ): Promise<{ row: Schemas.ChangeRequestRow; outboxIds: string[] }> {
    const { session, row } = params;
    const updated = await this.changeRequestsDal.updateChangeRequestStatus(tx, {
      companyId: session.companyId,
      id: row.id,
      status: params.status,
      fromStatuses: [row.status],
      idempotencyKey: params.idempotencyKey,
      errorCode: params.errorCode,
    });
    if (!updated.isSuccess || !updated.changeRequest) {
      throw new TenantRollbackError(updated.message ?? "Change request not updated");
    }
    const outboxId = await this.recordEvent(tx, {
      session,
      changeRequest: updated.changeRequest,
      rootLogId: params.rootLogId,
      status: params.status,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      detail: { ...params.detail, errorCode: params.errorCode ?? null },
      dedupeParts: params.dedupeParts,
    });
    return { row: { ...row, ...updated.changeRequest }, outboxIds: [outboxId] };
  }

  private async recordEvent(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      session: Schemas.ConversationSession;
      changeRequest: Schemas.ChangeRequest;
      rootLogId: string | null;
      status: Schemas.ChangeRequestStatusIntEnum;
      actorType: Schemas.ActivityLogActorTypeIntEnum;
      detail: Record<string, string | number | boolean | null>;
      dedupeParts?: string[];
    },
  ): Promise<string> {
    const action = Schemas.CHANGE_REQUEST_STATUS_ENTITY_ACTION_MAP[params.status];
    if (!action) throw new TenantRollbackError("No event for this change request status");
    const { session, changeRequest } = params;
    const event = await CriticalEventProvider.record(tx, {
      companyId: session.companyId,
      actorType: params.actorType,
      actorId:
        params.actorType === Schemas.ActivityLogActorTypeIntEnum.ChatbotUser
          ? session.chatbotUserId
          : null,
      entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
      entityId: changeRequest.id,
      entityAction: action,
      entityVersion: null,
      parentLogId: params.rootLogId,
      rootLogId: params.rootLogId,
      detail: {
        ...params.detail,
        conversationId: session.conversationId,
        status: params.status,
      },
      eventType: Schemas.changeRequestEventType(action),
      dedupeKey: Schemas.changeRequestEventDedupeKey(
        action,
        changeRequest.publicId,
        ...(params.dedupeParts ?? []),
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      throw new TenantRollbackError(event.message ?? "Change request event not recorded");
    }
    return event.outboxId;
  }

  private async encrypt(
    tx: NodePgTransaction<EmptyRelations>,
    companyId: string,
    column: Schemas.EncryptedColumnEnum,
    value: unknown,
  ): Promise<{ encryptedValue: Schemas.EncryptedValue; encryptionKeyVersion: number } | null> {
    const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
      companyId,
      column,
      plaintext: JSON.stringify(value),
    });
    if (
      !encrypted.isSuccess ||
      !encrypted.encryptedValue ||
      encrypted.encryptionKeyVersion === undefined
    ) {
      return null;
    }
    return {
      encryptedValue: encrypted.encryptedValue,
      encryptionKeyVersion: encrypted.encryptionKeyVersion,
    };
  }

  // DEV_NOTE: null when purged or unreadable (logged by CompanyKeyProvider, or here when it isn't a payload)
  private async decryptPayload(
    tx: NodePgTransaction<EmptyRelations>,
    row: Schemas.ChangeRequest,
  ): Promise<Schemas.ChangeRequestPayload | null> {
    const [payload] = await this.decryptPayloads(tx, row.companyId, [row]);
    return payload ?? null;
  }

  // DEV_NOTE: decryptPayload for a list of one company's rows, in order, each key version unwrapped once
  private async decryptPayloads(
    tx: NodePgTransaction<EmptyRelations>,
    companyId: string,
    rows: Schemas.ChangeRequest[],
  ): Promise<(Schemas.ChangeRequestPayload | null)[]> {
    const stored = rows.map((row) =>
      row.encryptedChanges && row.iv && row.encryptionKeyVersion !== null
        ? {
            encryptedValue: { ciphertext: row.encryptedChanges, iv: row.iv },
            encryptionKeyVersion: row.encryptionKeyVersion,
          }
        : null,
    );
    const decrypted = await CompanyKeyProvider.decryptValues(this.env, tx, {
      companyId,
      column: Schemas.EncryptedColumnEnum.ChangeRequestChanges,
      values: stored.filter((value) => value !== null),
    });
    let next = 0;
    return rows.map((row, index) => {
      if (!stored[index]) return null;
      const result = decrypted[next];
      next += 1;
      if (!result?.isSuccess || result.plaintext === undefined) return null;
      const parsed = Schemas.ZChangeRequestPayload.safeParse(Utility.parseJson(result.plaintext));
      if (!parsed.success) {
        AppLogger.error({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.GetChangeRequestDetails,
          message: "Change request payload doesn't parse",
          metadata: { companyId, changeRequestPublicId: row.publicId },
        });
        return null;
      }
      return parsed.data;
    });
  }
}

// DEV_NOTE: A change request step whose conversation check fails. A conversation missing from the company can take
// no more steps, as if closed.
const CHANGE_REQUEST_CHECK_FAILURE_MAP: Record<
  Schemas.ConversationCheckFailureEnum,
  Schemas.ChangeRequestFailureEnum
> = {
  [Schemas.ConversationCheckFailureEnum.NotFound]:
    Schemas.ChangeRequestFailureEnum.ConversationClosed,
  [Schemas.ConversationCheckFailureEnum.ConversationClosed]:
    Schemas.ChangeRequestFailureEnum.ConversationClosed,
  [Schemas.ConversationCheckFailureEnum.ChatbotUnavailable]:
    Schemas.ChangeRequestFailureEnum.ChatbotUnavailable,
  [Schemas.ConversationCheckFailureEnum.ServerError]: Schemas.ChangeRequestFailureEnum.ServerError,
};
