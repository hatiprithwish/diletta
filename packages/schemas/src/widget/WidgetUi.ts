import type {
  ChangeRequestEditableField,
  ChangeRequestKindEnum,
  ChangeRequestStatusIntEnum,
  WidgetChangeRequest,
} from "../changeRequests/ChangeRequestsCommon";
import type { FeedbackRatingIntEnum } from "../feedback";
import type { KnowledgeCitation } from "../knowledgeSearch";
import type { WidgetBootstrap } from "./WidgetApiResponse";
import type { WidgetInitOptions, WidgetStatusEnum, WidgetThemeEnum } from "./WidgetCommon";

// DEV_NOTE: The widget's view model (apps/widget, M2-7). The chat hooks turn Think's transcript and the DO's frames
// into it; the components only render it, so every state in DESIGN.md §7 can be drawn from plain data.

export enum WidgetToolStepStateEnum {
  Running = "running",
  Done = "done",
  Failed = "failed",
}

// DEV_NOTE: One tool call of a reply, as a line in its steps card: what it did, and a short result on the right
export interface WidgetToolStep {
  id: string;
  label: string;
  detail: string | null;
  state: WidgetToolStepStateEnum;
}

// DEV_NOTE: Review cards (M3-5, DESIGN.md §7 Approval / Editing / Bulk). A card holds the change requests one reply's
// calls of one tool proposed (same kind), each one record. Up to WIDGET_CHANGE_CARD_MAX_ROWS records it is a card
// with a diff per record (Approve N / Edit / Reject); more is the bulk table (a checkbox per record, Approve N /
// Reject), showing WIDGET_CHANGE_BULK_VISIBLE_ROWS rows until "Show N more". Values are the user's own host data,
// shown in their own widget only.
export const WIDGET_CHANGE_CARD_MAX_ROWS = 3;
export const WIDGET_CHANGE_BULK_VISIBLE_ROWS = 6;

export enum WidgetChangeCardLayoutEnum {
  Card = "card",
  Bulk = "bulk",
}

// DEV_NOTE: review: waiting for the user; editing: the user chose Edit; settled: nothing left to decide (every record
// shows its outcome). isSending on the card: an answer or an edit is on its way (the buttons wait).
export enum WidgetChangeCardStageEnum {
  Review = "review",
  Editing = "editing",
  Settled = "settled",
}

// DEV_NOTE: How one record's change stands, in DESIGN.md §8 words (the status line under a decided record)
export enum WidgetChangeOutcomeEnum {
  Waiting = "waiting",
  Saving = "saving",
  Saved = "saved",
  Rejected = "rejected",
  Expired = "expired",
  Failed = "failed",
  NeedsPerson = "needs_person",
}

// DEV_NOTE: One diff line: the field (a machine value, mono), what the record holds and what the change sets, as
// display text; null = empty (nothing there). isChanged false = the record already holds it.
export interface WidgetDiffLineView {
  field: string;
  before: string | null;
  after: string | null;
  isChanged: boolean;
}

// DEV_NOTE: One field in the editor: an editable one (editable set, value = the draft text) or a changed one the user
// can't edit (shown as plain text)
export interface WidgetEditFieldView {
  field: string;
  value: string;
  editable: ChangeRequestEditableField | null;
}

// DEV_NOTE: One record of a card. label: the args that pick the record (its id, mono), null for a new record.
// isIncluded: ticked (bulk) / not removed (editor); an unticked record is rejected when the card is approved.
export interface WidgetChangeRecordView {
  changeRequestPublicId: string;
  label: string | null;
  lines: WidgetDiffLineView[];
  editFields: WidgetEditFieldView[];
  isIncluded: boolean;
  isProposed: boolean;
  wasEdited: boolean;
  outcome: WidgetChangeOutcomeEnum;
  status: ChangeRequestStatusIntEnum;
}

export interface WidgetChangeCardView {
  id: string;
  toolName: string;
  kind: ChangeRequestKindEnum | null;
  layout: WidgetChangeCardLayoutEnum;
  stage: WidgetChangeCardStageEnum;
  isSending: boolean;
  title: string;
  subtitle: string;
  records: WidgetChangeRecordView[];
  hiddenCount: number;
  includedCount: number;
  approveLabel: string;
  canEdit: boolean;
  expiresAt: number | null;
  notice: string | null;
}

// DEV_NOTE: What the review cards do (the panel hands them to useConversation)
export interface WidgetChangeCardActions {
  onApprove: (cardId: string) => void;
  onReject: (cardId: string) => void;
  onEdit: (cardId: string) => void;
  onCancelEdit: (cardId: string) => void;
  onSaveEdits: (cardId: string) => void;
  onEditValue: (
    cardId: string,
    changeRequestPublicId: string,
    field: string,
    value: string,
  ) => void;
  onToggleRecord: (cardId: string, changeRequestPublicId: string) => void;
  onShowMore: (cardId: string) => void;
}

