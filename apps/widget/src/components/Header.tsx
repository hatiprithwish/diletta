import { Plus, X } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { cn } from "@app/ui/lib/utils";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Bot name, status dot + word (Online, Working, Unavailable), New chat and Close (DESIGN.md §7)
export default function Header({
  chatbotName,
  status,
  onNewChat,
  onClose,
}: Schemas.WidgetHeaderProps) {
  return (
    <div className="flex items-center gap-2.5 py-3.5 pr-3.5 pl-4.5">
      <span className="flex min-w-0 grow flex-col">
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
      <Button
        variant="ghost"
        size="icon"
        aria-label="New chat"
        onClick={onNewChat}
        className="text-subtle-foreground"
      >
        <Plus />
      </Button>
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
