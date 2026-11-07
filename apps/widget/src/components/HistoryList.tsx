import { ClockCounterClockwise, Plus } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { cn } from "@app/ui/lib/utils";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Your chats below its header (DESIGN.md §7), in the floating panel or as the full-screen sidebar: New chat,
// then the user's chats with this chatbot grouped by day, newest first, Show more for the next page. A chat that can
// still be picked up (or the one on screen) has the brand dot; the selected one is highlighted. Loading, empty and
// didn't-load states. Renders the view model only.
export default function HistoryList({
  chatbotName,
  view,
  selectedPublicId,
  onBack,
  onNewChat,
  onPick,
  onMore,
  onRetry,
}: Schemas.WidgetHistoryListProps) {
  if (view.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-label="Loading your chats"
        className="flex flex-col gap-4.5 px-4.5 py-2"
      >
        {["w-4/5", "w-2/3", "w-3/4", "w-3/5"].map((width) => (
          <div key={width} className="flex flex-col gap-1.75">
            <span className={cn("h-3.25 animate-pulse rounded-md bg-muted", width)} />
            <span className="h-2.5 w-1/3 animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </div>
    );
  }
  if (view.status === "failed") {
    return (
      <div
        role="alert"
        className="flex grow flex-col items-center justify-center gap-2.5 px-9 text-center"
      >
        <p className="text-section">Your chats didn't load</p>
        <p className="text-caption text-muted-foreground">Check your connection and try again.</p>
        <Button variant="outline" onClick={onRetry} className="mt-1.5">
          Try again
        </Button>
      </div>
    );
  }
  if (view.groups.length === 0) {
    return (
      <div className="flex grow flex-col items-center justify-center gap-2.5 px-9 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-brand-soft text-brand-text">
          <ClockCounterClockwise className="size-5" />
        </span>
        <p className="text-section">No past chats yet</p>
        <p className="text-caption text-muted-foreground">
          Chats you have with {chatbotName} will show up here.
        </p>
        {onBack && (
          <Button variant="outline" onClick={onBack} className="mt-1.5">
            Back to chat
          </Button>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="px-3.5 pb-2.5">
        <Button variant="outline" onClick={onNewChat} className="h-10 w-full">
          <Plus />
          New chat
        </Button>
      </div>
      <nav
        aria-label="Your chats"
        className="flex grow flex-col gap-3.5 overflow-y-auto overscroll-contain px-2 pt-1 pb-3"
      >
        {view.groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-0.5">
            <h3 className="px-2.5 py-1 text-xs font-medium text-muted-foreground">{group.label}</h3>
            {group.rows.map((row) => (
              <button
                key={row.item.publicId}
                type="button"
                onClick={() => onPick(row.item)}
                aria-current={row.item.publicId === selectedPublicId ? "true" : undefined}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg px-2.5 py-2.25 text-left transition-colors hover:bg-muted",
                  row.item.publicId === selectedPublicId && "bg-muted",
                )}
              >
                <span className="truncate text-sm font-medium">{row.item.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {row.tone !== Schemas.WidgetHistoryToneEnum.Ended && (
                    <span className="size-1.5 rounded-full bg-brand-text" />
                  )}
                  {row.meta}
                </span>
              </button>
            ))}
          </section>
        ))}
        {view.moreFailed && (
          <p role="alert" className="px-2.5 text-caption text-muted-foreground">
            More chats didn't load. Please try again.
          </p>
        )}
        {view.hasMore && (
          <Button
            variant="ghost"
            onClick={onMore}
            disabled={view.isLoadingMore}
            className="self-center text-subtle-foreground"
          >
            {view.isLoadingMore ? "Loading…" : "Show more"}
          </Button>
        )}
      </nav>
      <p className="border-t border-border px-4.5 pt-2.5 pb-3.5 text-widget-note text-muted-foreground">
        Your chats with {chatbotName}. Older chats are removed after a while.
      </p>
    </>
  );
}
