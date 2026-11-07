# Feedback notes and themes (M7-10)

A widget user can leave an optional note when they rate a reply. Each note is read by a model on the company's own key, rewritten without personal details, and grouped with similar notes into **themes**, per chatbot and per thumb ("Didn't like" or "Liked").

## How a note travels

1. The widget sends the note after its rating is saved (`feedback_note` frame, at most 1,000 characters).
2. The Conversation DO checks it for prompt injection. A flagged note is not saved; it is recorded like any other detection (Security page) and the user sees "Your note wasn't sent."
3. `FeedbackRepo.recordFeedbackNote` stores it in `feedback.comment`, bumps `feedback.comment_version` and writes a `feedback.note_added` event (ids and the version only, never the text).
4. The events queue hands it to `FeedbackThemesRepo.processNote`:
   - a note cleared or edited since the event is dropped (the newer version has its own event);
   - the model (`feedback_note.rewrite`, small tier, the company's key and budget) answers whether the note says something specific and, if so, a one-sentence summary with no personal details. Not specific, or a summary that still holds an email or a long number, is dropped;
   - the summary is embedded (`feedback_note.embed`, Workers AI, platform-paid) and joins the closest Open or Dismissed theme of the same chatbot and thumb at cosine ≥ 0.85, else starts a new theme labelled with it.
5. A Didn't like theme that reaches **5 notes from 3 different users** opens one Quality item (type "User feedback", no conversation). A theme opens one item ever. Liked themes never open one.

Switching thumbs clears the note and takes its summary out of its theme. An edit replaces the summary and moves it to whichever theme the new one fits.

## What is kept where

- `feedback.comment`: the user's own words. Shown to admins on the transcript and the Quality issue. Cleared by the retention purge with the rest of the chat.
- `feedback_notes.summary`: the model's rewrite, no personal details. Kept after the purge, like doc gap questions.
- Neither is ever logged or put in an event.

## When notes don't group

- **No themes at all:** check the events consumer logs for `ProcessFeedbackNote`. "The model can't be used" means a missing key or a spent budget (see `budget.md`, `model-keys.md`). "The chatbot has no published config" means there is nothing to route the rewrite with.
- **A message keeps retrying:** a provider or embedding failure. It retries, then goes to the DLQ like any event (`observability.md`).
- **Many single-note themes on one subject:** the 0.85 threshold is `Schemas.FEEDBACK_THEME_MIN_SIMILARITY`. Changing it only affects new notes.

## Checking by hand

As the owner role, a company's themes and what is in them:

```sql
SELECT t.public_id, t.rating, t.status, t.note_count, t.label,
       count(DISTINCT n.chatbot_user_id) AS users
FROM feedback_themes t LEFT JOIN feedback_notes n ON n.theme_id = t.id
WHERE t.company_id = <id>
GROUP BY t.id
ORDER BY t.updated_at DESC;
```