export interface WidgetChangeCardProps {
  card: WidgetChangeCardView;
  actions: WidgetChangeCardActions;
}

export interface WidgetDiffLineProps {
  line: WidgetDiffLineView;
}

export interface WidgetChangeOutcomeProps {
  outcome: WidgetChangeOutcomeEnum;
}

// DEV_NOTE: The review state the store keeps per card (by card id) and per change request (the newest frame)
export interface WidgetChangeReviewState {
  changeRequests: Record<string, WidgetChangeRequest>;
  excluded: Record<string, true>;
  editing: Record<string, Record<string, Record<string, string>>>;
  sending: Record<string, true>;
  expanded: Record<string, true>;
  notices: Record<string, string>;
}

export interface WidgetUserMessageView {
  role: "user";
  id: string;
  text: string;
}

// DEV_NOTE: One reply. citations are the sources its [n] markers cite (the Sources list); rating is the visitor's
// thumb (pending or saved), null when none. canRate: the reply is finished and stored, so feedback may be sent.
export interface WidgetAssistantMessageView {
  role: "assistant";
  id: string;
  text: string;
  steps: WidgetToolStep[];
  citations: KnowledgeCitation[];
  isStreaming: boolean;
  canRate: boolean;
  rating: FeedbackRatingIntEnum | null;
  changeCards: WidgetChangeCardView[];
}

export type WidgetMessageView = WidgetUserMessageView | WidgetAssistantMessageView;

// DEV_NOTE: What the open panel shows. welcome is set for a new chat (no messages yet); isUnavailable shows the
// unavailable card and disables the composer; notice is a one-line message under the chat (a refused send, a rate
// limit); canStop shows Stop under the running reply.
export interface WidgetPanelView {
  chatbotName: string;
  status: WidgetStatusEnum;
  welcome: { greeting: string; suggestions: string[] } | null;
  messages: WidgetMessageView[];
  isUnavailable: boolean;
  isBusy: boolean;
  canStop: boolean;
  notice: string | null;
  draft: string;
}

export type WidgetPanelActions = WidgetChangeCardActions & {
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onNewChat: () => void;
  onClose: () => void;
  onRate: (messageId: string, rating: FeedbackRatingIntEnum) => void;
  onDraftChange: (draft: string) => void;
};

export type WidgetPanelProps = WidgetPanelActions & { view: WidgetPanelView };

// DEV_NOTE: autoFocus: the panel was just closed from inside, so focus returns to the launcher (never on page load)
// DEV_NOTE: One state of the dev gallery (?gallery), drawn from sample data
export interface WidgetGalleryState {
  name: string;
  view: WidgetPanelView;
}

export interface WidgetLauncherProps {
  label: string | null;
  chatbotName: string;
  autoFocus: boolean;
  onOpen: () => void;
}

// DEV_NOTE: The one embedded widget's UI state (a zustand store per widget). conversationPublicId is the conversation
// to resume, kept in localStorage per chatbot and host user so a reload continues the chat; hostUser is a SHA-256 of
// the host user the latest token is for (its sub), which keys that saved id, learned from every token; pendingText is
// a message waiting for its socket to open; draft is the composer's text (a refused message comes back to it); ratings
// are the saved thumbs, pendingRatings the ones sent and not yet answered; review holds the change requests the DO
// sent and the review cards' local state (M3-5).
export interface WidgetStoreState {
  isOpen: boolean;
  draft: string;
  theme: WidgetThemeEnum;
  hostUser: string | null;
  conversationPublicId: string | null;
  isSocketEnabled: boolean;
  isUnavailable: boolean;
  notice: string | null;
  pendingText: string | null;
  ratings: Record<string, FeedbackRatingIntEnum>;
  pendingRatings: Record<string, FeedbackRatingIntEnum>;
  review: WidgetChangeReviewState;
}

// DEV_NOTE: startOver switches to another conversation (or none) and clears everything that belonged to the old one:
// socket off, ratings, review, unsent text, notice, unavailable. The theme, the panel and the host user stay.
export interface WidgetStoreActions {
  setOpen: (isOpen: boolean) => void;
  setTheme: (theme: WidgetThemeEnum) => void;
  setConversation: (conversationPublicId: string | null) => void;
  startOver: (conversationPublicId: string | null) => void;
  patch: (patch: Partial<WidgetStoreState>) => void;
}

export type WidgetStore = WidgetStoreState & WidgetStoreActions;

// DEV_NOTE: The store as the widget reads it (structurally zustand's StoreApi, without a zustand dependency here)
export interface WidgetStoreApi {
  getState: () => WidgetStore;
  getInitialState: () => WidgetStore;
  subscribe: (listener: (state: WidgetStore, previousState: WidgetStore) => void) => () => void;
}

// DEV_NOTE: One widget instance: its options and its own store (the script tag and the React export both render it)
export interface WidgetRootProps {
  options: WidgetInitOptions;
  store: WidgetStoreApi;
}

