import { z } from "zod";
import { ZChatbotUserBase } from "./ChatbotUsersCommon";

export const ZCreateChatbotUserApiRequest = z.object({
  chatbotUser: ZChatbotUserBase.partial({ displayName: true }),
});
export type CreateChatbotUserApiRequest = z.infer<typeof ZCreateChatbotUserApiRequest>;

// DEV_NOTE: hostUserId is the lookup key, so it can't change; a null displayName would be ignored, so it isn't accepted
export const ZUpdateChatbotUserApiRequest = z.object({
  chatbotUser: z.object({
    displayName: z.string().trim().min(1),
  }),
});
export type UpdateChatbotUserApiRequest = z.infer<typeof ZUpdateChatbotUserApiRequest>;
