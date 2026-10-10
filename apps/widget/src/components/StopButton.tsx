import { Pause } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: Stops the running reply (under the reply while it streams, or under the waiting caret before it starts)
export default function StopButton({ onStop }: Schemas.WidgetStopButtonProps) {
  return (
    <button
      type="button"
      onClick={onStop}
      className="inline-flex h-7.5 items-center gap-1.5 self-start rounded-full border border-border bg-background px-2.5 text-caption text-subtle-foreground transition-colors hover:bg-muted"
    >
      <Pause className="size-3.25" />
      Stop
    </button>
  );
}