// DEV_NOTE: The React export's inner widget, remounted (with a fresh store) for each apiBase + chatbot
export interface DilettaWidgetInstanceProps {
  options: WidgetInitOptions;
  theme: WidgetThemeEnum;
}

// DEV_NOTE: What the widget's app, its chat session and its hooks are built from
export interface WidgetAppProps {
  apiBase: string;
  chatbot: string | null;
  getToken: () => Promise<string>;
  getHostToken: (() => Promise<string>) | null;
}

export type WidgetChatSessionProps = WidgetAppProps & {
  bootstrap: WidgetBootstrapState;
  onRetryBootstrap: () => void;
};

export interface WidgetBootstrapFetchParams {
  apiBase: string;
  chatbot: string | null;
  token: string;
  signal: AbortSignal;
}

// DEV_NOTE: Where the conversation to resume is kept: per platform, chatbot and host user (hostUser is already hashed)
export interface WidgetSavedConversationKeyParams {
  apiBase: string;
  chatbot: string | null;
  hostUser: string;
}

// DEV_NOTE: Failed connects. A browser can't read a refused upgrade's status (it sees a close before open), so they are
// counted: Refused = the socket closed before it opened; Token = the host's getToken failed, so no socket was tried
// (never a reason to drop the saved conversation). refused counts the first kind, failed both.
export enum WidgetConnectFailureKindEnum {
  Refused = "Refused",
  Token = "Token",
}

export enum WidgetConnectFailureActionEnum {
  None = "None",
  DropConversation = "DropConversation",
  Unavailable = "Unavailable",
}

export interface WidgetConnectFailures {
  refused: number;
  failed: number;
}

export interface WidgetConnectFailureDecision {
  failures: WidgetConnectFailures;
  action: WidgetConnectFailureActionEnum;
}

// DEV_NOTE: The newest user message the server never took (a refused or closed send), split off the transcript so its
// text can go back to the composer or be sent again
export interface WidgetUnsentSplit<TMessage> {
  messages: TMessage[];
  text: string;
}

// DEV_NOTE: The bootstrap read's state, for the launcher and the welcome screen
export type WidgetBootstrapState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: WidgetBootstrap }
  | { status: "failed" };

export interface WidgetShadowHostProps {
  theme: WidgetThemeEnum;
}

export interface WidgetHeaderProps {
  chatbotName: string;
  status: WidgetStatusEnum;
  onNewChat: () => void;
  onClose: () => void;
}

export interface WidgetWelcomeProps {
  greeting: string;
  suggestions: string[];
  onPick: (suggestion: string) => void;
}

export interface WidgetUserBubbleProps {
  text: string;
}

export interface WidgetAssistantMessageProps {
  message: WidgetAssistantMessageView;
  canStop: boolean;
  onStop: () => void;
  onRate: (messageId: string, rating: FeedbackRatingIntEnum) => void;
  changeActions: WidgetChangeCardActions;
}

export interface WidgetToolStepsProps {
  steps: WidgetToolStep[];
}

export interface WidgetSourcesProps {
  citations: KnowledgeCitation[];
}

export interface WidgetFeedbackProps {
  messageId: string;
  rating: FeedbackRatingIntEnum | null;
  onRate: (messageId: string, rating: FeedbackRatingIntEnum) => void;
}

export interface WidgetUnavailableCardProps {
  onRetry: () => void;
}

export interface WidgetStopButtonProps {
  onStop: () => void;
}

export interface WidgetComposerProps {
  value: string;
  isDisabled: boolean;
  isBusy: boolean;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
}

export interface WidgetMarkdownProps {
  text: string;
  isStreaming: boolean;
}

// DEV_NOTE: A reply's markdown as the widget renders it: a safe subset parsed by the widget itself (no raw HTML, no
// images; links only http(s) and mailto). [n] markers are citation chips. key is the node's position in the reply
// (stable while it streams), for React.
export type WidgetMarkdownInlineContent =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: WidgetMarkdownInline[] }
  | { kind: "em"; children: WidgetMarkdownInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: WidgetMarkdownInline[] }
  | { kind: "citation"; n: number };

export type WidgetMarkdownInline = { key: string } & WidgetMarkdownInlineContent;

export type WidgetMarkdownListItem = { key: string; children: WidgetMarkdownInline[] };

// DEV_NOTE: A list while the parser collects its items (raw item text, parsed once the list ends)
export interface WidgetMarkdownListDraft {
  isOrdered: boolean;
  start: number;
  items: string[];
}

export type WidgetMarkdownBlock = { key: string } & (
  | { kind: "paragraph"; children: WidgetMarkdownInline[] }
  | { kind: "heading"; children: WidgetMarkdownInline[] }
  | { kind: "list"; isOrdered: boolean; start: number; items: WidgetMarkdownListItem[] }
  | { kind: "code"; text: string }
);
