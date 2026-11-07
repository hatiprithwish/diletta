import { useCallback, useState } from "react";
import * as Schemas from "@app/schemas";
import { cn } from "@app/ui/lib/utils";
import FullScreenPanel from "@/components/FullScreenPanel";
import History from "@/components/History";
import Launcher from "@/components/Launcher";
import Panel from "@/components/Panel";
import PastChat from "@/components/PastChat";
import { useConversation } from "@/hooks/useConversation";
import { useHistory, usePastChat } from "@/hooks/useHistory";
import { useIsWideScreen } from "@/hooks/useIsWideScreen";
import { pastChatMeta, toHistoryView } from "@/lib/historyView";
import { toMessageViews } from "@/lib/transcriptView";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: One chat session: the launcher while closed, the panel while open, fixed bottom-right (28px inset), or the
// whole window in full screen. It turns
// the bootstrap read, the chat socket and the store into the panel's view model (Schemas.WidgetPanelView).
// Unavailable when the bootstrap can't be read, when the chatbot has no published config, or when a turn or the
// socket says so. WidgetApp remounts it for each conversation id (see useConversation).
//
// The open panel shows one screen (the store's): the chat, Your chats, or a chat that has ended. Picking an open chat
// in Your chats resumes it in the chat (a new session), an ended one shows it read-only; New chat and Start a new chat
// both go back to an empty chat. Full screen (the visitor's choice, saved, and only from the sm breakpoint up) fills
// the window with Your chats as a sidebar beside the chat or the past chat; the history screen isn't needed there.
const FALLBACK_NAME = "Assistant";

