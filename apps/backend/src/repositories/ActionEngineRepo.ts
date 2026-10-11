import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import ToolCallsDAL from "@/data-access-layer/ToolCallsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import CriticalEventProvider from "@/providers/criticalEvent";
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
// another (an approval and the expiry) changes nothing and answers InvalidTransition.
export default class ActionEngineRepo {
  private db: NodePgDatabase;
  private env: Env;
  private toolDefinitionsDal: ToolDefinitionsDAL;
  private toolCallsDal: ToolCallsDAL;
  private changeRequestsDal: ChangeRequestsDAL;
  private conversationsDal: ConversationsDAL;
  private companiesDal: CompaniesDAL;
  private chatbotsDal: ChatbotsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.toolDefinitionsDal = new ToolDefinitionsDAL();
    this.toolCallsDal = new ToolCallsDAL();
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.conversationsDal = new ConversationsDAL();
    this.companiesDal = new CompaniesDAL();
    this.chatbotsDal = new ChatbotsDAL();
  }

  // DEV_NOTE: The config's exact {name, version} pins, as the turn will run them. A pin whose version is not Active,
  // whose connection can't serve calls, whose ops don't load or fit its risk, or whose input_schema can't be checked is
  // left out of the turn and logged (the bot answers without it; M4-10 keeps a published config from pinning one).
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
      for (const pin of pins) {
        const row = found.toolDefinitions.find(
          (candidate) => candidate.name === pin.name && candidate.version === pin.version,
        );
        const loaded = row
          ? ActionEngineRepo.toRuntimeTool(row)
          : { tool: null, reason: "Pinned version not found" };
        if (loaded.tool) {
          tools.push(loaded.tool);
          continue;
        }
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
      return {
        isSuccess: true,
        message: "Turn tools loaded",
        tools,
        skippedCount: pins.length - tools.length,
      };
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
  async proposeChange(
    params: Schemas.ProposeChangeRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session, tool } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
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
        changeRequest: ActionEngineRepo.toView(
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
  // An approval re-checks everything a commit needs; a rejection or an expiry ends the proposal whatever else changed.
  async decideChangeRequest(
    params: Schemas.DecideChangeRequest,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session } = params;
    const isApprove =
      params.decision === Schemas.ChangeRequestDecisionEnum.Approve && !params.isExpired;
    const status = params.isExpired
      ? Schemas.ChangeRequestStatusIntEnum.Expired
      : isApprove
        ? Schemas.ChangeRequestStatusIntEnum.Approved
        : Schemas.ChangeRequestStatusIntEnum.Rejected;

    return await withTenant(this.db, session.companyId, async (tx) => {
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
        return await this.refuseTransition(tx, session, row);
      }

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
        actorType: params.isExpired
          ? Schemas.ActivityLogActorTypeIntEnum.System
          : Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
        detail: { toolCallId: row.toolCallId },
      });

      const next = { ...row, ...updated.changeRequest };
      return {
        isSuccess: true,
        message: "Change request decided",
        outboxIds: [outboxId],
        changeRequest: ActionEngineRepo.toView(next, await this.decryptPayload(tx, next)),
      };
    });
  }

  // DEV_NOTE: Approved → Committing (the commit's key stored), or a Committing one again (an eviction cut its commit:
  // isResume, since that attempt may have reached the host). The tool version is read again by its id and must still
  // be Active on an Active connection; if it isn't, the change request ends Failed (nothing was sent) or, on a resume,
  // NeedsHuman (something may have been).
  async startCommit(params: Schemas.StartCommitRequest): Promise<Schemas.StartCommitResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const checked = await this.checkConversation(tx, session, true);
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      const isResume = row.status === Schemas.ChangeRequestStatusIntEnum.Committing;
      if (!isResume && row.status !== Schemas.ChangeRequestStatusIntEnum.Approved) {
        return await this.refuseTransition(tx, session, row);
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
        ? ActionEngineRepo.toRuntimeTool(toolRow.toolDefinition)
        : { tool: null, reason: "Tool definition not found" };
      const payload = await this.decryptPayload(tx, row);

      // DEV_NOTE: The step can't go on: end the change request here, in this transaction
      const refusal: Schemas.ChangeRequestFailureEnum | null = !checked.isSuccess
        ? checked.failure
        : !runtime.tool
          ? Schemas.ChangeRequestFailureEnum.ToolUnavailable
          : !payload
            ? Schemas.ChangeRequestFailureEnum.ServerError
            : null;
      if (refusal || !runtime.tool || !payload) {
        const ended = await this.moveStatus(tx, {
          session,
          row,
          rootLogId,
          status: isResume
            ? Schemas.ChangeRequestStatusIntEnum.NeedsHuman
            : Schemas.ChangeRequestStatusIntEnum.Failed,
          errorCode: refusal ?? Schemas.ChangeRequestFailureEnum.ServerError,
          detail: { reason: refusal ?? Schemas.ChangeRequestFailureEnum.ServerError },
        });
        AppLogger.warn({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.CommitChangeRequest,
          message: `Commit not started: ${checked.isSuccess ? (runtime.reason ?? "payload unreadable") : (checked.message ?? checked.failure)}`,
          metadata: { companyId: session.companyId, changeRequestPublicId: row.publicId, isResume },
        });
        return {
          isSuccess: false,
          message: "Commit not started",
          failure: refusal ?? Schemas.ChangeRequestFailureEnum.ServerError,
          outboxIds: ended.outboxIds,
          changeRequest: ActionEngineRepo.toView(ended.row, payload),
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
        dedupeParts: isResume ? [`resume-${Date.now()}`] : [],
      });

      return {
        isSuccess: true,
        message: isResume ? "Commit resumed" : "Commit started",
        outboxIds: started.outboxIds,
        changeRequest: ActionEngineRepo.toView(started.row, payload),
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

  // DEV_NOTE: Committing → the commit's end, from the host call (@app/adapter): Succeeded or AlreadyApplied →
  // Committed (verified by read-after in M3-6); Unknown → NeedsHuman; any other outcome → Failed when nothing may have
  // landed, else NeedsHuman (a token refused after a send that may have landed is never resent here: M3-8).
  async finishCommit(
    params: Schemas.FinishCommitRequest & { isResume: boolean },
  ): Promise<Schemas.ChangeRequestStepResponse> {
    const { session, hostCall } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const found = await this.findChangeRequest(tx, session, params.changeRequestPublicId);
      if (!found.isSuccess) return found.response;
      const row = found.changeRequest;
      if (row.status !== Schemas.ChangeRequestStatusIntEnum.Committing) {
        return await this.refuseTransition(tx, session, row);
      }

      const ended = ActionEngineRepo.commitEnd(hostCall, params.isResume);
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
        changeRequest: ActionEngineRepo.toView(moved.row, await this.decryptPayload(tx, moved.row)),
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
      return { isSuccess: updated.isSuccess, message: updated.message };
    });
  }

  // DEV_NOTE: The widget's views of some of this conversation's change requests (values decrypted: the user's own
  // widget only), oldest first. One whose payload can't be read is sent without its changes.
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
      const changeRequests: Schemas.WidgetChangeRequest[] = [];
      for (const row of listed.changeRequests) {
        changeRequests.push(ActionEngineRepo.toView(row, await this.decryptPayload(tx, row)));
      }
      return { isSuccess: true, message: "Change requests fetched", changeRequests };
    });
  }

  // DEV_NOTE: A loaded pin, or why it can't run (logged by the caller)
  private static toRuntimeTool(
    row: Schemas.ToolDefinitionWithConnectionRow,
  ): { tool: Schemas.RuntimeTool; reason?: undefined } | { tool: null; reason: string } {
    if (row.status !== Schemas.ToolDefinitionStatusIntEnum.Active) {
      return { tool: null, reason: "Tool version is not Active" };
    }
    const { connection } = row;
    if (
      !connection ||
      connection.status !== Schemas.CompanyConnectionStatusIntEnum.Active ||
      connection.adapterType !== Schemas.CompanyConnectionAdapterTypeIntEnum.Rest ||
      !connection.baseUrl
    ) {
      return { tool: null, reason: "Connection can't serve tool calls" };
    }
    const authIssue = Schemas.getAuthConfigIssue(connection);
    if (authIssue) return { tool: null, reason: authIssue };

    const loaded = Schemas.loadToolOps({
      schemaVersion: row.schemaVersion,
      ops: {
        inputSchema: row.inputSchema,
        callOp: row.callOp,
        readbackOp: row.readbackOp,
        inverseOp: row.inverseOp,
      },
    });
    if (!loaded.isSuccess || !loaded.ops) {
      return { tool: null, reason: loaded.message ?? "Tool ops don't load" };
    }
    const issue =
      Schemas.getToolRiskOpsIssue(row.risk, row.idempotencyMode, loaded.ops) ??
      Schemas.getToolInputSchemaIssue(loaded.ops.inputSchema);
    if (issue) return { tool: null, reason: issue };

    return {
      tool: {
        id: row.id,
        name: row.name,
        version: row.version,
        description: row.description,
        risk: row.risk,
        idempotencyMode: row.idempotencyMode,
        approval: row.approval,
        ops: loaded.ops,
        connection: {
          adapterType: connection.adapterType,
          baseUrl: connection.baseUrl,
          authType: connection.authType,
          authConfig: connection.authConfig,
          credentialScope: connection.credentialScope,
        },
      },
    };
  }

  // DEV_NOTE: The change request's status from how its commit's host call ended. A resume that couldn't even be sent
  // (attempts 0) proves nothing about the earlier attempt, so it can't end Failed either.
  private static commitEnd(
    hostCall: Schemas.FinishCommitRequest["hostCall"],
    isResume: boolean,
  ): { status: Schemas.ChangeRequestStatusIntEnum; errorCode: string | null } {
    switch (hostCall.outcome) {
      case Schemas.HostCallOutcomeEnum.Succeeded:
      case Schemas.HostCallOutcomeEnum.AlreadyApplied:
        return { status: Schemas.ChangeRequestStatusIntEnum.Committed, errorCode: null };
      case Schemas.HostCallOutcomeEnum.Unknown:
        return {
          status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
          errorCode: Schemas.ToolCallErrorCodeEnum.HostUnknown,
        };
      default: {
        const errorCode =
          hostCall.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded
            ? Schemas.ToolCallErrorCodeEnum.TokenNeeded
            : hostCall.outcome === Schemas.HostCallOutcomeEnum.TokenRejected
              ? Schemas.ToolCallErrorCodeEnum.TokenRejected
              : hostCall.outcome === Schemas.HostCallOutcomeEnum.Refused
                ? Schemas.ToolCallErrorCodeEnum.HostRefused
                : Schemas.ToolCallErrorCodeEnum.HostFailed;
        const mayHaveLanded =
          hostCall.mayHaveLanded === true || (isResume && (hostCall.attempts ?? 0) === 0);
        return {
          status: mayHaveLanded
            ? Schemas.ChangeRequestStatusIntEnum.NeedsHuman
            : Schemas.ChangeRequestStatusIntEnum.Failed,
          errorCode,
        };
      }
    }
  }

  private static toView(
    row: Schemas.ChangeRequestRow,
    payload: Schemas.ChangeRequestPayload | null,
  ): Schemas.WidgetChangeRequest {
    const kind =
      payload?.kind ??
      (row.toolRisk === Schemas.ToolDefinitionRiskIntEnum.Destructive
        ? Schemas.ChangeRequestKindEnum.Delete
        : Schemas.ChangeRequestKindEnum.Update);
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
      expiresAt: isProposed
        ? row.createdAt.getTime() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS
        : null,
      isUndoable: row.isUndoable,
    };
  }

  // DEV_NOTE: The conversation open and its company and chatbot active (and, for a host write, the company not
  // read-only), re-checked on every step
  private async checkConversation(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
    isHostWrite: boolean,
  ): Promise<Schemas.ChangeRequestConversationCheck> {
    const conversation = await this.conversationsDal.getConversationDetails(tx, {
      companyId: session.companyId,
      publicId: session.conversationPublicId,
    });
    if (!conversation.isSuccess || !conversation.conversation) {
      return {
        isSuccess: false,
        failure: conversation.isNotFound
          ? Schemas.ChangeRequestFailureEnum.ConversationClosed
          : Schemas.ChangeRequestFailureEnum.ServerError,
        message: conversation.message,
      };
    }
    if (conversation.conversation.status !== Schemas.ConversationStatusIntEnum.Open) {
      return {
        isSuccess: false,
        failure: Schemas.ChangeRequestFailureEnum.ConversationClosed,
        message: "Conversation is closed",
      };
    }

    const company = await this.companiesDal.getCompanyDetails(tx, { companyId: session.companyId });
    const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
      companyId: session.companyId,
      publicId: session.chatbotPublicId,
    });
    if (!company.isSuccess || !chatbot.isSuccess || !company.company || !chatbot.chatbot) {
      return {
        isSuccess: false,
        failure: chatbot.isNotFound
          ? Schemas.ChangeRequestFailureEnum.ChatbotUnavailable
          : Schemas.ChangeRequestFailureEnum.ServerError,
        message: company.message ?? chatbot.message,
      };
    }
    if (
      company.company.status !== Schemas.CompanyStatusIntEnum.Active ||
      chatbot.chatbot.status !== Schemas.ChatbotStatusIntEnum.Active
    ) {
      return {
        isSuccess: false,
        failure: Schemas.ChangeRequestFailureEnum.ChatbotUnavailable,
        message: "Chatbot or company is not active",
      };
    }
    if (isHostWrite && company.company.isReadOnly) {
      return {
        isSuccess: false,
        failure: Schemas.ChangeRequestFailureEnum.ReadOnly,
        message: "Company is read-only",
      };
    }
    return {
      isSuccess: true,
      rootLogId: conversation.conversation.rootLogId,
      isReadOnly: company.company.isReadOnly,
    };
  }

  private async findRootLogId(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
  ): Promise<string | null> {
    const conversation = await this.conversationsDal.getConversationDetails(tx, {
      companyId: session.companyId,
      publicId: session.conversationPublicId,
    });
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
    session: Schemas.ConversationSession,
    row: Schemas.ChangeRequestRow,
  ): Promise<Schemas.ChangeRequestStepResponse> {
    AppLogger.warn({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.UpdateChangeRequestStatus,
      message: "Change request not in a status this step starts from",
      metadata: {
        companyId: session.companyId,
        changeRequestPublicId: row.publicId,
        status: row.status,
      },
    });
    return {
      isSuccess: false,
      message: "Change request not in a status this step starts from",
      failure: Schemas.ChangeRequestFailureEnum.InvalidTransition,
      changeRequest: ActionEngineRepo.toView(row, await this.decryptPayload(tx, row)),
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
      errorCode?: string | null;
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
    if (!row.encryptedChanges || !row.iv || row.encryptionKeyVersion === null) return null;
    const decrypted = await CompanyKeyProvider.decryptValue(this.env, tx, {
      companyId: row.companyId,
      column: Schemas.EncryptedColumnEnum.ChangeRequestChanges,
      encryptedValue: { ciphertext: row.encryptedChanges, iv: row.iv },
      encryptionKeyVersion: row.encryptionKeyVersion,
    });
    if (!decrypted.isSuccess || decrypted.plaintext === undefined) return null;
    const parsed = Schemas.ZChangeRequestPayload.safeParse(Utility.parseJson(decrypted.plaintext));
    if (!parsed.success) {
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.GetChangeRequestDetails,
        message: "Change request payload doesn't parse",
        metadata: { companyId: row.companyId, changeRequestPublicId: row.publicId },
      });
      return null;
    }
    return parsed.data;
  }
}
