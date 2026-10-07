import type { NullableDALFields } from "../common";
import type { ChatbotUserSecret } from "./ChatbotUserSecretsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The secret arrives already encrypted by the Repo; plaintext never reaches the DAL. type is read from the connection.
export type CreateChatbotUserSecretDALRequest = Pick<
  ChatbotUserSecret,
  "companyId" | "chatbotUserId" | "connectionId" | "encryptionKeyVersion" | "scopes" | "expiresAt"
> & { encryptedSecret: Uint8Array; iv: Uint8Array };

// Params to find a chatbot user secret by its public ID within one company
export type FindChatbotUserSecretDALRequest = Pick<ChatbotUserSecret, "publicId" | "companyId">;

export type GetChatbotUserSecretsDALRequest = Pick<
  ChatbotUserSecret,
  "companyId" | "chatbotUserId"
>;

// DEV_NOTE: A new value replaces encryptedSecret, iv and encryptionKeyVersion together. updatedAt is set by the DAL.
export type UpdateChatbotUserSecretDALRequest = FindChatbotUserSecretDALRequest &
  NullableDALFields<
    Pick<ChatbotUserSecret, "encryptionKeyVersion" | "scopes" | "expiresAt" | "status"> & {
      encryptedSecret: Uint8Array;
      iv: Uint8Array;
    }
  >;
