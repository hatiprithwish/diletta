import { and, countDistinct, desc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { docGaps, messages } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: The columns but the embedding, which only the clustering writes
const GAP_COLUMNS = {
  id: docGaps.id,
  publicId: docGaps.publicId,
  companyId: docGaps.companyId,
  chatbotId: docGaps.chatbotId,
  conversationId: docGaps.conversationId,
  messageId: docGaps.messageId,
  questionGeneric: docGaps.questionGeneric,
  signal: docGaps.signal,
  clusterId: docGaps.clusterId,
  createdAt: docGaps.createdAt,
  updatedAt: docGaps.updatedAt,
};

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). The questions the assistant couldn't answer, as the
// clustering writes them (M5-6). Question text and embeddings are never logged.
export default class DocGapsDAL {
  async createDocGap(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateDocGapDALRequest,
  ) {
    const response: Schemas.DocGapDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      chatbotId: params.chatbotId,
      messageId: params.messageId,
      clusterId: params.clusterId,
    };

    try {
      const [created] = await tx
        .insert(docGaps)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          conversationId: params.conversationId,
          messageId: params.messageId,
          questionGeneric: params.questionGeneric,
          signal: params.signal,
          embedding: params.embedding,
          clusterId: params.clusterId,
        })
        .returning(GAP_COLUMNS);

      response.isSuccess = true;
      response.message = "Doc gap created successfully";
      response.docGap = created;
    } catch (error) {
      const message = "Unknown error in creating doc gap";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateDocGap,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The message's gap, how the consumer dedupes a redelivered event. isSuccess with no docGap = none yet.
  async getDocGapByMessage(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetDocGapByMessageDALRequest,
  ) {
    const response: Schemas.DocGapDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(docGaps.companyId, params.companyId),
        eq(docGaps.messageId, params.messageId),
      ];
      const [found] = await tx
        .select(GAP_COLUMNS)
        .from(docGaps)
        .where(and(...conditions))
        .limit(1);

      response.isSuccess = true;
      response.message = found ? "Doc gap fetched successfully" : "The message has no doc gap";
      response.docGap = found;
    } catch (error) {
      const message = "Unknown error in fetching doc gap";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDocGapByMessage,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: How many conversations a group's questions came from (a purged gap has none and isn't counted)
  async countDocGapConversations(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountDocGapConversationsDALRequest,
  ) {
    const response: Schemas.DocGapConversationCountDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(docGaps.companyId, params.companyId),
        eq(docGaps.clusterId, params.clusterId),
      ];
      const [counted] = await tx
        .select({ conversationCount: countDistinct(docGaps.conversationId) })
        .from(docGaps)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Doc gap conversations counted successfully";
      response.conversationCount = counted?.conversationCount ?? 0;
    } catch (error) {
      const message = "Unknown error in counting doc gap conversations";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountDocGapConversations,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Whether the conversation's last user message went unanswered, as a closing conversation's outcome asks
  async hasDocGapOnLastUserMessage(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.HasDocGapOnLastUserMessageDALRequest,
  ) {
    const response: Schemas.HasDocGapDALResponse = { isSuccess: false };

    try {
      const messageConditions = [
        eq(messages.companyId, params.companyId),
        eq(messages.conversationId, params.conversationId),
        eq(messages.role, Schemas.MessageRoleIntEnum.User),
      ];
      const [last] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(...messageConditions))
        .orderBy(desc(messages.id))
        .limit(1);
      if (!last) {
        response.isSuccess = true;
        response.message = "The conversation has no user message";
        response.hasDocGap = false;
        return response;
      }

      const conditions = [eq(docGaps.companyId, params.companyId), eq(docGaps.messageId, last.id)];
      const [gap] = await tx
        .select({ id: docGaps.id })
        .from(docGaps)
        .where(and(...conditions))
        .limit(1);

      response.isSuccess = true;
      response.message = "Doc gap on last user message checked successfully";
      response.hasDocGap = gap !== undefined;
    } catch (error) {
      const message = "Unknown error in checking doc gap on last user message";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.HasDocGapOnLastUserMessage,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