export default function ChatSession({
  apiBase,
  chatbot,
  getToken,
  getHostToken,
  bootstrap,
  onRetryBootstrap,
}: Schemas.WidgetChatSessionProps) {
  const storeApi = useWidgetStoreApi();
  const isOpen = useWidgetStore((state) => state.isOpen);
  const isUnavailable = useWidgetStore((state) => state.isUnavailable);
  const notice = useWidgetStore((state) => state.notice);
  const draft = useWidgetStore((state) => state.draft);
  const pendingText = useWidgetStore((state) => state.pendingText);
  const ratings = useWidgetStore((state) => state.ratings);
  const pendingRatings = useWidgetStore((state) => state.pendingRatings);
  const notes = useWidgetStore((state) => state.notes);
  const review = useWidgetStore((state) => state.review);
  const screen = useWidgetStore((state) => state.screen);
  const conversationPublicId = useWidgetStore((state) => state.conversationPublicId);
  const isFullScreenChosen = useWidgetStore((state) => state.isFullScreen);
  const isWideScreen = useIsWideScreen();

  // DEV_NOTE: Focus goes back to the launcher only when the visitor closed the panel, never on page load
  const [shouldFocusLauncher, setShouldFocusLauncher] = useState(false);

  const conversation = useConversation({ apiBase, chatbot, getToken, getHostToken });
  const history = useHistory({
    apiBase,
    chatbot,
    getToken,
    isActive: isOpen && (screen.kind === "history" || (isFullScreenChosen && isWideScreen)),
  });
  const pastChat = usePastChat({
    apiBase,
    chatbot,
    getToken,
    publicId: isOpen && screen.kind === "past" ? screen.item.publicId : null,
  });

  const ready = bootstrap.status === "ready" ? bootstrap.bootstrap : null;
  const chatbotName = ready?.chatbot.name ?? FALLBACK_NAME;
  const isBootstrapUnavailable =
    bootstrap.status === "failed" || (ready !== null && ready.widget === null);
  const isTurnRunning = conversation.isStreaming || conversation.isSubmitted;
  const isBusy = isTurnRunning || pendingText !== null;

  const messages = toMessageViews({
    messages: conversation.messages,
    isStreaming: conversation.isStreaming,
    ratings,
    pendingRatings,
    notes,
    review,
  });
  if (pendingText !== null) {
    messages.push({ role: "user", id: "pending", text: pendingText });
  }

  const shownUnavailable = isUnavailable || isBootstrapUnavailable;
  const view: Schemas.WidgetPanelView = {
    chatbotName,
    status: shownUnavailable
      ? Schemas.WidgetStatusEnum.Unavailable
      : isBusy
        ? Schemas.WidgetStatusEnum.Working
        : Schemas.WidgetStatusEnum.Online,
    // DEV_NOTE: Suggestions only while the chatbot can answer them, each once
    welcome: ready?.widget
      ? {
          greeting: ready.widget.greeting,
          suggestions: shownUnavailable ? [] : [...new Set(ready.widget.suggestions)],
        }
      : null,
    messages,
    isUnavailable: shownUnavailable,
    isBusy,
    canStop: isTurnRunning,
    notice,
    draft,
    linkOrigins: ready?.linkOrigins ?? [],
  };

  const { retry: retryConversation } = conversation;
  const onRetry = useCallback(() => {
    if (isBootstrapUnavailable) onRetryBootstrap();
    if (storeApi.getState().isUnavailable) retryConversation();
  }, [isBootstrapUnavailable, onRetryBootstrap, retryConversation, storeApi]);

  const onClose = () => {
    setShouldFocusLauncher(true);
    storeApi.getState().setOpen(false);
  };
  const showChat = () => storeApi.getState().setScreen({ kind: "chat" });
  const startNewChat = () => {
    conversation.newChat();
    showChat();
  };
  const onPick = (item: Schemas.WidgetConversationListItem) => {
    if (item.publicId === conversationPublicId) return showChat();
    if (item.isOpen) return conversation.openConversation(item.publicId);
    storeApi.getState().setScreen({ kind: "past", item });
  };

  const isFullScreen = isFullScreenChosen && isWideScreen;
  const onToggleFullScreen = () => storeApi.getState().setFullScreen(!isFullScreen);
  const showHistory = () => storeApi.getState().setScreen({ kind: "history" });
  const linkOrigins = ready?.linkOrigins ?? [];
  const panel: Schemas.WidgetPanelProps = {
    view,
    onSend: conversation.send,
    onStop: conversation.stop,
    onRetry,
    onNewChat: startNewChat,
    onHistory: showHistory,
    onToggleFullScreen,
    onClose,
    onRate: conversation.rate,
    ...conversation.noteActions,
    ...conversation.changeActions,
    onDraftChange: (value) => storeApi.getState().patch({ draft: value }),
  };
  // DEV_NOTE: Rows and lines are worded against the time the open panel is drawn
  const pastOf = (now: Date) =>
    screen.kind === "past"
      ? {
          item: screen.item,
          meta: pastChatMeta(screen.item, now),
          state: pastChat.state,
          linkOrigins,
          onNewChat: startNewChat,
          onRetry: pastChat.retry,
        }
      : null;

  const renderOpen = () => {
    const now = new Date();
    const historyView = toHistoryView({
      state: history.state,
      currentPublicId: conversationPublicId,
      now,
    });
    const past = pastOf(now);
    if (isFullScreen) {
      return (
        <FullScreenPanel
          panel={panel}
          past={past}
          history={{
            chatbotName,
            view: historyView,
            selectedPublicId: past ? past.item.publicId : conversationPublicId,
            onBack: null,
            onNewChat: startNewChat,
            onPick,
            onMore: history.loadMore,
            onRetry: history.retry,
          }}
        />
      );
    }
    if (screen.kind === "history") {
      return (
        <History
          chatbotName={chatbotName}
          view={historyView}
          onBack={showChat}
          onNewChat={startNewChat}
          onToggleFullScreen={onToggleFullScreen}
          onClose={onClose}
          onPick={onPick}
          onMore={history.loadMore}
          onRetry={history.retry}
        />
      );
    }
    if (past) {
      return (
        <PastChat
          {...past}
          onBack={showHistory}
          onToggleFullScreen={onToggleFullScreen}
          onClose={onClose}
        />
      );
    }
    return <Panel {...panel} />;
  };

  return (
    <div
      className={cn(
        "fixed z-[2147483647]",
        isOpen && isFullScreen ? "inset-0" : "right-4 bottom-4 sm:right-7 sm:bottom-7",
      )}
    >
      {isOpen ? (
        renderOpen()
      ) : (
        <Launcher
          label={ready?.widget?.launcherLabel ?? null}
          chatbotName={chatbotName}
          autoFocus={shouldFocusLauncher}
          onOpen={() => storeApi.getState().setOpen(true)}
        />
      )}
    </div>
  );
}
