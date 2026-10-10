import { useEffect, useRef } from "react";
import { Pause } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";
import AssistantMessage from "@/components/AssistantMessage";
import Composer from "@/components/Composer";
import Header from "@/components/Header";
import UnavailableCard from "@/components/UnavailableCard";
import UserBubble from "@/components/UserBubble";
import Welcome from "@/components/Welcome";

// DEV_NOTE: The open widget (DESIGN.md §7): 380 × 680 floating panel (smaller on a small screen), header, the chat or
// the welcome screen, and the composer. Renders the view model only; every action goes up through props.
export default function Panel({ view, ...actions }: Schemas.WidgetPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessage = view.messages.at(-1);
  const isAwaitingReply = view.isBusy && (!lastMessage || lastMessage.role === "user");

  // DEV_NOTE: Follow the conversation as it grows, the streaming reply included
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [view.messages, isAwaitingReply, view.isUnavailable, view.notice]);

  const showWelcome = view.welcome !== null && view.messages.length === 0 && !view.isBusy;

  return (
    <section
      aria-label={view.chatbotName}
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
            <span className="inline-block h-3.75 w-1.75 animate-pulse rounded-[2px] bg-brand-text" />
            {view.canStop && (
              <button
                type="button"
                onClick={actions.onStop}
                className="inline-flex h-7.5 items-center gap-1.5 self-start rounded-full border border-border bg-background px-2.5 text-caption text-subtle-foreground transition-colors hover:bg-muted"
              >
                <Pause className="size-3.25" />
                Stop
              </button>
            )}
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
    </section>
  );
}
