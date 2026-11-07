import type {
  ChangeRequestEditableField,
  ChangeRequestKindEnum,
  ChangeRequestStatusIntEnum,
  WidgetChangeRequest,
} from "../changeRequests/ChangeRequestsCommon";
import type { FeedbackRatingIntEnum } from "../feedback";
import type { KnowledgeCitation } from "../knowledgeSearch";
import type {
  WidgetBootstrap,
  WidgetConversationListItem,
  WidgetPastConversation,
} from "./WidgetApiResponse";
import type {
  WidgetAccent,
  WidgetInitOptions,
  WidgetStatusEnum,
  WidgetThemeEnum,
} from "./WidgetCommon";

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

// DEV_NOTE: How one record's change stands, in DESIGN.md §8 words (the status line under a decided record). Saved =
// committed, its read-after still to come; Verified = saved and read back as set (M3-6); Undoing / Undone = it didn't
// read back as set, so it is being / was put back. UserUndoing / UserUndone (M3-7): the user's Undo of a saved and
// checked change is under way / put the record back.
export enum WidgetChangeOutcomeEnum {
  Waiting = "waiting",
  Saving = "saving",
  Saved = "saved",
  Verified = "verified",
  Undoing = "undoing",
  Undone = "undone",
  UserUndoing = "user_undoing",
  UserUndone = "user_undone",
  Rejected = "rejected",
  Expired = "expired",
  Failed = "failed",
  NeedsPerson = "needs_person",
}

// DEV_NOTE: How a settled card reads (M3-6, DESIGN.md §7): verified = every record saved and checked (widget-Verified);
// undone = a record didn't save as expected and was put back (widget-MismatchAutoUndone); needs_person = one needs a
// person (widget-MismatchNeedsHuman); plain = any other mix (rejected, expired, failed), counted in the subtitle.
// review covers a card still waiting for the user.
export enum WidgetChangeCardToneEnum {
  Review = "review",
  Verified = "verified",
  Undone = "undone",
  NeedsPerson = "needs_person",
  Plain = "plain",
}

// DEV_NOTE: One field the read-after found other than the change set it: the record's label (mono; null for a new
// record), the field, what was expected and what was found, as display text (null = empty)
export interface WidgetMismatchLineView {
  label: string | null;
  field: string;
  expected: string | null;
  found: string | null;
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
  tone: WidgetChangeCardToneEnum;
  isSending: boolean;
  title: string;
  subtitle: string;
  // DEV_NOTE: A settled card's own lines (M3-6): what a mismatch found (undone), which records saved and which one is
  // flagged (needs_person); empty otherwise
  mismatchLines: WidgetMismatchLineView[];
  notes: string[];
  records: WidgetChangeRecordView[];
  hiddenCount: number;
  includedCount: number;
  approveLabel: string;
  canEdit: boolean;
  expiresAt: number | null;
  // DEV_NOTE: The card's Undo (M3-7, DESIGN.md widget-Verified): undoCount records the user can still undo (saved and
  // checked, inside their window); undoUntil (epoch ms) the earliest end of their windows, shown as "Undo available
  // until HH:MM" (null when there is nothing to undo)
  undoCount: number;
  undoUntil: number | null;
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
  onUndo: (cardId: string) => void;
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
// limit); canStop shows Stop under the running reply. linkOrigins: the bootstrap's (M6-4: where a reply may link besides
// its cited sources; empty until the bootstrap is read).
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
  linkOrigins: string[];
}

