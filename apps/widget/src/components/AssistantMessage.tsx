import type * as Schemas from "@app/schemas";
import Feedback from "@/components/Feedback";
import Markdown from "@/components/Markdown";
import Sources from "@/components/Sources";
import StopButton from "@/components/StopButton";
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
      {message.isStreaming && canStop && <StopButton onStop={onStop} />}
      {!message.isStreaming && <Sources citations={message.citations} />}
      {message.canRate && (
        <Feedback messageId={message.id} rating={message.rating} onRate={onRate} />
      )}
    </div>
  );
}
