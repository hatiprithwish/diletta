import { z } from "zod";
import { ZChatbotUserBase, ZChatbotUserSortColumn } from "./ChatbotUsersCommon";
import { ZPageApiRequest } from "../common";

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

// DEV_NOTE: A company can have any number of chatbot users, so the list is paged
export const ZGetChatbotUsersApiRequest = ZPageApiRequest.extend({
  sortColumn: ZChatbotUserSortColumn.nullable().optional(),
});
export type GetChatbotUsersApiRequest = z.infer<typeof ZGetChatbotUsersApiRequest>;
