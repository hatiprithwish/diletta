import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type * as Schemas from "@app/schemas";
import AssistantMessage from "@/components/AssistantMessage";
import Composer from "@/components/Composer";
import Header from "@/components/Header";
import StopButton from "@/components/StopButton";
import UnavailableCard from "@/components/UnavailableCard";
import UserBubble from "@/components/UserBubble";
import Welcome from "@/components/Welcome";

// DEV_NOTE: The open widget (DESIGN.md §7): 380 × 680 floating panel (smaller on a small screen), header, the chat or
// the welcome screen, and the composer. Renders the view model only; every action goes up through props.
// A non-modal dialog: the composer takes focus when it opens, Escape closes it. The chat is a live log (read out as
// replies finish; busy while one streams).
// It follows the conversation as it grows (the streaming reply included) only while the visitor is at the bottom;
// scrolled up to read, it stays put. A message the visitor sends always brings them back down.
const FOLLOW_THRESHOLD_PX = 48;

export default function Panel({ view, ...actions }: Schemas.WidgetPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFollowingRef = useRef(true);
  const lastMessage = view.messages.at(-1);
  const isAwaitingReply = view.isBusy && (!lastMessage || lastMessage.role === "user");

  // DEV_NOTE: What growing looks like: a new message, more reply text or steps, the waiting caret, a card or a notice.
  // A plain string, so a re-render that changes none of them (typing, a thumb) doesn't scroll.
  const growth = [
    view.messages.length,
    lastMessage?.text.length ?? 0,
    lastMessage?.role === "assistant" ? lastMessage.steps.length : 0,
    isAwaitingReply,
    view.isUnavailable,
    view.notice ?? "",
  ].join("|");
  const isLastFromUser = lastMessage?.role === "user";
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (isLastFromUser) isFollowingRef.current = true;
    if (isFollowingRef.current) element.scrollTop = element.scrollHeight;
  }, [growth, isLastFromUser]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const fromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    isFollowingRef.current = fromBottom <= FOLLOW_THRESHOLD_PX;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      actions.onClose();
    }
  };

  const showWelcome = view.welcome !== null && view.messages.length === 0 && !view.isBusy;

  return (
    <div
      role="dialog"
      aria-label={view.chatbotName}
      onKeyDown={onKeyDown}
      className="flex h-170 max-h-[calc(100dvh-56px)] w-95 max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl bg-background shadow-float"
    >
      <Header
        chatbotName={view.chatbotName}
        status={view.status}
        onNewChat={actions.onNewChat}
        onClose={actions.onClose}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-busy={view.canStop}
        className={
          showWelcome
            ? "flex grow flex-col justify-center overflow-y-auto px-4.5 pt-1.5 pb-3"
            : "flex grow flex-col gap-4.5 overflow-y-auto px-4.5 pt-1.5 pb-3"
        }
      >
        {showWelcome && view.welcome && (
          <Welcome
            greeting={view.welcome.greeting}
            suggestions={view.welcome.suggestions}
            onPick={actions.onSend}
          />
        )}
        {view.messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} text={message.text} />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              canStop={view.canStop}
              onStop={actions.onStop}
              onRate={actions.onRate}
            />
          ),
        )}
        {isAwaitingReply && !view.isUnavailable && (
          <div className="flex flex-col gap-3" aria-label="Waiting for the reply">
            <span className="inline-block h-3.75 w-1.75 animate-pulse rounded-widget-caret bg-brand-text" />
            {view.canStop && <StopButton onStop={actions.onStop} />}
          </div>
        )}
        {view.isUnavailable && <UnavailableCard onRetry={actions.onRetry} />}
        {view.notice && (
          <p role="alert" className="text-caption text-muted-foreground">
            {view.notice}
          </p>
        )}
      </div>
      <Composer
        value={view.draft}
        isDisabled={view.isUnavailable}
        isBusy={view.isBusy}
        onChange={actions.onDraftChange}
        onSend={actions.onSend}
      />
    </div>
  );
}
