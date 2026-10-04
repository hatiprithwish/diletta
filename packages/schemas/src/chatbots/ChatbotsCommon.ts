import z from "zod";

export enum ChatbotStatusIntEnum {
  Active = 1,
  Paused = 2,
}

export enum ChatbotStatusLabelEnum {
  Active = "Active",
  Paused = "Paused",
}

export const CHATBOT_STATUS_LABEL_MAP: Record<ChatbotStatusIntEnum, ChatbotStatusLabelEnum> = {
  [ChatbotStatusIntEnum.Active]: ChatbotStatusLabelEnum.Active,
  [ChatbotStatusIntEnum.Paused]: ChatbotStatusLabelEnum.Paused,
};

// Create Chatbot Body
export const ZChatbotBase = z.object({
  name: z.string().trim().min(1),
});
export type ChatbotBase = z.infer<typeof ZChatbotBase>;

// Whole Chatbot Body — DB shape (status stored as integer)
// DEV_NOTE: id, companyId, createdBy and updatedBy are internal bigint ids — used by DAL/Repo only, NEVER sent to a client
export const ZChatbot = ZChatbotBase.extend({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  status: z.enum(ChatbotStatusIntEnum),
  isDefault: z.boolean(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Chatbot = z.infer<typeof ZChatbot>;

// API response shape — includes both int and label; internal ids are structurally omitted, publicId is client-facing
export type ChatbotWithStatus = Omit<Chatbot, "id" | "companyId" | "createdBy" | "updatedBy"> & {
  chatbotStatus: ChatbotStatusIntEnum;
  chatbotStatusLabel: ChatbotStatusLabelEnum;
};
