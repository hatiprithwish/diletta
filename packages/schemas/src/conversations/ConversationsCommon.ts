import { z } from "zod";
import type { FeedbackRatingIntEnum } from "../feedback/FeedbackCommon";

export enum ConversationStatusIntEnum {
  Open = 1,
  Closed = 2,
}

export enum ConversationStatusLabelEnum {
  Open = "Open",
  Closed = "Closed",
}

export const CONVERSATION_STATUS_LABEL_MAP: Record<
  ConversationStatusIntEnum,
  ConversationStatusLabelEnum
> = {
  [ConversationStatusIntEnum.Open]: ConversationStatusLabelEnum.Open,
  [ConversationStatusIntEnum.Closed]: ConversationStatusLabelEnum.Closed,
};

export enum ConversationOutcomeIntEnum {
  Answered = 1,
  ActionDone = 2,
  Idk = 3,
  Handoff = 4,
  Abandoned = 5,
}

export enum ConversationOutcomeLabelEnum {
  Answered = "Answered",
  ActionDone = "Action done",
  Idk = "Couldn't answer",
  Handoff = "Handed off",
  Abandoned = "Abandoned",
}

export const CONVERSATION_OUTCOME_LABEL_MAP: Record<
  ConversationOutcomeIntEnum,
  ConversationOutcomeLabelEnum
> = {
  [ConversationOutcomeIntEnum.Answered]: ConversationOutcomeLabelEnum.Answered,
  [ConversationOutcomeIntEnum.ActionDone]: ConversationOutcomeLabelEnum.ActionDone,
  [ConversationOutcomeIntEnum.Idk]: ConversationOutcomeLabelEnum.Idk,
  [ConversationOutcomeIntEnum.Handoff]: ConversationOutcomeLabelEnum.Handoff,
  [ConversationOutcomeIntEnum.Abandoned]: ConversationOutcomeLabelEnum.Abandoned,
};

// Whole Conversation Body — DB shape (enums stored as integers)
// DEV_NOTE: publicId is also the Conversation DO's name. id, companyId, chatbotUserId, chatbotId, chatbotConfigId,
// evalRunId (set = an eval attempt's conversation, M5-2: never on the dashboard), evalCaseId and rootLogId are
// internal bigint ids — used by DAL/Repo only, NEVER sent to a client. evalCaseId + evalAttempt = which attempt of the
// run it is (unique per run, so an attempt runs once). title comes from the first user message (chat content: purged
// with it).
export const ZConversation = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotUserId: z.string(),
  chatbotId: z.string(),
  chatbotConfigId: z.string().nullable(),
  evalRunId: z.string().nullable(),
  evalCaseId: z.string().nullable(),
  evalAttempt: z.number().int().nullable(),
  status: z.enum(ConversationStatusIntEnum),
  outcome: z.enum(ConversationOutcomeIntEnum).nullable(),
  title: z.string().nullable(),
  lastActivityAt: z.date(),
  rootLogId: z.string().nullable(),
  contentPurgedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Conversation = z.infer<typeof ZConversation>;

// DEV_NOTE: Server-side only — who a Conversation DO serves. The widget route builds it from the verified
// WidgetIdentity and the conversation row, and hands it to the DO in a header only the worker sets (the DO has no
// public route). Internal ids, so it never reaches the widget; the DO keeps it in its own storage, never the host
// token (there is none here).
// DEV_NOTE: Server-side only — an eval attempt's conversation (M5-2): the run it belongs to (model calls carry it, so
// the run's cost is theirs), the config under test (every turn runs it, not the published one) and the staging
// connection every pinned tool runs against (whatever connection the tool version names: production is never called
// from an eval). Internal ids.
export const ZConversationEvalContext = z.object({
  evalRunId: z.string().min(1),
  chatbotConfigId: z.string().min(1),
  connectionId: z.string().min(1),
});
export type ConversationEvalContext = z.infer<typeof ZConversationEvalContext>;

export const ZConversationSession = z.object({
  companyId: z.string().min(1),
  chatbotId: z.string().min(1),
  chatbotPublicId: z.string().min(1),
  chatbotName: z.string(),
  chatbotUserId: z.string().min(1),
  conversationId: z.string().min(1),
  conversationPublicId: z.string().min(1),
  // DEV_NOTE: null = a widget conversation. Defaulted so a DO state stored before M5-2 still parses.
  eval: ZConversationEvalContext.nullable().default(null),
});
export type ConversationSession = z.infer<typeof ZConversationSession>;

