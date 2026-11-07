import * as Schemas from "@app/schemas";

// DEV_NOTE: A socket frame from the Conversation DO, parsed (Schemas.ZWidgetServerMessage) before anything reads it.
// Think's own chat frames, and anything that doesn't parse, are null here (Think's client handles its own).
export function parseServerFrame(data: unknown): Schemas.WidgetServerMessage | null {
  if (typeof data !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = Schemas.ZWidgetServerMessage.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// DEV_NOTE: The conversation frame's ratings, by reply id
export function ratingsOf(
  feedback: Schemas.WidgetFeedbackRatingState[],
): Record<string, Schemas.FeedbackRatingIntEnum> {
  return Object.fromEntries(feedback.map((entry) => [entry.messageId, entry.rating]));
}

// DEV_NOTE: The ratings that carry a stored note (M7-10) show as sent. Their text stays on the server, so Edit note
// opens an empty box and a send replaces the stored note.
export function notesOf(
  feedback: Schemas.WidgetFeedbackRatingState[],
): Record<string, Schemas.WidgetFeedbackNoteState> {
  return Object.fromEntries(
    feedback
      .filter((entry) => entry.hasNote)
      .map((entry) => [
        entry.messageId,
        { status: Schemas.WidgetFeedbackNoteStatusEnum.Sent, text: "", hasSaved: true },
      ]),
  );
}
