import { and, asc, eq, isNull } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotUserSecrets, chatbotUsers, companyConnections } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: One credential per chatbot user and connection
const CHATBOT_USER_CONNECTION_INDEX = "UNQ_chatbot_user_secrets_chatbot_user_id_connection_id";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). The secret arrives already encrypted
// by the Repo and leaves encrypted; ciphertext and iv never go into log metadata.
export default class ChatbotUserSecretsDAL {
  async createChatbotUserSecret(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateChatbotUserSecretDALRequest,
  ) {
    const response: Schemas.ChatbotUserSecretDALResponse = { isSuccess: false };
    const { encryptedSecret: _encryptedSecret, iv: _iv, ...metadata } = params;

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing. An erased chatbot user
      // keeps its row (erased_at set) but must not get a new credential.
      const chatbotUserConditions = [
        eq(chatbotUsers.id, params.chatbotUserId),
        eq(chatbotUsers.companyId, params.companyId),
        isNull(chatbotUsers.erasedAt),
      ];
      const [chatbotUser] = await tx
        .select({ id: chatbotUsers.id })
        .from(chatbotUsers)
        .where(and(...chatbotUserConditions))
        .limit(1);

      if (!chatbotUser) {
        const message = "Chatbot user not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateChatbotUserSecret,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      // DEV_NOTE: type is the connection's auth_type, read here so the two can't disagree
      const connectionConditions = [
        eq(companyConnections.id, params.connectionId),
        eq(companyConnections.companyId, params.companyId),
      ];
      const [connection] = await tx
        .select({
          authType: companyConnections.authType,
          credentialScope: companyConnections.credentialScope,
        })
        .from(companyConnections)
        .where(and(...connectionConditions))
        .limit(1);

      if (!connection) {
        const message = "Company connection not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateChatbotUserSecret,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      // DEV_NOTE: Only a connection scoped to chatbot users takes a per-user credential (credential_scope)
      if (
        connection.credentialScope !== Schemas.CompanyConnectionCredentialScopeIntEnum.ChatbotUser
      ) {
        const message = "Connection doesn't take chatbot user secrets";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateChatbotUserSecret,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [chatbotUserSecretResponse] = await tx
        .insert(chatbotUserSecrets)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotUserId: params.chatbotUserId,
          connectionId: params.connectionId,
          type: connection.authType,
          encryptedSecret: Buffer.from(params.encryptedSecret),
          iv: Buffer.from(params.iv),
          encryptionKeyVersion: params.encryptionKeyVersion,
          scopes: params.scopes,
          expiresAt: params.expiresAt,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Chatbot user secret created successfully";
      response.chatbotUserSecret = chatbotUserSecretResponse;
    } catch (error) {
      const message = Utility.isUniqueViolation(error, CHATBOT_USER_CONNECTION_INDEX)
        ? "Secret already exists for this chatbot user and connection"
        : "Unknown error in creating chatbot user secret";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateChatbotUserSecret,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotUserSecretDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindChatbotUserSecretDALRequest,
  ) {
    const response: Schemas.ChatbotUserSecretDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotUserSecrets.publicId, params.publicId),
        eq(chatbotUserSecrets.companyId, params.companyId),
      ];
      const [chatbotUserSecret] = await tx
        .select()
        .from(chatbotUserSecrets)
        .where(and(...conditions))
        .limit(1);

      if (!chatbotUserSecret) {
        const message = "Chatbot user secret not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetChatbotUserSecretDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot user secret fetched successfully";
      response.chatbotUserSecret = chatbotUserSecret;
    } catch (error) {
      const message = "Unknown error in fetching chatbot user secret";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotUserSecretDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Not paged: one row per connection for a chatbot user, so a handful at most
  async getChatbotUserSecrets(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotUserSecretsDALRequest,
  ) {
    const response: Schemas.ChatbotUserSecretsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotUserSecrets.chatbotUserId, params.chatbotUserId),
        eq(chatbotUserSecrets.companyId, params.companyId),
      ];
      const chatbotUserSecretsResponse = await tx
        .select()
        .from(chatbotUserSecrets)
        .where(and(...conditions))
        .orderBy(asc(chatbotUserSecrets.createdAt), asc(chatbotUserSecrets.id));

      response.isSuccess = true;
      response.message = "Chatbot user secrets fetched successfully";
      response.chatbotUserSecrets = chatbotUserSecretsResponse;
    } catch (error) {
      const message = "Unknown error in listing chatbot user secrets";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListChatbotUserSecrets,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateChatbotUserSecret(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateChatbotUserSecretDALRequest,
  ) {
    const response: Schemas.ChatbotUserSecretDALResponse = { isSuccess: false };
    const { encryptedSecret: _encryptedSecret, iv: _iv, ...metadata } = params;

    try {
      const conditions = [
        eq(chatbotUserSecrets.publicId, params.publicId),
        eq(chatbotUserSecrets.companyId, params.companyId),
      ];
      const [chatbotUserSecretResponse] = await tx
        .update(chatbotUserSecrets)
        .set({
          // DEV_NOTE: When a param is null, it's ignored. A new value (refresh, re-auth) overwrites the row.
          encryptedSecret: params.encryptedSecret ? Buffer.from(params.encryptedSecret) : undefined,
          iv: params.iv ? Buffer.from(params.iv) : undefined,
          encryptionKeyVersion: params.encryptionKeyVersion ?? undefined,
          scopes: params.scopes ?? undefined,
          expiresAt: params.expiresAt ?? undefined,
          status: params.status ?? undefined,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!chatbotUserSecretResponse) {
        const message = "Chatbot user secret not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateChatbotUserSecret,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot user secret updated successfully";
      response.chatbotUserSecret = chatbotUserSecretResponse;
    } catch (error) {
      const message = "Unknown error in updating chatbot user secret";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateChatbotUserSecret,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }
}
