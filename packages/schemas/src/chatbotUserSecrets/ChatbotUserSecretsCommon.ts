import z from "zod";
import { ZBytes } from "../common";

export enum ChatbotUserSecretStatusIntEnum {
  Active = 1,
  NeedsReauth = 2,
  Revoked = 3,
}

export enum ChatbotUserSecretStatusLabelEnum {
  Active = "Active",
  NeedsReauth = "Needs sign-in",
  Revoked = "Revoked",
}

export const CHATBOT_USER_SECRET_STATUS_LABEL_MAP: Record<
  ChatbotUserSecretStatusIntEnum,
  ChatbotUserSecretStatusLabelEnum
> = {
  [ChatbotUserSecretStatusIntEnum.Active]: ChatbotUserSecretStatusLabelEnum.Active,
  [ChatbotUserSecretStatusIntEnum.NeedsReauth]: ChatbotUserSecretStatusLabelEnum.NeedsReauth,
  [ChatbotUserSecretStatusIntEnum.Revoked]: ChatbotUserSecretStatusLabelEnum.Revoked,
};

// DEV_NOTE: The credential is a JSON object whose shape is set by the connection's auth type (AuthStrategy, M3-2).
// It is serialized and encrypted under the company key; the parsed object only exists server-side.
export const ZChatbotUserSecretValue = z.record(z.string(), z.json());
export type ChatbotUserSecretValue = z.infer<typeof ZChatbotUserSecretValue>;

// Create Chatbot User Secret Body
export const ZChatbotUserSecretBase = z.object({
  secret: ZChatbotUserSecretValue,
  scopes: z.array(z.string().trim().min(1)).nullable(),
  expiresAt: z.coerce.date().nullable(),
});
export type ChatbotUserSecretBase = z.infer<typeof ZChatbotUserSecretBase>;

// Whole Chatbot User Secret Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId, chatbotUserId and connectionId are internal bigint ids, and encryptedSecret, iv and
// encryptionKeyVersion are ciphertext metadata — used by DAL/Repo only, NEVER sent to a client.
// type is the connection's auth_type, untyped text in the DB.
export const ZChatbotUserSecret = ZChatbotUserSecretBase.omit({ secret: true }).extend({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotUserId: z.string(),
  connectionId: z.string(),
  type: z.string(),
  encryptedSecret: ZBytes,
  iv: ZBytes,
  encryptionKeyVersion: z.number().int().min(1),
  expiresAt: z.date().nullable(),
  status: z.enum(ChatbotUserSecretStatusIntEnum),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChatbotUserSecret = z.infer<typeof ZChatbotUserSecret>;

// API response shape — includes both int and label; internal ids and ciphertext are structurally omitted
export type ChatbotUserSecretWithStatus = Omit<
  ChatbotUserSecret,
  | "id"
  | "companyId"
  | "chatbotUserId"
  | "connectionId"
  | "encryptedSecret"
  | "iv"
  | "encryptionKeyVersion"
> & {
  chatbotUserSecretStatus: ChatbotUserSecretStatusIntEnum;
  chatbotUserSecretStatusLabel: ChatbotUserSecretStatusLabelEnum;
};
