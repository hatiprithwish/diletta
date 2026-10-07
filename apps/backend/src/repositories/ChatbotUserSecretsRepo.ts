import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotUserSecretsDAL from "@/data-access-layer/ChatbotUserSecretsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId, chatbotUserId and connectionId are internal ids, resolved server-side; never from the client. The
// credential object is serialized and encrypted under the company's active key before the DAL sees it; only
// getDecryptedChatbotUserSecret returns it, to the AuthStrategy (M3-2), never in a route response.
// Deleting a chatbot user's secrets is part of user erasure (M6-2).
export default class ChatbotUserSecretsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: ChatbotUserSecretsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new ChatbotUserSecretsDAL();
  }

  private withStatusLabel(
    chatbotUserSecret: Schemas.ChatbotUserSecret,
  ): Schemas.ChatbotUserSecretWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      chatbotUserId: _chatbotUserId,
      connectionId: _connectionId,
      encryptedSecret: _encryptedSecret,
      iv: _iv,
      encryptionKeyVersion: _encryptionKeyVersion,
      ...rest
    } = chatbotUserSecret;
    return {
      ...rest,
      chatbotUserSecretStatus: chatbotUserSecret.status,
      chatbotUserSecretStatusLabel:
        Schemas.CHATBOT_USER_SECRET_STATUS_LABEL_MAP[chatbotUserSecret.status],
    };
  }

  private withChatbotUserSecretResponse(
    result: Schemas.ChatbotUserSecretDALResponse,
  ): Schemas.GetChatbotUserSecretApiResponse {
    const { chatbotUserSecret, ...rest } = result;
    return {
      ...rest,
      chatbotUserSecret: chatbotUserSecret ? this.withStatusLabel(chatbotUserSecret) : undefined,
    };
  }

  async createChatbotUserSecret(
    params: Schemas.CreateChatbotUserSecretApiRequest & {
      companyId: string;
      chatbotUserId: string;
      connectionId: string;
    },
  ): Promise<Schemas.CreateChatbotUserSecretApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { chatbotUserSecret } = params;
      const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
        companyId: params.companyId,
        column: Schemas.EncryptedColumnEnum.ChatbotUserSecret,
        plaintext: JSON.stringify(chatbotUserSecret.secret),
      });
      if (
        !encrypted.isSuccess ||
        !encrypted.encryptedValue ||
        encrypted.encryptionKeyVersion === undefined
      ) {
        return { isSuccess: false, message: encrypted.message };
      }

      const result = await this.dal.createChatbotUserSecret(tx, {
        companyId: params.companyId,
        chatbotUserId: params.chatbotUserId,
        connectionId: params.connectionId,
        encryptedSecret: encrypted.encryptedValue.ciphertext,
        iv: encrypted.encryptedValue.iv,
        encryptionKeyVersion: encrypted.encryptionKeyVersion,
        scopes: chatbotUserSecret.scopes ?? null,
        expiresAt: chatbotUserSecret.expiresAt ?? null,
      });
      return this.withChatbotUserSecretResponse(result);
    });
  }

  async getChatbotUserSecretDetails(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetChatbotUserSecretApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getChatbotUserSecretDetails(tx, params);
      return this.withChatbotUserSecretResponse(result);
    });
  }

  async getChatbotUserSecrets(params: {
    companyId: string;
    chatbotUserId: string;
  }): Promise<Schemas.GetChatbotUserSecretsApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { chatbotUserSecrets, ...rest } = await this.dal.getChatbotUserSecrets(tx, params);
      return {
        ...rest,
        chatbotUserSecrets: chatbotUserSecrets?.map((chatbotUserSecret) =>
          this.withStatusLabel(chatbotUserSecret),
        ),
      };
    });
  }

  // DEV_NOTE: A new credential overwrites the row under the company's active key (and its version)
  async updateChatbotUserSecret(
    params: Schemas.UpdateChatbotUserSecretApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.UpdateChatbotUserSecretApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { chatbotUserSecret } = params;
      let encryptedValue: Schemas.EncryptedValue | null = null;
      let encryptionKeyVersion: number | null = null;

      if (chatbotUserSecret.secret !== undefined) {
        const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
          companyId: params.companyId,
          column: Schemas.EncryptedColumnEnum.ChatbotUserSecret,
          plaintext: JSON.stringify(chatbotUserSecret.secret),
        });
        if (
          !encrypted.isSuccess ||
          !encrypted.encryptedValue ||
          encrypted.encryptionKeyVersion === undefined
        ) {
          return { isSuccess: false, message: encrypted.message };
        }
        encryptedValue = encrypted.encryptedValue;
        encryptionKeyVersion = encrypted.encryptionKeyVersion;
      }

      const result = await this.dal.updateChatbotUserSecret(tx, {
        companyId: params.companyId,
        publicId: params.publicId,
        encryptedSecret: encryptedValue?.ciphertext ?? null,
        iv: encryptedValue?.iv ?? null,
        encryptionKeyVersion,
        scopes: chatbotUserSecret.scopes ?? null,
        expiresAt: chatbotUserSecret.expiresAt ?? null,
        status: chatbotUserSecret.status ?? null,
      });
      return this.withChatbotUserSecretResponse(result);
    });
  }

  // DEV_NOTE: Server-side only. Decrypts with the row's own encryption_key_version, then checks the JSON shape.
  // Never return this response from a route.
  async getDecryptedChatbotUserSecret(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.DecryptedChatbotUserSecretResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getChatbotUserSecretDetails(tx, params);
      if (!result.isSuccess || !result.chatbotUserSecret) {
        return { isSuccess: false, message: result.message };
      }

      const { chatbotUserSecret } = result;
      const decrypted = await CompanyKeyProvider.decryptValue(this.env, tx, {
        companyId: params.companyId,
        column: Schemas.EncryptedColumnEnum.ChatbotUserSecret,
        encryptedValue: { ciphertext: chatbotUserSecret.encryptedSecret, iv: chatbotUserSecret.iv },
        encryptionKeyVersion: chatbotUserSecret.encryptionKeyVersion,
      });
      if (!decrypted.isSuccess || decrypted.plaintext === undefined) {
        return { isSuccess: false, message: decrypted.message };
      }

      const parsed = this.parseSecret(decrypted.plaintext);
      if (!parsed) {
        return { isSuccess: false, message: "Chatbot user secret is malformed" };
      }

      return {
        isSuccess: true,
        message: "Chatbot user secret decrypted successfully",
        secret: parsed,
      };
    });
  }

  // DEV_NOTE: The plaintext was written by JSON.stringify above, so this only fails on a corrupted row
  private parseSecret(plaintext: string): Schemas.ChatbotUserSecretValue | null {
    try {
      const parsed = Schemas.ZChatbotUserSecretValue.safeParse(JSON.parse(plaintext));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
