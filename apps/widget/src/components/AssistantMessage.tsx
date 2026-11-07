import type * as Schemas from "@app/schemas";
import { originOf } from "@/lib/markdown";
import ChangeRequestCard from "@/components/ChangeRequestCard";
import Feedback from "@/components/Feedback";
import Markdown from "@/components/Markdown";
import Sources from "@/components/Sources";
import StopButton from "@/components/StopButton";
import ToolSteps from "@/components/ToolSteps";

// DEV_NOTE: One reply, no bubble: its steps, its text (caret while streaming), the review cards of the changes it
// proposed (M3-5), Stop while it runs, then its sources and the thumbs (with the note box, M7-10) once it's finished. Its links may point to the
// host app (linkOrigins) and to the sources it cites, nowhere else (M6-4): a link a prompt injection planted can't
// carry the chat out.
export default function AssistantMessage({
  message,
  linkOrigins,
  canStop,
  onStop,
  onRate,
  noteActions,
  changeActions,
}: Schemas.WidgetAssistantMessageProps) {
  const allowedOrigins = [
    ...linkOrigins,
    ...message.citations.flatMap((citation) => originOf(citation.sourceUrl) ?? []),
  ];
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <ToolSteps steps={message.steps} />
      <Markdown
        text={message.text}
        isStreaming={message.isStreaming}
        linkOrigins={allowedOrigins}
      />
      {message.changeCards.map((card) => (
        <ChangeRequestCard key={card.id} card={card} actions={changeActions} />
      ))}
      {message.isStreaming && canStop && <StopButton onStop={onStop} />}
      {!message.isStreaming && <Sources citations={message.citations} />}
      {message.canRate && (
        <Feedback
          messageId={message.id}
          rating={message.rating}
          note={message.note}
          onRate={onRate}
          noteActions={noteActions}
        />
      )}
    </div>
  );
}
