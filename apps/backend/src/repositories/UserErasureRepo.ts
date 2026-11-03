import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotUserSecretsDAL from "@/data-access-layer/ChatbotUserSecretsDAL";
import ChatbotUsersDAL from "@/data-access-layer/ChatbotUsersDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import { recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

// DEV_NOTE: User erasure (M6-2). This transaction is the point of no return: the user's identity and credentials go, with
// the notes on their chats and the audit row, which is on the company and counts chats, so it never says who. Their chats
// follow after the commit (ContentRetentionRepo), since wiping a DO can't sit in a transaction and may have to wait for a
// running turn. The chatbot_users row stays, so anonymous counts keep a user to count.
export default class UserErasureRepo {
  private db: NodePgDatabase;
  private chatbotUsersDal: ChatbotUsersDAL;
  private chatbotUserSecretsDal: ChatbotUserSecretsDAL;
  private companiesDal: CompaniesDAL;
  private conversationsDal: ConversationsDAL;
  private qualityIssuesDal: QualityIssuesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.chatbotUsersDal = new ChatbotUsersDAL();
    this.chatbotUserSecretsDal = new ChatbotUserSecretsDAL();
    this.companiesDal = new CompaniesDAL();
    this.conversationsDal = new ConversationsDAL();
    this.qualityIssuesDal = new QualityIssuesDAL();
  }

  async eraseUser(
    params: Schemas.EraseChatbotUserApiRequest & {
      companyId: string;
      adminId: string;
      actor: Schemas.AuditActor;
    },
  ): Promise<Schemas.EraseChatbotUserRepoResponse> {
    const { companyId, hostUserId } = params;
    return await withTenant<Schemas.EraseChatbotUserRepoResponse>(
      this.db,
      companyId,
      async (tx) => {
        const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
        if (!company.isSuccess || !company.company) {
          return { isSuccess: false, message: company.message, isNotFound: company.isNotFound };
        }

        const erased = await this.chatbotUsersDal.eraseChatbotUser(tx, { companyId, hostUserId });
        if (!erased.isSuccess || !erased.chatbotUser) {
          return { isSuccess: false, message: erased.message, isNotFound: erased.isNotFound };
        }
        const content = { companyId, chatbotUserId: erased.chatbotUser.id };

        const counted = await this.conversationsDal.getUserConversationsCount(tx, content);
        const conversationCount = counted.totalRecords;
        if (!counted.isSuccess || conversationCount === undefined) {
          throw new TenantRollbackError(counted.message);
        }
        const secrets = await this.chatbotUserSecretsDal.deleteChatbotUserSecrets(tx, content);
        if (!secrets.isSuccess) throw new TenantRollbackError(secrets.message);
        const notes = await this.qualityIssuesDal.clearChatbotUserNotes(tx, content);
        if (!notes.isSuccess) throw new TenantRollbackError(notes.message);

        const outboxId = await recordAuditOrRollback(tx, {
          companyId,
          actor: params.actor,
          entityType: Schemas.AuditEntityTypeEnum.Company,
          entityAction: Schemas.AuditEntityActionEnum.UserErased,
          entity: company.company,
          label: `${conversationCount} ${conversationCount === 1 ? "chat" : "chats"}`,
        });
        return {
          isSuccess: true,
          message: "User erased",
          conversationCount,
          chatbotUserId: content.chatbotUserId,
          outboxIds: [outboxId],
        };
      },
    );
  }
}