// ─── Dashboard (M4-4): the Conversations page ───────────────────────────────

// DEV_NOTE: The list's tabs. NeedsAttention = a change request that needs a person or an open quality issue on the
// conversation; RatedDown = any reply rated down.
export enum ConversationListTabEnum {
  All = "all",
  NeedsAttention = "needs_attention",
  RatedDown = "rated_down",
}

export const ZConversationListTab = z.enum(ConversationListTabEnum);

// DEV_NOTE: The Outcome filter: one outcome, or InProgress = no outcome yet (the conversation is still open)
export enum ConversationOutcomeFilterEnum {
  InProgress = "in_progress",
  Answered = "answered",
  ActionDone = "action_done",
  Idk = "idk",
  Handoff = "handoff",
  Abandoned = "abandoned",
}

export const ZConversationOutcomeFilter = z.enum(ConversationOutcomeFilterEnum);

export const CONVERSATION_OUTCOME_FILTER_MAP: Record<
  ConversationOutcomeFilterEnum,
  ConversationOutcomeIntEnum | null
> = {
  [ConversationOutcomeFilterEnum.InProgress]: null,
  [ConversationOutcomeFilterEnum.Answered]: ConversationOutcomeIntEnum.Answered,
  [ConversationOutcomeFilterEnum.ActionDone]: ConversationOutcomeIntEnum.ActionDone,
  [ConversationOutcomeFilterEnum.Idk]: ConversationOutcomeIntEnum.Idk,
  [ConversationOutcomeFilterEnum.Handoff]: ConversationOutcomeIntEnum.Handoff,
  [ConversationOutcomeFilterEnum.Abandoned]: ConversationOutcomeIntEnum.Abandoned,
};

// DEV_NOTE: Shown for a conversation with no outcome yet (outcome null while it is open)
export const CONVERSATION_IN_PROGRESS_LABEL = "In progress";

export const CONVERSATION_OUTCOME_FILTER_LABEL_MAP: Record<ConversationOutcomeFilterEnum, string> =
  {
    [ConversationOutcomeFilterEnum.InProgress]: CONVERSATION_IN_PROGRESS_LABEL,
    [ConversationOutcomeFilterEnum.Answered]: ConversationOutcomeLabelEnum.Answered,
    [ConversationOutcomeFilterEnum.ActionDone]: ConversationOutcomeLabelEnum.ActionDone,
    [ConversationOutcomeFilterEnum.Idk]: ConversationOutcomeLabelEnum.Idk,
    [ConversationOutcomeFilterEnum.Handoff]: ConversationOutcomeLabelEnum.Handoff,
    [ConversationOutcomeFilterEnum.Abandoned]: ConversationOutcomeLabelEnum.Abandoned,
  };

export enum ConversationSortColumn {
  CreatedAt = "createdAt",
  LastActivityAt = "lastActivityAt",
}

export const ZConversationSortColumn = z.enum(ConversationSortColumn);

// DEV_NOTE: Why a cost may still change or isn't the full price: a model call still Pending (the per-minute backfill
// fills it from the gateway log) or Unknown (no usage found, its cost stays 0). Unknown wins when both apply.
export enum ConversationCostNoteEnum {
  Pending = "pending",
  Unknown = "unknown",
}

// DEV_NOTE: The Conversations page's rows per page (the API's own default page size is smaller)
export const CONVERSATIONS_PAGE_SIZE = 25;

// DEV_NOTE: Export's cap: the rows of one export, newest first. More matching rows = isTruncated.
export const CONVERSATIONS_EXPORT_MAX_ROWS = 5000;

// DEV_NOTE: Server-side only — one conversation as the dashboard lists it, with internal ids (id, chatbotConfigId) the
// Repo drops. title is chat content (null once purged). turnCount = distinct turn ids across its messages, tool calls
// and spend model calls; rating = Down if any reply was rated down, else Up if any was rated up, else null.
export interface DashboardConversationRow {
  id: string;
  publicId: string;
  status: ConversationStatusIntEnum;
  outcome: ConversationOutcomeIntEnum | null;
  title: string | null;
  contentPurgedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
  rootLogId: string | null;
  userName: string | null;
  chatbotName: string | null;
  configVersion: number | null;
  turnCount: number;
  rating: FeedbackRatingIntEnum | null;
  isFlagged: boolean;
}
