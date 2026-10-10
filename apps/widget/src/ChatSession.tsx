import { useCallback } from "react";
import * as Schemas from "@app/schemas";
import Launcher from "@/components/Launcher";
import Panel from "@/components/Panel";
import { useConversation } from "@/hooks/useConversation";
import { toMessageViews } from "@/lib/transcriptView";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: One chat session: the launcher while closed, the panel while open, fixed bottom-right (28px inset). It turns
// the bootstrap read, the chat socket and the store into the panel's view model (Schemas.WidgetPanelView).
// Unavailable when the bootstrap can't be read, when the chatbot has no published config, or when a turn or the
// socket says so. WidgetApp remounts it for each conversation id (see useConversation).
const FALLBACK_NAME = "Assistant";

export default function ChatSession({
  apiBase,
  chatbot,
  getToken,
  savedKey,
  bootstrap,
  onRetryBootstrap,
}: {
  apiBase: string;
  chatbot: string | null;
  getToken: () => Promise<string>;
  savedKey: string | null;
  bootstrap: Schemas.WidgetBootstrapState;
  onRetryBootstrap: () => void;
}) {
  const storeApi = useWidgetStoreApi();
  const isOpen = useWidgetStore((state) => state.isOpen);
  const isUnavailable = useWidgetStore((state) => state.isUnavailable);
  const notice = useWidgetStore((state) => state.notice);
  const draft = useWidgetStore((state) => state.draft);
  const pendingText = useWidgetStore((state) => state.pendingText);
  const ratings = useWidgetStore((state) => state.ratings);
  const pendingRatings = useWidgetStore((state) => state.pendingRatings);

  const conversation = useConversation({ apiBase, chatbot, getToken, savedKey });

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
    welcome: ready?.widget
      ? { greeting: ready.widget.greeting, suggestions: ready.widget.suggestions }
      : null,
    messages,
    isUnavailable: shownUnavailable,
    isBusy,
    canStop: isTurnRunning,
    notice,
    draft,
  };

  const { retry: retryConversation } = conversation;
  const onRetry = useCallback(() => {
    if (isBootstrapUnavailable) onRetryBootstrap();
    if (storeApi.getState().isUnavailable) retryConversation();
  }, [isBootstrapUnavailable, onRetryBootstrap, retryConversation, storeApi]);

  return (
    <div className="fixed right-4 bottom-4 z-[2147483647] sm:right-7 sm:bottom-7">
      {isOpen ? (
        <Panel
          view={view}
          onSend={conversation.send}
          onStop={conversation.stop}
          onRetry={onRetry}
          onNewChat={conversation.newChat}
          onClose={() => storeApi.getState().setOpen(false)}
          onRate={conversation.rate}
          onDraftChange={(value) => storeApi.getState().patch({ draft: value })}
        />
      ) : (
        <Launcher
          label={ready?.widget?.launcherLabel ?? null}
          chatbotName={chatbotName}
          onOpen={() => storeApi.getState().setOpen(true)}
        />
      )}
    </div>
  );
}
