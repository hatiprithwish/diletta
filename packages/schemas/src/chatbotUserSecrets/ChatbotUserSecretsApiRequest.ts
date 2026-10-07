import { z } from "zod";
import { ChatbotUserSecretStatusIntEnum, ZChatbotUserSecretBase } from "./ChatbotUserSecretsCommon";

// DEV_NOTE: scopes and expiresAt default to none. The chatbot user and the connection are internal ids the Repo
// takes next to the body (resolved from the widget session, M2); type is copied from the connection.
export const ZCreateChatbotUserSecretApiRequest = z.object({
  chatbotUserSecret: ZChatbotUserSecretBase.partial({ scopes: true, expiresAt: true }),
});
export type CreateChatbotUserSecretApiRequest = z.infer<typeof ZCreateChatbotUserSecretApiRequest>;

// DEV_NOTE: A new credential (refresh, re-auth) overwrites the row. Null scopes or expiresAt would be ignored,
// so they aren't accepted.
export const ZUpdateChatbotUserSecretApiRequest = z.object({
  chatbotUserSecret: z
    .object({
      secret: ZChatbotUserSecretBase.shape.secret,
      scopes: z.array(z.string().trim().min(1)),
      expiresAt: z.coerce.date(),
      status: z.enum(ChatbotUserSecretStatusIntEnum),
    })
    .partial(),
});
export type UpdateChatbotUserSecretApiRequest = z.infer<typeof ZUpdateChatbotUserSecretApiRequest>;
