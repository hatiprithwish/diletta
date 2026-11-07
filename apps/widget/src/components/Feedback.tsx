import { useId } from "react";
import { Check, ThumbsDown, ThumbsUp, Warning } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { Textarea } from "@app/ui/components/textarea";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Thumbs on a finished reply. The visitor can switch between them; a pressed one shows filled. Once a thumb is
// saved, an optional note box opens under it (M7-10): Send stores the note on that rating, Not now closes it. A stored
// note shows as "Thanks for the note" with Edit note; one the DO didn't store says so, with Try again (the rating is
// saved either way).
export default function Feedback({
  messageId,
  rating,
  note,
  onRate,
  noteActions,
}: Schemas.WidgetFeedbackProps) {
  const isUp = rating === Schemas.FeedbackRatingIntEnum.Up;
  const isDown = rating === Schemas.FeedbackRatingIntEnum.Down;
  const isSent = note?.status === Schemas.WidgetFeedbackNoteStatusEnum.Sent;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Helpful"
          aria-pressed={isUp}
          onClick={() => onRate(messageId, Schemas.FeedbackRatingIntEnum.Up)}
          className="text-muted-foreground aria-pressed:text-foreground"
        >
          <ThumbsUp weight={isUp ? "fill" : "regular"} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Not helpful"
          aria-pressed={isDown}
          onClick={() => onRate(messageId, Schemas.FeedbackRatingIntEnum.Down)}
          className="text-muted-foreground aria-pressed:text-foreground"
        >
          <ThumbsDown weight={isDown ? "fill" : "regular"} />
        </Button>
        {isSent && (
          <>
            <span className="ml-2 inline-flex items-center gap-1.5 text-caption text-subtle-foreground">
              <Check className="size-3.5 text-brand-text" aria-hidden />
              Thanks for the note
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => noteActions.onNoteEdit(messageId)}
              className="ml-auto text-caption font-medium text-brand-text"
            >
              Edit note
            </Button>
          </>
        )}
      </div>
      {note && rating !== null && !isSent && (
        <NoteBox messageId={messageId} rating={rating} note={note} noteActions={noteActions} />
      )}
    </div>
  );
}

function NoteBox({ messageId, rating, note, noteActions }: Schemas.WidgetFeedbackNoteBoxProps) {
  const fieldId = useId();
  if (note.status === Schemas.WidgetFeedbackNoteStatusEnum.NotSent) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-xl bg-destructive-soft px-3 py-2.5 text-caption text-destructive"
      >
        <Warning className="size-4 shrink-0" aria-hidden />
        <span className="grow">Your note wasn't sent. Your rating is saved.</span>
        <Button variant="outline" size="sm" onClick={() => noteActions.onNoteSend(messageId)}>
          Try again
        </Button>
      </div>
    );
  }

  const isSending = note.status === Schemas.WidgetFeedbackNoteStatusEnum.Sending;
  const length = note.text.trim().length;
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        noteActions.onNoteSend(messageId);
      }}
    >
      <label htmlFor={fieldId} className="text-caption font-medium text-foreground">
        {rating === Schemas.FeedbackRatingIntEnum.Down ? "What went wrong?" : "What was helpful?"}{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <Textarea
        id={fieldId}
        rows={3}
        value={note.text}
        maxLength={Schemas.FEEDBACK_NOTE_MAX_CHARS}
        placeholder="Tell us more"
        disabled={isSending}
        onChange={(event) => noteActions.onNoteChange(messageId, event.target.value)}
        className="resize-none text-sm"
      />
      <div className="flex items-center gap-1.5">
        <span className="grow text-widget-note text-muted-foreground">
          {note.text.length.toLocaleString("en")} /{" "}
          {Schemas.FEEDBACK_NOTE_MAX_CHARS.toLocaleString("en")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isSending}
          onClick={() => noteActions.onNoteDismiss(messageId)}
          className="text-subtle-foreground"
        >
          Not now
        </Button>
        <Button type="submit" size="sm" aria-label="Send note" disabled={isSending || length === 0}>
          {isSending ? "Sending" : "Send"}
        </Button>
      </div>
      <p className="text-widget-note text-muted-foreground">
        Your rating is saved. The note goes to the team behind this assistant, so leave out personal
        details.
      </p>
    </form>
  );
}
