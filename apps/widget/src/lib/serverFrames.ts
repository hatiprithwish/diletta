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
  feedback: Schemas.WidgetFeedbackRating[],
): Record<string, Schemas.FeedbackRatingIntEnum> {
  return Object.fromEntries(feedback.map((entry) => [entry.messageId, entry.rating]));
}