export type WidgetPanelActions = WidgetChangeCardActions & {
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onNewChat: () => void;
  onHistory: () => void;
  onToggleFullScreen: () => void;
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
// sent and the review cards' local state (M3-5). accent is the host's brand colour (null = lime).
export interface WidgetStoreState {
  isOpen: boolean;
  draft: string;
  theme: WidgetThemeEnum;
  accent: WidgetAccent | null;
  hostUser: string | null;
  conversationPublicId: string | null;
  isSocketEnabled: boolean;
  isUnavailable: boolean;
  notice: string | null;
  pendingText: string | null;
  ratings: Record<string, FeedbackRatingIntEnum>;
  pendingRatings: Record<string, FeedbackRatingIntEnum>;
  review: WidgetChangeReviewState;
  screen: WidgetScreen;
  isFullScreen: boolean;
}

// DEV_NOTE: startOver switches to another conversation (or none) and clears everything that belonged to the old one:
// socket off, ratings, review, unsent text, notice, unavailable, and back to the chat screen. The theme, the accent,
// the panel and the host user stay.
export interface WidgetStoreActions {
  setOpen: (isOpen: boolean) => void;
  setTheme: (theme: WidgetThemeEnum) => void;
  setAccent: (accent: WidgetAccent | null) => void;
  setConversation: (conversationPublicId: string | null) => void;
  startOver: (conversationPublicId: string | null) => void;
  setScreen: (screen: WidgetScreen) => void;
  setFullScreen: (isFullScreen: boolean) => void;
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
  accent: WidgetAccent | null;
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

// DEV_NOTE: A host accent checked by the widget (the schema, then CSS.supports for each colour)
export type WidgetAccentParseResult =
  | { isSuccess: true; accent: WidgetAccent }
  | { isSuccess: false; message: string };

export interface WidgetShadowHostProps {
  theme: WidgetThemeEnum;
  accent?: WidgetAccent | null;
}

// DEV_NOTE: isFullScreen: the full-screen header (Exit full screen and Close; Your chats is the sidebar there)
export interface WidgetHeaderProps {
  chatbotName: string;
  status: WidgetStatusEnum;
  isFullScreen: boolean;
  onHistory: () => void;
  onNewChat: () => void;
  onToggleFullScreen: () => void;
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
  linkOrigins: string[];
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

// DEV_NOTE: linkOrigins: the origins a link may point to (M6-4); a link anywhere else is shown as its text
export interface WidgetMarkdownProps {
  text: string;
  isStreaming: boolean;
  linkOrigins: string[];
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

// DEV_NOTE: What the open panel shows: the chat, the user's chats (Your chats), or one chat that has ended, read-only.
// A past chat carries the list row it was picked from, so its title shows while its messages load.
export type WidgetScreen =
  | { kind: "chat" }
  | { kind: "history" }
  | { kind: "past"; item: WidgetConversationListItem };

// DEV_NOTE: A history read's outcome (lib/historyApi.ts): notFound only for one chat (404: not this user's, or gone)
export type WidgetHistoryFetchResult<T> =
  | { status: "ok"; data: T }
  | { status: "notFound" }
  | { status: "failed" };

export interface WidgetHistoryFetchParams {
  apiBase: string;
  chatbot: string | null;
  token: string;
  signal: AbortSignal;
}

export type WidgetConversationsFetchParams = WidgetHistoryFetchParams & { pageNo: number };

export type WidgetPastConversationFetchParams = WidgetHistoryFetchParams & { publicId: string };

// DEV_NOTE: Your chats as read so far (hooks/useHistory.ts): pages appended in order; moreFailed = the last Show more
// didn't load (the rows already shown stay)
export type WidgetHistoryState =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      items: WidgetConversationListItem[];
      totalRecords: number;
      isLoadingMore: boolean;
      moreFailed: boolean;
    };

export type WidgetPastChatState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "notFound" }
  | { status: "ready"; conversation: WidgetPastConversation };

// DEV_NOTE: One row of Your chats: the chat on screen right now (current), one that can still be picked up (open), or
// one that has ended (read-only). meta is its line under the title ("Ended · 09:14").
export enum WidgetHistoryToneEnum {
  Current = "current",
  Open = "open",
  Ended = "ended",
}

export interface WidgetHistoryRowView {
  item: WidgetConversationListItem;
  tone: WidgetHistoryToneEnum;
  meta: string;
}

export interface WidgetHistoryGroupView {
  label: string;
  rows: WidgetHistoryRowView[];
}

export type WidgetHistoryView =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      groups: WidgetHistoryGroupView[];
      hasMore: boolean;
      isLoadingMore: boolean;
      moreFailed: boolean;
    };

export interface WidgetHistoryProps {
  chatbotName: string;
  view: WidgetHistoryView;
  onBack: () => void;
  onNewChat: () => void;
  onToggleFullScreen: () => void;
  onClose: () => void;
  onPick: (item: WidgetConversationListItem) => void;
  onMore: () => void;
  onRetry: () => void;
}

export interface WidgetPastChatProps {
  item: WidgetConversationListItem;
  meta: string;
  state: WidgetPastChatState;
  linkOrigins: string[];
  onBack: () => void;
  onNewChat: () => void;
  onToggleFullScreen: () => void;
  onClose: () => void;
  onRetry: () => void;
}

// DEV_NOTE: The header of Your chats and of a past chat: Back, a title (and the line under it), Close
export interface WidgetSubHeaderProps {
  title: string;
  subtitle: string | null;
  backLabel: string;
  onBack: () => void;
  onToggleFullScreen: () => void;
  onClose: () => void;
}

// DEV_NOTE: The open widget's frame around every screen: the 380 × 680 floating panel, or the whole window in full
// screen (a modal dialog there: focus stays inside). Escape closes it either way.
export interface WidgetPanelFrameProps {
  label: string;
  isFullScreen: boolean;
  onClose: () => void;
}

// DEV_NOTE: The chat below the header: the log (welcome, messages, notices) and the composer. isWide: full screen, the
// content in a centred column of readable width.
export type WidgetChatLogProps = WidgetPanelProps & { isWide: boolean };

// DEV_NOTE: Your chats below its header (the floating screen's body, or the full-screen sidebar). onBack null: no Back
// to chat (the sidebar sits beside the chat). selectedPublicId: the row on screen, highlighted.
export type WidgetHistoryListProps = Omit<
  WidgetHistoryProps,
  "onBack" | "onClose" | "onToggleFullScreen"
> & { onBack: (() => void) | null; selectedPublicId: string | null };

// DEV_NOTE: A past chat below its header: the read-only log and Start a new chat. isWide: full screen (centred column,
// the chat's title above its messages, as the header there is the chatbot's).
export type WidgetPastChatLogProps = Omit<
  WidgetPastChatProps,
  "onBack" | "onClose" | "onToggleFullScreen"
> & { isWide: boolean };

// DEV_NOTE: The full-screen widget: one header, Your chats as a sidebar, and the chat or the past chat picked in it
export interface WidgetFullScreenPanelProps {
  panel: WidgetPanelProps;
  history: WidgetHistoryListProps;
  past: Omit<WidgetPastChatLogProps, "isWide"> | null;
}
