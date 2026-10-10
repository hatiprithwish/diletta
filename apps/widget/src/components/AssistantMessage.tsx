import { Pause } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";
import Feedback from "@/components/Feedback";
import Markdown from "@/components/Markdown";
import Sources from "@/components/Sources";
import ToolSteps from "@/components/ToolSteps";

// DEV_NOTE: One reply, no bubble: its steps, its text (caret while streaming), Stop while it runs, then its sources
// and the thumbs once it's finished
export default function AssistantMessage({
  message,
  canStop,
  onStop,
  onRate,
}: Schemas.WidgetAssistantMessageProps) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <ToolSteps steps={message.steps} />
      <Markdown text={message.text} isStreaming={message.isStreaming} />
      {message.isStreaming && canStop && (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex h-7.5 items-center gap-1.5 self-start rounded-full border border-border bg-background px-2.5 text-caption text-subtle-foreground transition-colors hover:bg-muted"
        >
          <Pause className="size-3.25" />
          Stop
        </button>
      )}
      {!message.isStreaming && <Sources citations={message.citations} />}
      {message.canRate && (
        <Feedback messageId={message.id} rating={message.rating} onRate={onRate} />
      )}
    </div>
  );
}
