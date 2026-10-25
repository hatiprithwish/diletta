import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import QualityIssuesProvider from "@/providers/qualityIssues";
import QualityTestRewriteProvider from "@/providers/qualityTestRewrite";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: What a write's transaction committed (the route relays outboxId); the answer is read after the commit
type QualityIssueWrite = Schemas.UpdateQualityIssueResponse;

// DEV_NOTE: What Create test needs from the database, read in one withTenant before the model call (which runs outside
// any transaction)
type DraftInputs =
  | {
      isSuccess: true;
      source: Schemas.QualityTestRewriteSource;
      chatbotId: string;
      routing: Schemas.ConfigSpec["routing"];
    }
  | Schemas.DraftQualityTestApiResponse;

// DEV_NOTE: Tenant Repo — quality issues as the dashboard works them. M4-4: flag a conversation into the inbox. M4-6:
// the Quality list with its tab counts, one issue with its excerpt, the sidebar's open count, triage (type + note),
// Mark fixed and Dismiss, and Create test: a draft rewritten without personal details (model router, nothing saved),
// then the reviewed draft saved as an eval case with the issue Converted. Every write starts from Open, under the
// issue's row lock, and ends it for good (no reopen); each records its quality_issue.<action> critical event (actor
// the admin) in the same withTenant, and the event failing rolls the write back (TenantRollbackError).
export default class QualityIssuesRepo {
  private env: Env;
  private db: NodePgDatabase;
  private conversationsDal: ConversationsDAL;
  private qualityIssuesDal: QualityIssuesDAL;
  private chatbotsDal: ChatbotsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private messagesDal: MessagesDAL;
  private evalCasesDal: EvalCasesDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.conversationsDal = new ConversationsDAL();
    this.qualityIssuesDal = new QualityIssuesDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.messagesDal = new MessagesDAL();
    this.evalCasesDal = new EvalCasesDAL();
  }

  // DEV_NOTE: Status Enum Pattern — source, status and type each as int + label. A purged conversation's title and
  // rated reply stay out.
  private toListItem(row: Schemas.DashboardQualityIssueRow): Schemas.QualityIssueListItem {
    const isPurged = row.conversationContentPurgedAt !== null;
    return {
      publicId: row.publicId,
      source: row.source,
      sourceLabel: Schemas.QUALITY_ISSUE_SOURCE_LABEL_MAP[row.source],
      qualityIssueStatus: row.status,
      qualityIssueStatusLabel: Schemas.QUALITY_ISSUE_STATUS_LABEL_MAP[row.status],
      issueType: row.issueType,
      issueTypeLabel:
        row.issueType === null ? null : Schemas.QUALITY_ISSUE_TYPE_LABEL_MAP[row.issueType],
      note: row.note,
      ratedReply: isPurged ? null : QualityIssuesProvider.ratedReply(row.ratedReplyText),
      conversation: {
        publicId: row.conversationPublicId,
        title: isPurged ? null : row.conversationTitle,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetail(
    row: Schemas.DashboardQualityIssueRow,
    excerpt: Schemas.QualityIssueExcerptMessage[],
  ): Schemas.QualityIssueDetail {
    const item = this.toListItem(row);
    return {
      ...item,
      rating: row.rating,
      excerpt,
      isContentPurged: row.conversationContentPurgedAt !== null,
      conversation: {
        ...item.conversation,
        chatbotName: row.chatbotName,
        userName: row.userName,
      },
      changeRequestPublicId: row.changeRequestPublicId,
      evalCase:
        row.evalCasePublicId !== null && row.evalCaseName !== null
          ? { publicId: row.evalCasePublicId, name: row.evalCaseName }
          : null,
    };
  }

  // DEV_NOTE: A prompt-injection event on the Security page (M4-9): the admin's note says where it was found, else the
  // issue's source; a purged conversation's title stays out
  private toInjectionEvent(row: Schemas.DashboardQualityIssueRow): Schemas.InjectionEvent {
    return {
      publicId: row.publicId,
      conversationPublicId: row.conversationPublicId,
      conversationTitle: row.conversationContentPurgedAt === null ? row.conversationTitle : null,
      detectedIn: row.note ?? Schemas.QUALITY_ISSUE_SOURCE_LABEL_MAP[row.source],
      status: row.status,
      statusLabel: Schemas.QUALITY_ISSUE_STATUS_LABEL_MAP[row.status],
      actionLabel: Schemas.INJECTION_EVENT_ACTION_LABEL_MAP[row.status],
      createdAt: row.createdAt.toISOString(),
    };
  }

  // DEV_NOTE: The Security page's prompt-injection events (M4-9): issues typed Prompt injection, any status, newest first.
  // M6-4 adds the automatic detections.
  async getInjectionEvents(
    params: Schemas.GetInjectionEventsApiRequest & { companyId: string },
  ): Promise<Schemas.GetInjectionEventsApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetInjectionEventsApiResponse> => {
        const { qualityIssues, ...rest } = await this.qualityIssuesDal.getInjectionQualityIssues(
          tx,
          {
            companyId: params.companyId,
            pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
            pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
            sortColumn: params.sortColumn ?? Schemas.InjectionEventSortColumn.CreatedAt,
            sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
          },
        );
        return {
          ...rest,
          injectionEvents: qualityIssues?.map((row) => this.toInjectionEvent(row)),
        };
      },
    );
  }

  async getInjectionEventsCount(params: {
    companyId: string;
  }): Promise<Schemas.GetInjectionEventsCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.qualityIssuesDal.getInjectionQualityIssuesCount(tx, params);
    });
  }

  async getQualityIssues(
    params: Schemas.GetQualityIssuesApiRequest & { companyId: string },
  ): Promise<Schemas.GetQualityIssuesApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetQualityIssuesApiResponse> => {
        let chatbotId: string | null = null;
        if (params.botId !== undefined) {
          const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
            companyId,
            publicId: params.botId,
          });
          if (!chatbot.isSuccess || !chatbot.chatbot) {
            return { isSuccess: false, message: chatbot.message, isNotFound: chatbot.isNotFound };
          }
          chatbotId = chatbot.chatbot.id;
        }
        const tab = params.tab ?? Schemas.QualityIssueListTabEnum.Open;

        const page = await this.qualityIssuesDal.getDashboardQualityIssues(tx, {
          companyId,
          tab,
          chatbotId,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.QualityIssueSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess) return { isSuccess: false, message: page.message };

        const counted = await this.qualityIssuesDal.getDashboardQualityIssuesCount(tx, {
          companyId,
          chatbotId,
        });
        if (!counted.isSuccess || !counted.tabCounts) {
          return { isSuccess: false, message: counted.message };
        }
        const { tabCounts } = counted;

        return {
          isSuccess: true,
          message: "Quality issues fetched successfully",
          qualityIssues: (page.qualityIssues ?? []).map((row) => this.toListItem(row)),
          totalRecords: tabCounts[tab],
          tabCounts,
        };
      },
    );
  }

  // DEV_NOTE: The sidebar's Quality badge: the company's open issues now
  async getOpenCount(params: {
    companyId: string;
  }): Promise<Schemas.GetQualityIssuesOpenCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const counted = await this.qualityIssuesDal.getOpenQualityIssueCounts(tx, {
        companyId: params.companyId,
        chatbotId: null,
      });
      if (!counted.isSuccess) return { isSuccess: false, message: counted.message };
      return {
        isSuccess: true,
        message: "Open quality issues counted successfully",
        openCount: counted.totalCount ?? 0,
      };
    });
  }

  async getQualityIssue(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetQualityIssueApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const found = await this.qualityIssuesDal.getDashboardQualityIssue(tx, params);
      if (!found.isSuccess || !found.qualityIssue) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }
      return await this.withExcerpt(tx, params.companyId, found.qualityIssue);
    });
  }

  // DEV_NOTE: Sets the issue's type and / or note (null clears). Only while Open (else failure NotOpen, 409, nothing
  // written); quality_issue.triaged records the type, never the note (free text).
  async triageQualityIssue(
    params: Schemas.TriageQualityIssueRequest,
  ): Promise<Schemas.UpdateQualityIssueResponse> {
    const { companyId } = params;
    const written = await withTenant(this.db, companyId, async (tx): Promise<QualityIssueWrite> => {
      const open = await this.lockOpenIssue(tx, params);
      if (!open.isSuccess) return open.response;
      const { row } = open;

      const triaged = await this.qualityIssuesDal.triageQualityIssue(tx, {
        companyId,
        id: row.id,
        issueType: params.issueType,
        note: params.note,
        updatedBy: params.adminId,
      });
      if (!triaged.isSuccess || !triaged.qualityIssue) {
        throw new TenantRollbackError(triaged.message ?? "Quality issue not triaged");
      }
      const { qualityIssue } = triaged;

      const outboxId = await this.recordEvent(tx, params, row, {
        action: Schemas.QualityIssueEntityActionEnum.Triaged,
        detail: { issueType: qualityIssue.issueType, hasNote: qualityIssue.note !== null },
        dedupeParts: [qualityIssue.updatedAt.toISOString()],
      });
      return { isSuccess: true, message: "Quality issue triaged", outboxId };
    });
    return await this.answerWrite(written, params, Schemas.LogAction.TriageQualityIssue);
  }

  // DEV_NOTE: Mark fixed / Dismiss: Open → Fixed / Dismissed, else failure NotOpen (409, nothing written)
  async closeQualityIssue(
    params: Schemas.CloseQualityIssueRequest,
  ): Promise<Schemas.UpdateQualityIssueResponse> {
    const { companyId } = params;
    const written = await withTenant(this.db, companyId, async (tx): Promise<QualityIssueWrite> => {
      const open = await this.lockOpenIssue(tx, params);
      if (!open.isSuccess) return open.response;
      const { row } = open;

      const updated = await this.qualityIssuesDal.updateQualityIssueStatus(tx, {
        companyId,
        id: row.id,
        status: params.status,
        evalCaseId: null,
        updatedBy: params.adminId,
      });
      if (!updated.isSuccess || !updated.qualityIssue) {
        throw new TenantRollbackError(updated.message ?? "Quality issue not closed");
      }

      const outboxId = await this.recordEvent(tx, params, row, {
        action: Schemas.QUALITY_ISSUE_CLOSE_ENTITY_ACTION_MAP[params.status],
        detail: { status: params.status, issueType: row.issueType },
        dedupeParts: [],
      });
      return { isSuccess: true, message: "Quality issue closed", outboxId };
    });
    return await this.answerWrite(written, params, Schemas.LogAction.CloseQualityIssue);
  }

  // DEV_NOTE: Create test, step 1: a draft to review, saved nowhere. One read-only withTenant (the issue Open, its
  // conversation's messages, the chatbot's published config), then the model call outside it: the conversation's
  // chatbot routing at tier Mid, taskType QualityTestRewrite, on the company's key with the budget held. The call is
  // the chatbot's, not the conversation's (conversationId null), so it never adds to the conversation's cost.
  async draftQualityTest(
    params: Omit<Schemas.QualityIssueActionRequest, "adminId">,
    ctx: Pick<ExecutionContext, "waitUntil">,
  ): Promise<Schemas.DraftQualityTestApiResponse> {
    const { companyId } = params;
    const inputs = await withTenant(this.db, companyId, async (tx): Promise<DraftInputs> => {
      const found = await this.qualityIssuesDal.getDashboardQualityIssue(tx, params);
      if (!found.isSuccess || !found.qualityIssue) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }
      const row = found.qualityIssue;
      const refuse = (failure: Schemas.QualityTestDraftFailureEnum, message: string) => ({
        isSuccess: false as const,
        message,
        failure,
      });
      if (row.status !== Schemas.QualityIssueStatusIntEnum.Open) {
        return refuse(
          Schemas.QualityTestDraftFailureEnum.NotOpen,
          "Only an open issue can become a test",
        );
      }
      if (row.conversationContentPurgedAt !== null) {
        return refuse(
          Schemas.QualityTestDraftFailureEnum.NoConversation,
          "The conversation's content was deleted",
        );
      }

      const listed = await this.messagesDal.listRecentChatMessages(tx, {
        companyId,
        conversationId: row.conversationId,
        upToMessageId: row.ratedMessageId,
        limit: QualityIssuesProvider.MESSAGES_READ_LIMIT,
      });
      if (!listed.isSuccess) return { isSuccess: false, message: listed.message };
      const source = QualityIssuesProvider.rewriteSource(
        listed.messages ?? [],
        row.ratedMessageId,
        {
          issueTypeLabel:
            row.issueType === null ? null : Schemas.QUALITY_ISSUE_TYPE_LABEL_MAP[row.issueType],
          note: row.note,
        },
      );
      if (!source) {
        return refuse(
          Schemas.QualityTestDraftFailureEnum.NoConversation,
          "The conversation has no question to test",
        );
      }

      const published = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
        companyId,
        chatbotId: row.chatbotId,
      });
      if (!published.isSuccess || !published.chatbotConfig) {
        return published.isNotFound
          ? refuse(
              Schemas.QualityTestDraftFailureEnum.NoPublishedConfig,
              "The chatbot has no published config",
            )
          : { isSuccess: false, message: published.message };
      }
      const loaded = Schemas.loadConfigSpec({
        schemaVersion: published.chatbotConfig.schemaVersion,
        body: published.chatbotConfig.body,
      });
      if (!loaded.isSuccess || !loaded.spec) {
        return {
          isSuccess: false,
          message: loaded.message ?? "Published config could not be loaded",
        };
      }

      return { isSuccess: true, source, chatbotId: row.chatbotId, routing: loaded.spec.routing };
    });
    if (!inputs.isSuccess || !("source" in inputs)) {
      if ("failure" in inputs && inputs.failure) {
        AppLogger.warn({
          category: Schemas.LogCategory.Repo,
          action: Schemas.LogAction.DraftQualityTest,
          message: inputs.message ?? "No test draft",
          metadata: { companyId, publicId: params.publicId, failure: inputs.failure },
        });
      }
      return inputs;
    }

    const logMetadata = { companyId, publicId: params.publicId };
    const routed = await new ModelRouterRepo(this.env, ctx).getModel({
      companyId,
      chatbotId: inputs.chatbotId,
      chatbotUserId: null,
      conversationId: null,
      evalRunId: null,
      turnId: null,
      taskType: Schemas.ModelTaskTypeEnum.QualityTestRewrite,
      tier: Schemas.ModelTierEnum.Mid,
      routing: inputs.routing,
      caps: null,
    });
    if (!routed.isSuccess) {
      return {
        isSuccess: false,
        message: "The model is unavailable",
        failure: Schemas.QualityTestDraftFailureEnum.ModelUnavailable,
      };
    }

    const rewritten = await QualityTestRewriteProvider.rewrite(
      routed.model,
      inputs.source,
      logMetadata,
    );
    if (!rewritten.isSuccess) {
      return { isSuccess: false, message: "No test draft", failure: rewritten.failure };
    }
    return { isSuccess: true, message: "Test draft written", draft: rewritten.draft };
  }

  // DEV_NOTE: Create test, step 2: the reviewed draft saved as the conversation's chatbot's eval case (input and
  // expectations v1), and the issue Open → Converted with its eval_case_id, in one withTenant. Else failure NotOpen,
  // or ChatbotNotFound when the conversation's chatbot was removed (409, nothing written).
  async convertQualityIssue(
    params: Schemas.ConvertQualityIssueRequest,
  ): Promise<Schemas.UpdateQualityIssueResponse> {
    const { companyId, draft } = params;
    const written = await withTenant(this.db, companyId, async (tx): Promise<QualityIssueWrite> => {
      const open = await this.lockOpenIssue(tx, params);
      if (!open.isSuccess) return open.response;
      const { row } = open;

      const created = await this.evalCasesDal.createEvalCase(tx, {
        companyId,
        chatbotId: row.chatbotId,
        name: draft.name,
        input: {
          schemaVersion: Schemas.EVAL_CASE_INPUT_SCHEMA_VERSION,
          messages: draft.messages,
        },
        expectations: {
          schemaVersion: Schemas.EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
          rubric: draft.rubric,
        },
      });
      // DEV_NOTE: The chatbot was removed: nothing was written yet, so this is a refusal, not a rollback
      if (created.isNotFound) {
        return {
          isSuccess: false,
          message: "The conversation's chatbot no longer exists",
          failure: Schemas.QualityIssueUpdateFailureEnum.ChatbotNotFound,
        };
      }
      if (!created.isSuccess || !created.evalCase) {
        throw new TenantRollbackError(created.message ?? "Eval case not created");
      }

      const updated = await this.qualityIssuesDal.updateQualityIssueStatus(tx, {
        companyId,
        id: row.id,
        status: Schemas.QualityIssueStatusIntEnum.Converted,
        evalCaseId: created.evalCase.id,
        updatedBy: params.adminId,
      });
      if (!updated.isSuccess || !updated.qualityIssue) {
        throw new TenantRollbackError(updated.message ?? "Quality issue not converted");
      }

      const outboxId = await this.recordEvent(tx, params, row, {
        action: Schemas.QualityIssueEntityActionEnum.Converted,
        detail: { evalCaseId: created.evalCase.id, issueType: row.issueType },
        dedupeParts: [],
      });
      return { isSuccess: true, message: "Quality issue converted", outboxId };
    });
    return await this.answerWrite(written, params, Schemas.LogAction.ConvertQualityIssue);
  }

  // DEV_NOTE: One withTenant: the conversation (unknown → 404), its admin issue (Open, untriaged, no note; the open one
  // it already has is returned as it is, isCreated false) and, only when opened now, its quality_issue.opened critical
  // event (actor the admin, under the conversation's root log). The event failing rolls the issue back
  // (TenantRollbackError). The route relays outboxId after the commit.
  async flagConversation(
    params: Schemas.FlagConversationRequest,
  ): Promise<Schemas.FlagConversationResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.FlagConversationResponse> => {
        const conversation = await this.conversationsDal.getConversationDetails(tx, {
          companyId,
          publicId: params.conversationPublicId,
        });
        if (!conversation.isSuccess || !conversation.conversation) {
          return {
            isSuccess: false,
            message: conversation.message,
            isNotFound: conversation.isNotFound,
          };
        }
        const { id: conversationId, rootLogId } = conversation.conversation;

        const issue = await this.qualityIssuesDal.createAdminQualityIssue(tx, {
          companyId,
          conversationId,
          createdBy: params.adminId,
        });
        if (!issue.isSuccess || !issue.qualityIssue) {
          return { isSuccess: false, message: issue.message ?? "Conversation not flagged" };
        }
        const { qualityIssue } = issue;
        if (issue.isCreated === false) {
          return {
            isSuccess: true,
            message: "Conversation already flagged",
            qualityIssuePublicId: qualityIssue.publicId,
            isCreated: false,
          };
        }

        const event = await CriticalEventProvider.record(tx, {
          companyId,
          actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
          actorId: params.adminId,
          entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
          entityId: qualityIssue.id,
          entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
          entityVersion: null,
          parentLogId: rootLogId,
          rootLogId,
          detail: {
            source: Schemas.QualityIssueSourceIntEnum.Admin,
            conversationId,
          },
          eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
          dedupeKey: Schemas.qualityIssueEventDedupeKey(
            Schemas.QualityIssueEntityActionEnum.Opened,
            qualityIssue.publicId,
          ),
        });
        if (!event.isSuccess || !event.outboxId) {
          throw new TenantRollbackError(event.message ?? "Quality issue event not recorded");
        }

        return {
          isSuccess: true,
          message: "Conversation flagged",
          qualityIssuePublicId: qualityIssue.publicId,
          isCreated: true,
          outboxId: event.outboxId,
        };
      },
    );
  }

  // DEV_NOTE: The issue locked (unknown → 404) and checked Open (else failure NotOpen)
  private async lockOpenIssue(
    tx: Tx,
    params: Schemas.QualityIssueActionRequest,
  ): Promise<
    | { isSuccess: true; row: Schemas.DashboardQualityIssueRow }
    | { isSuccess: false; response: QualityIssueWrite }
  > {
    const found = await this.qualityIssuesDal.getDashboardQualityIssue(tx, {
      companyId: params.companyId,
      publicId: params.publicId,
      isForUpdate: true,
    });
    if (!found.isSuccess || !found.qualityIssue) {
      return {
        isSuccess: false,
        response: { isSuccess: false, message: found.message, isNotFound: found.isNotFound },
      };
    }
    if (found.qualityIssue.status !== Schemas.QualityIssueStatusIntEnum.Open) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: "Only an open issue can change",
          failure: Schemas.QualityIssueUpdateFailureEnum.NotOpen,
        },
      };
    }
    return { isSuccess: true, row: found.qualityIssue };
  }

  // DEV_NOTE: The write's quality_issue.<action> critical event: actor the admin, under the conversation's root log.
  // A failure throws TenantRollbackError, so the write rolls back with it.
  private async recordEvent(
    tx: Tx,
    params: Schemas.QualityIssueActionRequest,
    row: Schemas.DashboardQualityIssueRow,
    event: {
      action: Schemas.QualityIssueEntityActionEnum;
      detail: Record<string, unknown>;
      dedupeParts: string[];
    },
  ): Promise<string> {
    const recorded = await CriticalEventProvider.record(tx, {
      companyId: params.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
      actorId: params.adminId,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: row.id,
      entityAction: event.action,
      entityVersion: null,
      parentLogId: row.conversationRootLogId,
      rootLogId: row.conversationRootLogId,
      detail: { conversationId: row.conversationId, ...event.detail },
      eventType: Schemas.qualityIssueEventType(event.action),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        event.action,
        row.publicId,
        ...event.dedupeParts,
      ),
    });
    if (!recorded.isSuccess || !recorded.outboxId) {
      throw new TenantRollbackError(recorded.message ?? "Quality issue event not recorded");
    }
    return recorded.outboxId;
  }

  // DEV_NOTE: A write's answer: a refusal is logged and returned as it is; a committed write answers the issue as it
  // stands, read after the commit on its own (a failed read never undoes the write: the answer then has no issue and
  // the client refetches it)
  private async answerWrite(
    written: QualityIssueWrite,
    params: Schemas.QualityIssueActionRequest,
    action: Schemas.LogAction,
  ): Promise<Schemas.UpdateQualityIssueResponse> {
    const { companyId, publicId } = params;
    if (!written.isSuccess) {
      if (written.failure) {
        AppLogger.warn({
          category: Schemas.LogCategory.Repo,
          action,
          message: "Quality issue not changed",
          metadata: { companyId, publicId, failure: written.failure },
        });
      }
      return written;
    }

    const detail = await this.getQualityIssue({ companyId, publicId });
    if (!detail.isSuccess || !detail.qualityIssue) {
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action,
        message: "Quality issue changed, but it didn't load for the answer",
        metadata: { companyId, publicId, reason: detail.message ?? null },
      });
    }
    return { ...written, qualityIssue: detail.qualityIssue };
  }

  // DEV_NOTE: The detail with its excerpt (QualityIssuesProvider), read in the caller's transaction from the newest
  // messages up to the rated reply (MESSAGES_READ_LIMIT, text only). A purged chat has none (no messages are read).
  private async withExcerpt(
    tx: Tx,
    companyId: string,
    row: Schemas.DashboardQualityIssueRow,
  ): Promise<Schemas.GetQualityIssueApiResponse> {
    if (row.conversationContentPurgedAt !== null) {
      return {
        isSuccess: true,
        message: "Quality issue fetched successfully",
        qualityIssue: this.toDetail(row, []),
      };
    }
    const listed = await this.messagesDal.listRecentChatMessages(tx, {
      companyId,
      conversationId: row.conversationId,
      upToMessageId: row.ratedMessageId,
      limit: QualityIssuesProvider.MESSAGES_READ_LIMIT,
    });
    if (!listed.isSuccess) return { isSuccess: false, message: listed.message };
    return {
      isSuccess: true,
      message: "Quality issue fetched successfully",
      qualityIssue: this.toDetail(
        row,
        QualityIssuesProvider.excerpt(listed.messages ?? [], row.ratedMessageId),
      ),
    };
  }
}
