import { ArrowLeft, X } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: The header of Your chats and of a past chat: Back, the title (and its line), Close (DESIGN.md §7)
export default function SubHeader({
  title,
  subtitle,
  backLabel,
  onBack,
  onClose,
}: Schemas.WidgetSubHeaderProps) {
  return (
    <div className="flex items-center gap-1 py-3.5 pr-3.5 pl-2.5">
      <Button
        variant="ghost"
        size="icon"
        aria-label={backLabel}
        onClick={onBack}
        className="text-subtle-foreground"
      >
        <ArrowLeft />
      </Button>
      <span className="flex min-w-0 grow flex-col">
        <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </span>
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
