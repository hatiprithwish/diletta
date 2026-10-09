import z from "zod";

export enum ChatbotConfigStatusIntEnum {
  Draft = 1,
  Testing = 2,
  Ready = 3,
  Published = 4,
  Archived = 5,
}

export enum ChatbotConfigStatusLabelEnum {
  Draft = "Draft",
  Testing = "Testing",
  Ready = "Ready",
  Published = "Published",
  Archived = "Archived",
}

export const CHATBOT_CONFIG_STATUS_LABEL_MAP: Record<
  ChatbotConfigStatusIntEnum,
  ChatbotConfigStatusLabelEnum
> = {
  [ChatbotConfigStatusIntEnum.Draft]: ChatbotConfigStatusLabelEnum.Draft,
  [ChatbotConfigStatusIntEnum.Testing]: ChatbotConfigStatusLabelEnum.Testing,
  [ChatbotConfigStatusIntEnum.Ready]: ChatbotConfigStatusLabelEnum.Ready,
  [ChatbotConfigStatusIntEnum.Published]: ChatbotConfigStatusLabelEnum.Published,
  [ChatbotConfigStatusIntEnum.Archived]: ChatbotConfigStatusLabelEnum.Archived,
};

// Whole Chatbot Config Body — DB shape (enums stored as integers)
// DEV_NOTE: body is the stored config spec at schemaVersion (read only through loadConfigSpec); jsonb, which drizzle
// reads untyped. id, companyId, chatbotId, approvedByRunId and the <verb>_by ids are internal — NEVER sent to a client.
export const ZChatbotConfig = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string(),
  configVersion: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  status: z.enum(ChatbotConfigStatusIntEnum),
  body: z.unknown(),
  bodyHash: z.string(),
  approvedByRunId: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChatbotConfig = z.infer<typeof ZChatbotConfig>;
