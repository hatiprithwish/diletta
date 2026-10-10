import { ArrowsClockwise, Pause } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: The chatbot can't answer right now (widget-Unavailable): says nothing changed and offers a retry
export default function UnavailableCard({ onRetry }: Schemas.WidgetUnavailableCardProps) {
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface-subtle p-3.5"
    >
      <span className="flex items-center gap-2 text-body font-semibold">
        <Pause className="size-4 text-subtle-foreground" />
        Temporarily unavailable
      </span>
      <span className="text-[13px] leading-normal text-subtle-foreground">
        Try again in a few minutes. Your data hasn&apos;t changed.
      </span>
      <span className="pt-1.5">
        <Button variant="outline" onClick={onRetry} className="text-body">
          <ArrowsClockwise />
          Try again
        </Button>
      </span>
    </div>
  );
}
