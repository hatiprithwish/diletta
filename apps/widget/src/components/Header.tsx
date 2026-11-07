import { ArrowsIn, ArrowsOut, ClockCounterClockwise, Plus, X } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { cn } from "@app/ui/lib/utils";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Bot name, status dot + word (Online, Working, Unavailable), then Your chats, Full screen (from the sm
// breakpoint), New chat and Close (DESIGN.md §7). In full screen: Exit full screen and Close only (Your chats and New
// chat are in the sidebar), with a line under it.
export default function Header({
  chatbotName,
  status,
  isFullScreen,
  onHistory,
  onNewChat,
  onToggleFullScreen,
  onClose,
}: Schemas.WidgetHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 py-3.5 pr-3.5 pl-4.5",
        isFullScreen && "border-b border-border py-3 pl-6",
      )}
    >
      <span className="mr-1.5 flex min-w-0 grow flex-col">
        <span className="truncate text-sm font-semibold tracking-tight">{chatbotName}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <span
            className={cn(
              "size-1.5 rounded-full",
              status === Schemas.WidgetStatusEnum.Unavailable
                ? "bg-muted-foreground"
                : "bg-brand-text",
            )}
          />
          {status}
        </span>
      </span>
      {isFullScreen ? (
        <Button variant="ghost" onClick={onToggleFullScreen} className="text-subtle-foreground">
          <ArrowsIn />
          Exit full screen
        </Button>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Your chats"
            onClick={onHistory}
            className="text-subtle-foreground"
          >
            <ClockCounterClockwise />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Full screen"
            onClick={onToggleFullScreen}
            className="hidden text-subtle-foreground sm:inline-flex"
          >
            <ArrowsOut />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New chat"
            onClick={onNewChat}
            className="text-subtle-foreground"
          >
            <Plus />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close assistant"
        onClick={onClose}
        className="text-subtle-foreground"
      >
        <X />
      </Button>
    </div>
  );
}
