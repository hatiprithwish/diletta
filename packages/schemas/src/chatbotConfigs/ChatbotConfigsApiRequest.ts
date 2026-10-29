import { z } from "zod";
import { ZPageApiRequest } from "../common";
import { ChatbotConfigSortColumn } from "./ChatbotConfigsCommon";

// DEV_NOTE: A chatbot's versions, newest first by default (Settings › Bots, M4-10)
export const ZGetChatbotConfigsApiRequest = ZPageApiRequest.extend({
  sortColumn: z.enum(ChatbotConfigSortColumn).nullable().optional(),
});
export type GetChatbotConfigsApiRequest = z.infer<typeof ZGetChatbotConfigsApiRequest>;

// DEV_NOTE: A draft's body as the editor sends it. Left untyped here on purpose: the Repo checks it only through
// normalizeConfigBody (the config spec's one write path), which answers InvalidBody with every issue.
export const ZSaveChatbotConfigApiRequest = z.object({
  body: z.unknown(),
});
export type SaveChatbotConfigApiRequest = z.infer<typeof ZSaveChatbotConfigApiRequest>;

// DEV_NOTE: /settings/bots URL search: the chatbot whose versions show (absent = the default, else the first) and the
// page of its versions
export const ZBotsPageSearch = z.object({
  botId: z.string().min(1).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type BotsPageSearch = z.infer<typeof ZBotsPageSearch>;
