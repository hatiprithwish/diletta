import type { ApiResponse } from "../common";
import type {
  ChangeRequestErrorCodeEnum,
  ChangeRequestStatusIntEnum,
  ChangeRequestStatusLabelEnum,
} from "../changeRequests/ChangeRequestsCommon";
import type { FeedbackRatingIntEnum, FeedbackRatingLabelEnum } from "../feedback/FeedbackCommon";
import type { KnowledgeCitation } from "../knowledgeSearch";
import type { MessageRoleIntEnum, MessageRoleLabelEnum } from "../messages/MessagesCommon";
import type {
  ToolCallErrorCodeEnum,
  ToolCallStatusIntEnum,
  ToolCallStatusLabelEnum,
} from "../toolCalls/ToolCallsCommon";
import type {
  ConversationCostNoteEnum,
  ConversationListTabEnum,
  ConversationOutcomeIntEnum,
  ConversationStatusIntEnum,
  ConversationStatusLabelEnum,
} from "./ConversationsCommon";

// DEV_NOTE: The dashboard's Conversations page (M4-4). Public ids only; dates are ISO strings. title is the first user
// message (null once the chat is purged, isContentPurged). outcomeLabel reads "In progress" while outcome is null.
// userName null = the host sent no name. configVersion null = no turn ran yet.
export interface ConversationListItem {
  publicId: string;
  userName: string | null;
  title: string | null;
  isContentPurged: boolean;
  conversationStatus: ConversationStatusIntEnum;
  conversationStatusLabel: ConversationStatusLabelEnum;
  outcome: ConversationOutcomeIntEnum | null;
  outcomeLabel: string;
  turnCount: number;
  chatbotName: string | null;
  configVersion: number | null;
  rating: FeedbackRatingIntEnum | null;
  ratingLabel: FeedbackRatingLabelEnum | null;
  createdAt: string;
  lastActivityAt: string;
}

// DEV_NOTE: The count behind each tab, keyed by the tab itself, under the same outcome, config and chatbot filters
export type ConversationTabCounts = Record<ConversationListTabEnum, number>;

// One choice of the Config filter: a published config of one of the company's chatbots
export interface ConversationConfigOption {
  publicId: string;
  chatbotName: string;
  configVersion: number;
}

export enum ConversationTurnEntryKindEnum {
  Message = "message",
  Tool = "tool",
}

// DEV_NOTE: One message of a turn. text null = purged. citations: the sources the reply's [n] markers cite.
// rating: the user's thumb on this reply, if any.
export interface ConversationTurnMessage {
  kind: ConversationTurnEntryKindEnum.Message;
  publicId: string;
  role: MessageRoleIntEnum;
  roleLabel: MessageRoleLabelEnum;
  text: string | null;
  citations: Pick<KnowledgeCitation, "n" | "title" | "sourceUrl">[];
  rating: FeedbackRatingIntEnum | null;
  ratingLabel: FeedbackRatingLabelEnum | null;
}

// DEV_NOTE: The change a write tool call proposed. summary holds no values (tool, kind, field count).
export interface ConversationTurnChange {
  publicId: string;
  summary: string;
  changeCount: number;
  changeRequestStatus: ChangeRequestStatusIntEnum;
  changeRequestStatusLabel: ChangeRequestStatusLabelEnum;
  errorCode: ChangeRequestErrorCodeEnum | null;
  errorLabel: string | null;
}

// DEV_NOTE: One host tool call of a turn. Never its args or the host's answer (they're encrypted, and plaintext never
// leaves the server): the tool, its status and, for a write, the change it proposed. toolName null = its definition
// is gone.
export interface ConversationTurnToolCall {
  kind: ConversationTurnEntryKindEnum.Tool;
  publicId: string;
  toolName: string | null;
  toolVersion: number;
  toolCallStatus: ToolCallStatusIntEnum;
  toolCallStatusLabel: ToolCallStatusLabelEnum;
  errorCode: ToolCallErrorCodeEnum | null;
  errorLabel: string | null;
  change: ConversationTurnChange | null;
}

export type ConversationTurnEntry = ConversationTurnMessage | ConversationTurnToolCall;

// DEV_NOTE: One turn: the user's message and everything that answered it, in order (the user's message, the tool
// calls, the replies). number counts from 1. costUsd = the turn's model spend on the company's key (Workers AI search
// calls are platform-paid, so not counted); costNote says when part of it is still Pending or Unknown.
export interface ConversationTurn {
  number: number;
  startedAt: string;
  costUsd: string;
  costNote: ConversationCostNoteEnum | null;
  entries: ConversationTurnEntry[];
}

// DEV_NOTE: The conversation's detail card. costUsd = every spend model call of the conversation, the turns' and any
// with no turn. isFlagged = an admin flagged it and that issue is still open.
export interface ConversationDetail extends ConversationListItem {
  costUsd: string;
  costNote: ConversationCostNoteEnum | null;
  isFlagged: boolean;
  turns: ConversationTurn[];
}

export interface GetConversationsApiResponse extends ApiResponse {
  conversations?: ConversationListItem[];
  totalRecords?: number;
  tabCounts?: ConversationTabCounts;
  configOptions?: ConversationConfigOption[];
}

export interface GetConversationApiResponse extends ApiResponse {
  conversation?: ConversationDetail;
}

export interface ExportConversationsApiResponse extends ApiResponse {
  conversations?: ConversationListItem[];
  isTruncated?: boolean;
}

// DEV_NOTE: POST /dashboard/conversations/:publicId/flag. isCreated false = an admin had already flagged it and that
// issue is still open: nothing new was opened.
export interface FlagConversationApiResponse extends ApiResponse {
  qualityIssuePublicId?: string;
  isCreated?: boolean;
}
