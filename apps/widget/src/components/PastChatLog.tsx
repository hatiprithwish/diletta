import { Plus } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { cn } from "@app/ui/lib/utils";
import type * as Schemas from "@app/schemas";
import Markdown from "@/components/Markdown";
import Sources from "@/components/Sources";
import UserBubble from "@/components/UserBubble";
import { originOf } from "@/lib/markdown";
import { WIDE_COLUMN_CLASS } from "@/lib/panelFrame";

// DEV_NOTE: A chat that has ended, below its header, read-only (DESIGN.md §7): the user's messages and the replies
// with their sources. No composer: Start a new chat instead. A reply's links follow the live chat's rule (M6-4): the
// host app and its cited sources only. notFound = the chat is no longer available (removed since the list was read).
// isWide: full screen, a centred column with the chat's title and line above the messages.
export default function PastChatLog({
  item,
  meta,
  state,
  linkOrigins,
  isWide,
  onNewChat,
  onRetry,
}: Schemas.WidgetPastChatLogProps) {
  return (
    <>
      <div
        role="log"
        aria-label="Messages"
        className={cn(
          "flex grow flex-col gap-4.5 overflow-y-auto overscroll-contain px-4.5 pt-1.5 pb-3",
          isWide && cn("pt-8", WIDE_COLUMN_CLASS),
        )}
      >
        {isWide && (
          <div className="flex flex-col gap-0.5">
            <h2 className="text-section">{item.title}</h2>
            <span className="text-caption text-muted-foreground">{meta}</span>
          </div>
        )}
        {state.status === "loading" && (
          <p aria-busy="true" className="text-caption text-muted-foreground">
            Loading this chat…
          </p>
        )}
        {state.status === "failed" && (
          <div
            role="alert"
            className="flex grow flex-col items-center justify-center gap-2.5 text-center"
          >
            <p className="text-section">This chat didn't load</p>
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {state.status === "notFound" && (
          <p role="alert" className="text-caption text-muted-foreground">
            This chat isn't available any more.
          </p>
        )}
        {state.status === "ready" &&
          state.conversation.messages.map((message) =>
            message.role === "user" ? (
              <UserBubble key={message.publicId} text={message.text} />
            ) : (
              <div key={message.publicId} className="flex flex-col gap-3 text-sm leading-relaxed">
                <Markdown
                  text={message.text}
                  isStreaming={false}
                  linkOrigins={[
                    ...linkOrigins,
                    ...message.citations.flatMap((citation) => originOf(citation.sourceUrl) ?? []),
                  ]}
                />
                <Sources citations={message.citations} />
              </div>
            ),
          )}
      </div>
      <div
        className={cn(
          "flex flex-col gap-2.5 border-t border-border px-3.5 pt-3 pb-3.5",
          isWide && cn("border-t-0 pb-6 sm:flex-row sm:items-center", WIDE_COLUMN_CLASS),
        )}
      >
        <p
          className={cn(
            "text-center text-caption text-muted-foreground",
            isWide && "grow sm:text-left",
          )}
        >
          This chat has ended. You can read it but not reply.
        </p>
        <Button onClick={onNewChat} className="h-10">
          <Plus />
          Start a new chat
        </Button>
      </div>
    </>
  );
}
