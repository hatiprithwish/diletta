import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — quality issues an admin opens from the dashboard. M4-4: flag a conversation into the quality
// inbox; triage, tests and closing come with M4-6.
export default class QualityIssuesRepo {
  private db: NodePgDatabase;
  private conversationsDal: ConversationsDAL;
  private qualityIssuesDal: QualityIssuesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.conversationsDal = new ConversationsDAL();
    this.qualityIssuesDal = new QualityIssuesDAL();
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
}
