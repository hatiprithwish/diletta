import z from "zod";

export enum ChatbotUserSortColumn {
  CreatedAt = "createdAt",
  HostUserId = "hostUserId",
  DisplayName = "displayName",
}

export const ZChatbotUserSortColumn = z.enum(ChatbotUserSortColumn);

// Create Chatbot User Body
// DEV_NOTE: hostUserId is the host JWT sub — the client-facing id of a chatbot user (no publicId)
export const ZChatbotUserBase = z.object({
  hostUserId: z.string().trim().min(1),
  displayName: z.string().trim().min(1).nullable(),
});
export type ChatbotUserBase = z.infer<typeof ZChatbotUserBase>;

// Whole Chatbot User Body — DB shape
// DEV_NOTE: id and companyId are internal bigint ids — used by DAL/Repo only, NEVER sent to a client
export const ZChatbotUser = ZChatbotUserBase.extend({
  id: z.string(),
  companyId: z.string(),
  erasedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChatbotUser = z.infer<typeof ZChatbotUser>;

// API response shape — internal ids are structurally omitted, hostUserId is client-facing
export type PublicChatbotUser = Omit<ChatbotUser, "id" | "companyId">;
