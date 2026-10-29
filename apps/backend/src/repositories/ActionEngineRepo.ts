import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import { z } from "zod";
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
//
// Undo window (M3-7): a status that ends a change request stores undo_until (ChangeRequestsProvider.undoUntil): a
// Verified one can be undone by the user until then (startUndo, re-checked like a commit), and the purge empties every
// one's values after it (ChangeRequestPurgeRepo). NeedsHuman keeps undo_until null.
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
        evalConnectionId: session.eval?.connectionId ?? null,
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
        version: 2,
        kind: params.kind,
        args: params.args,
        before: params.before ?? null,
        changes: params.changes,
        result: null,
        mismatches: null,
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
          Date.now(),
          ChangeRequestsProvider.editableFields(tool, payload),
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
        undoUntil: ChangeRequestsProvider.undoUntil(status, Date.now()),
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
        changeRequest: ChangeRequestsProvider.toView(
          next,
          await this.decryptPayload(tx, next),
          Date.now(),
        ),
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
      const isCommitting = row.status === Schemas.ChangeRequestStatusIntEnum.Committing;
      if (!isCommitting && row.status !== Schemas.ChangeRequestStatusIntEnum.Approved) {
        return await this.refuseTransition(tx, row);
      }
      // DEV_NOTE: A Committing row whose last send reached nothing (the DO's isUnsent, M3-8) is sent fresh
      const isResume = isCommitting && !params.isUnsent;
      if (!checked.isSuccess && checked.failure === Schemas.ChangeRequestFailureEnum.ServerError) {
        return { isSuccess: false, message: checked.message, failure: checked.failure };
      }
      const rootLogId = checked.isSuccess
        ? checked.rootLogId
        : await this.findRootLogId(tx, session);

      const toolRow = await this.toolDefinitionsDal.getToolDefinitionById(tx, {
        companyId: session.companyId,
        id: row.toolId,
        evalConnectionId: session.eval?.connectionId ?? null,
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
          changeRequest: ChangeRequestsProvider.toView(ended.row, payload, Date.now()),
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
        dedupeParts: isCommitting ? [`resume-${params.attemptId}`] : [],
      });

      return {
        isSuccess: true,
        message: isCommitting ? "Commit resumed" : "Commit started",
        outboxIds: started.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(started.row, payload, Date.now()),
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

  // DEV_NOTE: Committing → the commit's end, from the host call (@app/adapter): ChangeRequestsProvider.commitEnd. A
  // commit that landed (Committed) keeps its response in the payload (the read-after and the undo read {result.*}) and
  // the created record's id as host_ref, and hands back the read-after (M3-6).
  async finishCommit(params: Schemas.FinishCommitRequest): Promise<Schemas.FollowUpResponse> {
    const { session, hostCall, plan } = params;
    return await this.step(session, async (tx): Promise<Schemas.FollowUpResponse> => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.Committing) {
        return await this.refuseTransition(tx, row);
      }

      const ended = ChangeRequestsProvider.commitEnd(hostCall, plan.isResume);
      const rootLogId = await this.findRootLogId(tx, session);
      const detail = { outcome: hostCall.outcome, mayHaveLanded: hostCall.mayHaveLanded === true };
      if (ended.status !== Schemas.ChangeRequestStatusIntEnum.Committed) {
        const moved = await this.moveStatus(tx, {
          session,
          row,
          rootLogId,
          status: ended.status,
          errorCode: ended.errorCode,
          detail,
        });
        return {
          isSuccess: true,
          message: "Commit finished",
          outboxIds: moved.outboxIds,
          changeRequest: ChangeRequestsProvider.toView(moved.row, plan.payload, Date.now()),
        };
      }

      // DEV_NOTE: The response is parsed JSON already (null = empty or unreadable body)
      const parsedResult = z.json().safeParse(hostCall.body ?? null);
      const result = parsedResult.success ? parsedResult.data : null;
      const payload: Schemas.ChangeRequestPayload = { ...plan.payload, result };
      const { readbackOp } = plan.tool.ops;
      const moved = await this.moveStatus(tx, {
        session,
        row,
        rootLogId,
        status: Schemas.ChangeRequestStatusIntEnum.Committed,
        errorCode: null,
        detail,
        payload,
        hostRef: readbackOp ? Schemas.getChangeRequestHostRef(readbackOp, result) : null,
      });
      return {
        isSuccess: true,
        message: "Commit finished",
        outboxIds: moved.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(moved.row, payload, Date.now()),
        followUp: {
          changeRequestPublicId: row.publicId,
          followUp: Schemas.ChangeRequestFollowUpEnum.Verify,
          tool: plan.tool,
          payload,
          idempotencyKey: null,
          isResume: false,
        },
      };
    });
  }

  // DEV_NOTE: The next step of a landed commit, read from the row (M3-6): Committed → the read-after, Mismatch → the
  // auto-undo (isResume when its key is already stored: the undo may have been sent), and a Verified one holding its
  // undo key → the user's undo an eviction cut short (M3-7, isResume). For a write that already landed (or an undo
  // already sent), so the conversation, chatbot and company aren't re-checked: reading it back or putting it back is
  // cleanup, never a new change. A tool version that no longer loads, or an unreadable payload, can't take the step:
  // NeedsHuman.
  async startFollowUp(params: Schemas.StartFollowUpRequest): Promise<Schemas.FollowUpResponse> {
    const { session } = params;
    return await this.step(session, async (tx): Promise<Schemas.FollowUpResponse> => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const isVerify = row.status === Schemas.ChangeRequestStatusIntEnum.Committed;
      if (
        !isVerify &&
        row.status !== Schemas.ChangeRequestStatusIntEnum.Mismatch &&
        !ChangeRequestsProvider.isUserUndoing(row)
      ) {
        return await this.refuseTransition(tx, row);
      }
      const rootLogId = await this.findRootLogId(tx, session);
      const loaded = await this.loadTool(tx, ActionEngineRepo.toolScope(session), row.toolId);
      if (!loaded.isSuccess && loaded.failure === Schemas.ChangeRequestFailureEnum.ServerError) {
        return { isSuccess: false, message: loaded.message, failure: loaded.failure };
      }
      const payload = await this.decryptPayload(tx, row);
      if (!loaded.isSuccess || !payload) {
        const errorCode = !loaded.isSuccess
          ? Schemas.ChangeRequestErrorCodeEnum.ToolUnavailable
          : Schemas.ChangeRequestErrorCodeEnum.PayloadUnreadable;
        const ended = await this.moveStatus(tx, {
          session,
          row,
          rootLogId,
          status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
          errorCode,
          detail: { reason: errorCode },
        });
        AppLogger.warn({
          category: Schemas.LogCategory.Action,
          action: isVerify
            ? Schemas.LogAction.VerifyChangeRequest
            : Schemas.LogAction.UndoChangeRequest,
          message: `Follow-up not started: ${errorCode}`,
          metadata: { companyId: session.companyId, changeRequestPublicId: row.publicId },
        });
        return {
          isSuccess: false,
          message: "Follow-up not started",
          failure: Schemas.ChangeRequestFailureEnum.ToolUnavailable,
          outboxIds: ended.outboxIds,
          changeRequest: ChangeRequestsProvider.toView(ended.row, payload, Date.now()),
        };
      }

      if (isVerify) {
        return {
          isSuccess: true,
          message: "Read-after resumed",
          outboxIds: [],
          changeRequest: ChangeRequestsProvider.toView(row, payload, Date.now()),
          followUp: {
            changeRequestPublicId: row.publicId,
            followUp: Schemas.ChangeRequestFollowUpEnum.Verify,
            tool: loaded.tool,
            payload,
            idempotencyKey: null,
            isResume: false,
          },
        };
      }
      return await this.beginUndo(tx, {
        session,
        row,
        rootLogId,
        tool: loaded.tool,
        payload,
        dedupeParts: [`resume-${params.attemptId}`],
        isUnsent: params.isUnsent,
      });
    });
  }

  // DEV_NOTE: Committed → the read-after's end (Schemas.checkReadAfter → ChangeRequestsProvider.verifyEnd): Verified,
  // NeedsHuman (it couldn't tell), or Mismatch with what it found (kept in the payload for the widget), whose auto-undo
  // starts in the same transaction (beginUndo)
  async finishVerify(params: Schemas.FinishVerifyRequest): Promise<Schemas.FollowUpResponse> {
    const { session, plan, readback } = params;
    return await this.step(session, async (tx): Promise<Schemas.FollowUpResponse> => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.Committed) {
        return await this.refuseTransition(tx, row);
      }
      const rootLogId = await this.findRootLogId(tx, session);
      const { readbackOp } = plan.tool.ops;
      const check: Schemas.ChangeRequestReadAfterCheck = readbackOp
        ? Schemas.checkReadAfter({
            kind: plan.payload.kind,
            step: Schemas.ChangeRequestCheckStepEnum.Commit,
            readbackOp,
            payload: plan.payload,
            readback,
          })
        : { verdict: Schemas.ChangeRequestCheckVerdictEnum.Unknown, mismatches: [] };
      const ended = ChangeRequestsProvider.verifyEnd(check);
      const detail = {
        outcome: readback.outcome,
        httpStatus: readback.httpStatus ?? null,
        mismatchCount: check.mismatches.length,
      };

      if (ended.status !== Schemas.ChangeRequestStatusIntEnum.Mismatch) {
        const moved = await this.moveStatus(tx, {
          session,
          row,
          rootLogId,
          status: ended.status,
          errorCode: ended.errorCode,
          detail,
        });
        return {
          isSuccess: true,
          message: "Read-after finished",
          outboxIds: moved.outboxIds,
          changeRequest: ChangeRequestsProvider.toView(moved.row, plan.payload, Date.now()),
        };
      }

      const payload: Schemas.ChangeRequestPayload = {
        ...plan.payload,
        mismatches: check.mismatches,
      };
      const mismatched = await this.moveStatus(tx, {
        session,
        row,
        rootLogId,
        status: Schemas.ChangeRequestStatusIntEnum.Mismatch,
        errorCode: null,
        detail,
        payload,
      });
      const undo = await this.beginUndo(tx, {
        session,
        row: mismatched.row,
        rootLogId,
        tool: plan.tool,
        payload,
        dedupeParts: [],
        isUnsent: false,
      });
      return { ...undo, outboxIds: [...mismatched.outboxIds, ...(undo.outboxIds ?? [])] };
    });
  }

  // DEV_NOTE: An undo's end (ChangeRequestsProvider.undoEnd): Mismatch (the auto-undo) or a Verified one holding the
  // user's undo key (M3-7) → Undone when the undo succeeded and the record reads back as before, else NeedsHuman. The
  // user's undo that nothing may have reached the host stays Verified (an undo_not_sent event, not a status change):
  // the commit's key again (so neither a resume nor the purge takes it for an undo under way), its undo_until as it
  // was. The end of the user's undo is the chatbot user's, like its start.
  async finishUndo(params: Schemas.FinishUndoRequest): Promise<Schemas.ChangeRequestStepResponse> {
    const { session, plan, undo, readback } = params;
    return await this.step(session, async (tx) => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const isUserUndo = ChangeRequestsProvider.isUserUndoing(row);
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.Mismatch && !isUserUndo) {
        return await this.refuseTransition(tx, row);
      }
      const { readbackOp } = plan.tool.ops;
      const check =
        readback && readbackOp
          ? Schemas.checkReadAfter({
              kind: plan.payload.kind,
              step: Schemas.ChangeRequestCheckStepEnum.Undo,
              readbackOp,
              payload: plan.payload,
              readback,
            })
          : null;
      const ended = ChangeRequestsProvider.undoEnd(undo, check, isUserUndo);
      const isKept = ended.status === Schemas.ChangeRequestStatusIntEnum.Verified;
      const moved = await this.moveStatus(tx, {
        session,
        row,
        rootLogId: await this.findRootLogId(tx, session),
        status: ended.status,
        errorCode: ended.errorCode,
        actorType: isUserUndo
          ? Schemas.ActivityLogActorTypeIntEnum.ChatbotUser
          : Schemas.ActivityLogActorTypeIntEnum.System,
        ...(isKept
          ? {
              action: Schemas.ChangeRequestEntityActionEnum.UndoNotSent,
              idempotencyKey: Schemas.changeRequestCommitIdempotencyKey(row.publicId),
              undoUntil: "keep" as const,
              dedupeParts: [Utility.generateUlid()],
            }
          : {}),
        detail: {
          outcome: undo.outcome,
          mayHaveLanded: undo.mayHaveLanded === true,
          readbackOutcome: readback?.outcome ?? null,
          isUserUndo,
        },
      });
      return {
        isSuccess: true,
        message: "Undo finished",
        outboxIds: moved.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(moved.row, plan.payload, Date.now()),
      };
    });
  }

  // DEV_NOTE: The user's undo of a Verified change request (M3-7), re-checked like a commit, since it writes to the host
  // again: the conversation open, the company and chatbot active and not read-only, then under the row lock Verified
  // with no undo under way, its tool has an inverse_op, its values not purged and before its undo_until
  // (ChangeRequestsProvider.undoRefusal), and its tool version still loading. A refusal changes nothing. Otherwise the
  // undo key is stored with its undoing event by the chatbot user (beginUndo); it stays Verified until the undo ends.
  async startUndo(params: Schemas.StartUndoRequest): Promise<Schemas.FollowUpResponse> {
    const { session } = params;
    return await this.step(session, async (tx): Promise<Schemas.FollowUpResponse> => {
      const checked = await this.checkConversation(tx, session, true);
      if (!checked.isSuccess) {
        return { isSuccess: false, message: checked.message, failure: checked.failure };
      }
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const refusal = ChangeRequestsProvider.undoRefusal(row, Date.now());
      if (refusal === Schemas.ChangeRequestFailureEnum.InvalidTransition) {
        return await this.refuseTransition(tx, row);
      }
      const payload = await this.decryptPayload(tx, row);
      const refuse = (
        failure: Schemas.ChangeRequestFailureEnum,
        message: string,
      ): Schemas.FollowUpResponse => ({
        isSuccess: false,
        message,
        failure,
        changeRequest: ChangeRequestsProvider.toView(row, payload, Date.now()),
      });
      if (refusal) return refuse(refusal, "Change request can't be undone now");
      const loaded = await this.loadTool(tx, ActionEngineRepo.toolScope(session), row.toolId);
      if (!loaded.isSuccess) return refuse(loaded.failure, loaded.message);
      if (!loaded.tool.ops.inverseOp || !payload) {
        return refuse(
          Schemas.ChangeRequestFailureEnum.NotUndoable,
          payload ? "Tool has no inverse op" : "Change request payload unreadable",
        );
      }
      return await this.beginUndo(tx, {
        session,
        row,
        rootLogId: checked.rootLogId,
        tool: loaded.tool,
        payload,
        dedupeParts: [`user-${params.attemptId}`],
        isUnsent: false,
      });
    });
  }

  // DEV_NOTE: A user undo cut short whose user never came back with the host token (M3-7): past undo_until +
  // CHANGE_REQUEST_UNDO_GRACE_MS, the DO hands it to a person (NeedsHuman undo_interrupted: its undo may have been sent),
  // so its values are kept on purpose and the conversation can close. Only a Verified row still holding the user's undo
  // key (an undo that ended meanwhile is left as it stands).
  async abandonUndo(
    params: Schemas.AbandonUndoRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session } = params;
    return await this.step(session, async (tx) => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (!ChangeRequestsProvider.isUserUndoing(row)) return await this.refuseTransition(tx, row);
      const moved = await this.moveStatus(tx, {
        session,
        row,
        rootLogId: await this.findRootLogId(tx, session),
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoInterrupted,
        detail: { reason: Schemas.ChangeRequestErrorCodeEnum.UndoInterrupted },
      });
      return {
        isSuccess: true,
        message: "Interrupted undo handed to a person",
        outboxIds: moved.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(
          moved.row,
          await this.decryptPayload(tx, moved.row),
          Date.now(),
        ),
      };
    });
  }

  // DEV_NOTE: A change request past the user's answer whose next step waited HOST_TOKEN_GRACE_MS for a host token that
  // never came (M3-8: the widget closed, or its host gave none): handed to a person (NeedsHuman token_needed), so the
  // conversation can close. Approved, Committing (its commit may have landed), Committed (not read back) or Mismatch (not
  // undone). A user undo keeps its own deadline (abandonUndo); a row that ended meanwhile is left as it stands.
  async handOverForToken(
    params: Schemas.HandOverForTokenRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session } = params;
    return await this.step(session, async (tx) => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (!TOKEN_WAIT_STATUSES.has(row.status)) return await this.refuseTransition(tx, row);
      const moved = await this.moveStatus(tx, {
        session,
        row,
        rootLogId: await this.findRootLogId(tx, session),
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.TokenNeeded,
        detail: { reason: Schemas.ChangeRequestErrorCodeEnum.TokenNeeded },
      });
      return {
        isSuccess: true,
        message: "Change request waiting for the host token handed to a person",
        outboxIds: moved.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(
          moved.row,
          await this.decryptPayload(tx, moved.row),
          Date.now(),
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

  // DEV_NOTE: An edit's first step (M3-5): the change request must still be Proposed and before its deadline, the
  // conversation open, the company and chatbot active and not read-only, and its tool version still loading (Active,
  // on a connection that can serve calls). Nothing changes here: the DO checks the edit against the plan (editable
  // fields, input_schema), reads the record again and rebuilds the diff before saveEdit.
  async getEditPlan(params: Schemas.GetEditPlanRequest): Promise<Schemas.GetEditPlanResponse> {
    const { session } = params;
    return await this.step(session, async (tx): Promise<Schemas.GetEditPlanResponse> => {
      const checked = await this.checkConversation(tx, session, true);
      if (!checked.isSuccess) {
        return { isSuccess: false, message: checked.message, failure: checked.failure };
      }
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const ready = await this.checkEditable(tx, session, row);
      if (!ready.isSuccess) return ready.response;
      return {
        isSuccess: true,
        message: "Edit plan ready",
        plan: { changeRequestPublicId: row.publicId, tool: ready.tool, payload: ready.payload },
      };
    });
  }

  // DEV_NOTE: An edit's last step (M3-5): the re-checked payload replaces the stored one (encrypted here; summary and
  // change count from its diff, was_edited set) with its change_request.edited event, in one transaction, only while
  // the change request is still Proposed and before its deadline (re-checked under the row lock: an answer or the
  // expiry that came first wins). It stays Proposed: the user approves the new diff.
  async saveEdit(params: Schemas.SaveEditRequest): Promise<Schemas.ChangeRequestStepResponse> {
    const { session } = params;
    return await this.step(session, async (tx) => {
      const checked = await this.checkConversation(tx, session, true);
      if (!checked.isSuccess) {
        return { isSuccess: false, message: checked.message, failure: checked.failure };
      }
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const ready = await this.checkEditable(tx, session, row);
      if (!ready.isSuccess) return ready.response;

      const parsed = Schemas.ZChangeRequestPayload.safeParse(params.payload);
      if (!parsed.success || parsed.data.kind !== ready.payload.kind) {
        return {
          isSuccess: false,
          message: "Edited payload doesn't fit the change request",
          failure: Schemas.ChangeRequestFailureEnum.InvalidEdit,
        };
      }
      const payload = parsed.data;
      const encrypted = await this.encrypt(
        tx,
        session.companyId,
        Schemas.EncryptedColumnEnum.ChangeRequestChanges,
        payload,
      );
      if (!encrypted) throw new TenantRollbackError("Edited values not encrypted");

      const changeCount = Schemas.countChangedFields(payload.changes);
      const updated = await this.changeRequestsDal.updateChangeRequestPayload(tx, {
        companyId: session.companyId,
        id: row.id,
        encryptedChanges: encrypted.encryptedValue.ciphertext,
        iv: encrypted.encryptedValue.iv,
        encryptionKeyVersion: encrypted.encryptionKeyVersion,
        summary: Schemas.buildChangeRequestSummary(ready.tool.name, payload.kind, changeCount),
        changeCount,
      });
      if (!updated.isSuccess || !updated.changeRequest) {
        throw new TenantRollbackError(updated.message ?? "Change request not edited");
      }
      const outboxId = await this.recordEvent(tx, {
        session,
        changeRequest: updated.changeRequest,
        rootLogId: checked.rootLogId,
        status: Schemas.ChangeRequestStatusIntEnum.Proposed,
        action: Schemas.ChangeRequestEntityActionEnum.Edited,
        actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
        detail: { toolCallId: row.toolCallId, changeCount },
        dedupeParts: [params.editId],
      });

      const next = { ...row, ...updated.changeRequest };
      return {
        isSuccess: true,
        message: "Change request edited",
        outboxIds: [outboxId],
        changeRequest: ChangeRequestsProvider.toView(
          next,
          payload,
          Date.now(),
          ChangeRequestsProvider.editableFields(ready.tool, payload),
        ),
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
      const now = Date.now();
      const changeRequests: Schemas.WidgetChangeRequest[] = [];
      const tools = new Map<string, Schemas.RuntimeTool | null>();
      for (const [index, row] of listed.changeRequests.entries()) {
        const payload = payloads[index] ?? null;
        let editableFields: Schemas.ChangeRequestEditableField[] = [];
        // DEV_NOTE: Only a Proposed one can be edited, so only its tool is read (once per tool version)
        if (payload && row.status === Schemas.ChangeRequestStatusIntEnum.Proposed) {
          if (!tools.has(row.toolId)) {
            const loaded = await this.loadTool(tx, ActionEngineRepo.toolScope(session), row.toolId);
            tools.set(row.toolId, loaded.isSuccess ? loaded.tool : null);
          }
          const tool = tools.get(row.toolId);
          if (tool) editableFields = ChangeRequestsProvider.editableFields(tool, payload);
        }
        changeRequests.push(ChangeRequestsProvider.toView(row, payload, now, editableFields));
      }
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

  // DEV_NOTE: What an edit needs of the row it locked: Proposed (else the row as it stands), before its deadline
  // (PastDeadline: the expiry ends it), its tool version still loading (ToolUnavailable) and its payload readable
  private async checkEditable(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
    row: Schemas.ChangeRequestRow,
  ): Promise<
    | { isSuccess: true; tool: Schemas.RuntimeTool; payload: Schemas.ChangeRequestPayload }
    | { isSuccess: false; response: Schemas.ChangeRequestStepResponse }
  > {
    if (row.status !== Schemas.ChangeRequestStatusIntEnum.Proposed) {
      return { isSuccess: false, response: await this.refuseTransition(tx, row) };
    }
    const payload = await this.decryptPayload(tx, row);
    const view = ChangeRequestsProvider.toView(row, payload, Date.now());
    if (ChangeRequestsProvider.isPastDeadline(row, Date.now())) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: "Edit came after the deadline",
          failure: Schemas.ChangeRequestFailureEnum.PastDeadline,
          changeRequest: view,
        },
      };
    }
    const loaded = await this.loadTool(tx, ActionEngineRepo.toolScope(session), row.toolId);
    if (!loaded.isSuccess) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: loaded.message,
          failure: loaded.failure,
          changeRequest: view,
        },
      };
    }
    if (!payload) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: "Change request payload unreadable",
          failure: Schemas.ChangeRequestFailureEnum.ServerError,
          changeRequest: view,
        },
      };
    }
    return { isSuccess: true, tool: loaded.tool, payload };
  }

  // DEV_NOTE: Where a session's host calls run: its company, and an eval's staging connection in place of each tool's
  // own (M5-2), null for a widget conversation
  private static toolScope(session: Schemas.ConversationSession): Schemas.RuntimeToolScope {
    return { companyId: session.companyId, evalConnectionId: session.eval?.connectionId ?? null };
  }

  // DEV_NOTE: A change request's tool version as it would run now (HostToolsProvider.toRuntimeTool), by its id, on the
  // scope's connection
  private async loadTool(
    tx: NodePgTransaction<EmptyRelations>,
    scope: Schemas.RuntimeToolScope,
    toolId: string,
  ): Promise<
    | { isSuccess: true; tool: Schemas.RuntimeTool }
    | { isSuccess: false; message: string; failure: Schemas.ChangeRequestFailureEnum }
  > {
    const toolRow = await this.toolDefinitionsDal.getToolDefinitionById(tx, {
      companyId: scope.companyId,
      id: toolId,
      evalConnectionId: scope.evalConnectionId,
    });
    if (!toolRow.isSuccess && !toolRow.isNotFound) {
      return {
        isSuccess: false,
        message: toolRow.message ?? "Tool definition not read",
        failure: Schemas.ChangeRequestFailureEnum.ServerError,
      };
    }
    const runtime = toolRow.toolDefinition
      ? HostToolsProvider.toRuntimeTool(toolRow.toolDefinition)
      : { tool: null, reason: "Tool definition not found" };
    if (!runtime.tool) {
      return {
        isSuccess: false,
        message: runtime.reason,
        failure: Schemas.ChangeRequestFailureEnum.ToolUnavailable,
      };
    }
    return { isSuccess: true, tool: runtime.tool };
  }

  // DEV_NOTE: An eval readback assert's plan (M5-2): a change request of one eval conversation, its decrypted payload
  // (args, the commit's result) and its tool version on the conversation's staging connection, for the same readback
  // request live verification sends. Read only: nothing changes. The payload stays server-side (host data).
  async getEvalReadbackPlan(params: {
    companyId: string;
    conversationId: string;
    evalConnectionId: string;
    changeRequestPublicId: string;
  }): Promise<Schemas.EvalReadbackPlanResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const found = await this.changeRequestsDal.getChangeRequestDetails(tx, {
        companyId: params.companyId,
        conversationId: params.conversationId,
        publicId: params.changeRequestPublicId,
        isForUpdate: false,
      });
      if (!found.isSuccess || !found.changeRequest) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }
      const loaded = await this.loadTool(
        tx,
        { companyId: params.companyId, evalConnectionId: params.evalConnectionId },
        found.changeRequest.toolId,
      );
      if (!loaded.isSuccess) return { isSuccess: false, message: loaded.message };
      const payload = await this.decryptPayload(tx, found.changeRequest);
      if (!payload) return { isSuccess: false, message: "Change request payload unreadable" };
      return {
        isSuccess: true,
        message: "Readback plan loaded",
        plan: { tool: loaded.tool, payload },
      };
    });
  }

  // DEV_NOTE: An undo starts: a Mismatch's auto-undo, or the user's undo of a Verified one (M3-7: the row is Verified;
  // its actor is the chatbot user, its undo_until kept). A tool with no inverse_op can't be undone (a Mismatch ends
  // NeedsHuman not_undoable; startUndo refuses the user's before this); otherwise the undo key is stored first, with
  // its undoing event (the status stays), so a resume knows the undo may have been sent (isResume: a Native tool
  // resends with the same key, an Emulated one checks first, None doesn't resend and ends NeedsHuman)
  private async beginUndo(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      session: Schemas.ConversationSession;
      row: Schemas.ChangeRequestRow;
      rootLogId: string | null;
      tool: Schemas.RuntimeTool;
      payload: Schemas.ChangeRequestPayload;
      dedupeParts: string[];
      isUnsent: boolean;
    },
  ): Promise<Schemas.FollowUpResponse> {
    const { session, row, tool, payload } = params;
    if (!tool.ops.inverseOp) {
      const ended = await this.moveStatus(tx, {
        session,
        row,
        rootLogId: params.rootLogId,
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
        detail: { reason: Schemas.ChangeRequestErrorCodeEnum.NotUndoable },
      });
      return {
        isSuccess: true,
        message: "Mismatch can't be undone",
        outboxIds: ended.outboxIds,
        changeRequest: ChangeRequestsProvider.toView(ended.row, payload, Date.now()),
      };
    }
    const isUserUndo = row.status === Schemas.ChangeRequestStatusIntEnum.Verified;
    const idempotencyKey = isUserUndo
      ? Schemas.changeRequestUserUndoIdempotencyKey(row.publicId)
      : Schemas.changeRequestUndoIdempotencyKey(row.publicId);
    // DEV_NOTE: An undo whose last send reached nothing (the DO's isUnsent, M3-8) is sent fresh
    const isResume = row.idempotencyKey === idempotencyKey && !params.isUnsent;
    const started = await this.moveStatus(tx, {
      session,
      row,
      rootLogId: params.rootLogId,
      status: row.status,
      action: Schemas.ChangeRequestEntityActionEnum.Undoing,
      actorType:
        isUserUndo && !isResume
          ? Schemas.ActivityLogActorTypeIntEnum.ChatbotUser
          : Schemas.ActivityLogActorTypeIntEnum.System,
      idempotencyKey,
      undoUntil: "keep",
      detail: { isResume, isUserUndo },
      dedupeParts: params.dedupeParts,
    });
    return {
      isSuccess: true,
      message: isResume ? "Undo resumed" : "Undo started",
      outboxIds: started.outboxIds,
      changeRequest: ChangeRequestsProvider.toView(started.row, payload, Date.now()),
      followUp: {
        changeRequestPublicId: row.publicId,
        followUp: Schemas.ChangeRequestFollowUpEnum.Undo,
        tool,
        payload,
        idempotencyKey,
        isResume,
      },
    };
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
      changeRequest: ChangeRequestsProvider.toView(
        row,
        await this.decryptPayload(tx, row),
        Date.now(),
      ),
    };
  }

  // DEV_NOTE: One status change and its event, in the caller's transaction (rolled back with it on failure). payload
  // (re-encrypted here) and hostRef go in the same update; action names an event that isn't the status's own (undoing).
  // undoUntil: "follow" (default) stores what the status calls for (ChangeRequestsProvider.undoUntil, M3-7); "keep"
  // leaves it (an undo starting, or the user's undo that reached nothing). actorType: the system unless the user's
  // own step (the user's undo).
  private async moveStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      session: Schemas.ConversationSession;
      row: Schemas.ChangeRequestRow;
      rootLogId: string | null;
      status: Schemas.ChangeRequestStatusIntEnum;
      action?: Schemas.ChangeRequestEntityActionEnum;
      idempotencyKey?: string;
      errorCode?: Schemas.ChangeRequestErrorCodeEnum | null;
      hostRef?: string | null;
      payload?: Schemas.ChangeRequestPayload;
      undoUntil?: "follow" | "keep";
      actorType?: Schemas.ActivityLogActorTypeIntEnum;
      detail: Record<string, string | number | boolean | null>;
      dedupeParts?: string[];
    },
  ): Promise<{ row: Schemas.ChangeRequestRow; outboxIds: string[] }> {
    const { session, row } = params;
    let payload: Schemas.UpdateChangeRequestStatusDALRequest["payload"];
    if (params.payload) {
      const encrypted = await this.encrypt(
        tx,
        session.companyId,
        Schemas.EncryptedColumnEnum.ChangeRequestChanges,
        params.payload,
      );
      if (!encrypted) throw new TenantRollbackError("Change request payload not encrypted");
      payload = {
        encryptedChanges: encrypted.encryptedValue.ciphertext,
        iv: encrypted.encryptedValue.iv,
        encryptionKeyVersion: encrypted.encryptionKeyVersion,
      };
    }
    const updated = await this.changeRequestsDal.updateChangeRequestStatus(tx, {
      companyId: session.companyId,
      id: row.id,
      status: params.status,
      fromStatuses: [row.status],
      idempotencyKey: params.idempotencyKey,
      errorCode: params.errorCode,
      hostRef: params.hostRef,
      payload,
      undoUntil:
        params.undoUntil === "keep"
          ? undefined
          : ChangeRequestsProvider.undoUntil(params.status, Date.now()),
    });
    if (!updated.isSuccess || !updated.changeRequest) {
      throw new TenantRollbackError(updated.message ?? "Change request not updated");
    }
    const outboxId = await this.recordEvent(tx, {
      session,
      changeRequest: updated.changeRequest,
      rootLogId: params.rootLogId,
      status: params.status,
      action: params.action,
      actorType: params.actorType ?? Schemas.ActivityLogActorTypeIntEnum.System,
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
      action?: Schemas.ChangeRequestEntityActionEnum;
      actorType: Schemas.ActivityLogActorTypeIntEnum;
      detail: Record<string, string | number | boolean | null>;
      dedupeParts?: string[];
    },
  ): Promise<string> {
    // DEV_NOTE: A status change's own action, unless the event isn't one (an edit)
    const action = params.action ?? Schemas.CHANGE_REQUEST_STATUS_ENTITY_ACTION_MAP[params.status];
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
      const parsed = Schemas.parseChangeRequestPayload(Utility.parseJson(result.plaintext));
      if (!parsed) {
        AppLogger.error({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.GetChangeRequestDetails,
          message: "Change request payload doesn't parse",
          metadata: { companyId, changeRequestPublicId: row.publicId },
        });
        return null;
      }
      return parsed;
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

// DEV_NOTE: The statuses a step waits for the host token in (M3-8), handed to a person when none comes
const TOKEN_WAIT_STATUSES: ReadonlySet<Schemas.ChangeRequestStatusIntEnum> = new Set([
  Schemas.ChangeRequestStatusIntEnum.Approved,
  Schemas.ChangeRequestStatusIntEnum.Committing,
  Schemas.ChangeRequestStatusIntEnum.Committed,
  Schemas.ChangeRequestStatusIntEnum.Mismatch,
]);
