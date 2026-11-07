import { useCallback, useState } from "react";
import * as Schemas from "@app/schemas";
import History from "@/components/History";
import Launcher from "@/components/Launcher";
import Panel from "@/components/Panel";
import PastChat from "@/components/PastChat";
import { useConversation } from "@/hooks/useConversation";
import { useHistory, usePastChat } from "@/hooks/useHistory";
import { pastChatMeta, toHistoryView } from "@/lib/historyView";
import { toMessageViews } from "@/lib/transcriptView";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: One chat session: the launcher while closed, the panel while open, fixed bottom-right (28px inset). It turns
// the bootstrap read, the chat socket and the store into the panel's view model (Schemas.WidgetPanelView).
// Unavailable when the bootstrap can't be read, when the chatbot has no published config, or when a turn or the
// socket says so. WidgetApp remounts it for each conversation id (see useConversation).
//
// The open panel shows one screen (the store's): the chat, Your chats, or a chat that has ended. Picking an open chat
// in Your chats resumes it in the chat (a new session), an ended one shows it read-only; New chat and Start a new chat
// both go back to an empty chat.
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
  const review = useWidgetStore((state) => state.review);
  const screen = useWidgetStore((state) => state.screen);
  const conversationPublicId = useWidgetStore((state) => state.conversationPublicId);

  // DEV_NOTE: Focus goes back to the launcher only when the visitor closed the panel, never on page load
  const [shouldFocusLauncher, setShouldFocusLauncher] = useState(false);

  const conversation = useConversation({ apiBase, chatbot, getToken, getHostToken });
  const history = useHistory({
    apiBase,
    chatbot,
    getToken,
    isActive: isOpen && screen.kind === "history",
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

  const renderOpen = () => {
    if (screen.kind === "history") {
      return (
        <History
          chatbotName={chatbotName}
          view={toHistoryView({
            state: history.state,
            currentPublicId: conversationPublicId,
            now: new Date(),
          })}
          onBack={showChat}
          onNewChat={startNewChat}
          onClose={onClose}
          onPick={onPick}
          onMore={history.loadMore}
          onRetry={history.retry}
        />
      );
    }
    if (screen.kind === "past") {
      return (
        <PastChat
          item={screen.item}
          meta={pastChatMeta(screen.item, new Date())}
          state={pastChat.state}
          linkOrigins={ready?.linkOrigins ?? []}
          onBack={() => storeApi.getState().setScreen({ kind: "history" })}
          onNewChat={startNewChat}
          onClose={onClose}
          onRetry={pastChat.retry}
        />
      );
    }
    return (
      <Panel
        view={view}
        onSend={conversation.send}
        onStop={conversation.stop}
        onRetry={onRetry}
        onNewChat={conversation.newChat}
        onHistory={() => storeApi.getState().setScreen({ kind: "history" })}
        onClose={onClose}
        onRate={conversation.rate}
        {...conversation.changeActions}
        onDraftChange={(value) => storeApi.getState().patch({ draft: value })}
      />
    );
  };

  return (
    <div className="fixed right-4 bottom-4 z-[2147483647] sm:right-7 sm:bottom-7">
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
