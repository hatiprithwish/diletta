import type { FeedbackRatingIntEnum } from "../feedback";
import type { KnowledgeCitation } from "../knowledgeSearch";
import type { WidgetBootstrap } from "./WidgetApiResponse";
import type { WidgetStatusEnum, WidgetThemeEnum } from "./WidgetCommon";

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

export interface WidgetPanelActions {
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onNewChat: () => void;
  onClose: () => void;
  onRate: (messageId: string, rating: FeedbackRatingIntEnum) => void;
  onDraftChange: (draft: string) => void;
}

export type WidgetPanelProps = WidgetPanelActions & { view: WidgetPanelView };

export interface WidgetLauncherProps {
  label: string | null;
  chatbotName: string;
  onOpen: () => void;
}

// DEV_NOTE: The one embedded widget's UI state (a zustand store per widget). conversationPublicId is the conversation
// to resume, kept in localStorage per chatbot and host user so a reload continues the chat; pendingText is a message
// waiting for its socket to open; draft is the composer's text (a refused message comes back to it); ratings are the
// saved thumbs, pendingRatings the ones sent and not yet answered.
export interface WidgetStoreState {
  isOpen: boolean;
  draft: string;
  theme: WidgetThemeEnum;
  conversationPublicId: string | null;
  isSocketEnabled: boolean;
  isUnavailable: boolean;
  notice: string | null;
  pendingText: string | null;
  ratings: Record<string, FeedbackRatingIntEnum>;
  pendingRatings: Record<string, FeedbackRatingIntEnum>;
}

export interface WidgetStoreActions {
  setOpen: (isOpen: boolean) => void;
  setTheme: (theme: WidgetThemeEnum) => void;
  setConversation: (conversationPublicId: string | null) => void;
  patch: (patch: Partial<WidgetStoreState>) => void;
}

export type WidgetStore = WidgetStoreState & WidgetStoreActions;

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

export type WidgetMarkdownBlock = { key: string } & (
  | { kind: "paragraph"; children: WidgetMarkdownInline[] }
  | { kind: "heading"; children: WidgetMarkdownInline[] }
  | { kind: "list"; isOrdered: boolean; start: number; items: WidgetMarkdownListItem[] }
  | { kind: "code"; text: string }
);
