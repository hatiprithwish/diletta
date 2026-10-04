import { z } from "zod";
import { ChatbotStatusIntEnum, ZChatbotBase } from "./ChatbotsCommon";

export const ZCreateChatbotApiRequest = z.object({
  chatbot: ZChatbotBase,
});
export type CreateChatbotApiRequest = z.infer<typeof ZCreateChatbotApiRequest>;

export const ZUpdateChatbotApiRequest = z.object({
  chatbot: ZChatbotBase.extend({
    status: z.enum(ChatbotStatusIntEnum),
  }).partial(),
});
export type UpdateChatbotApiRequest = z.infer<typeof ZUpdateChatbotApiRequest>;
