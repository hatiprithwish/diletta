# Quality inbox

The dashboard's Quality page (M4-6) is where a company works through its quality issues: thumbs-downs from users (M2-8), conversations an admin flagged (M4-4) and automatic checks such as a rejected model key (M2-3) or a chatbot's day going clearly worse than usual (M5-5, `docs/runbooks/health.md`). A health drop is about the whole chatbot, not one conversation: it has no excerpt and can't become a test (`test-draft` / `convert` answer 409 `NoConversation`); mark it fixed or dismiss it. A growing group of unanswered questions (M5-6, `docs/runbooks/knowledge.md`) opens one item too, titled "Unanswered questions: <question>", with no excerpt and no Create test: answering or dismissing the group on the Knowledge page closes it. Each issue is triaged (a type and a note), then closed one way: marked fixed, dismissed, or turned into a test.

## Statuses

| Status    | Reached by                    | Leaves it?                                                 |
| --------- | ----------------------------- | ---------------------------------------------------------- |
| Open      | Every issue starts here       | Yes, once, through one of the three actions below          |
| Fixed     | Mark fixed                    | No                                                         |
| Dismissed | Dismiss                       | No                                                         |
| Converted | Create test, once it is saved | No. `eval_case_id` points at the test (CHECK on the table) |

Triage (type, note) works only while the issue is Open. Every action locks the row, so two admins acting at once get one success and one 409 ("This issue was already closed").

Each action writes one `quality_issue.<action>` event to `activity_log` and `event_outbox` in the same transaction, with actor Admin: `triaged` (detail: the type and whether there is a note, never the note's text), `fixed`, `dismissed`, `converted` (detail: the eval case id).

## Create test

1. **Draft.** `POST /dashboard/quality-issues/:publicId/test-draft` reads the conversation's newest messages (at most `EVAL_CASE_MAX_MESSAGES + 1`, text only) up to the question before the reply the issue is about: the rated reply for a user issue; otherwise the last reply, or the chat's last question when nobody answered it (then there is no reply that went wrong). It keeps the newest messages that fit `QUALITY_TEST_REWRITE_MAX_CHARS` in total (12,000), each cut at `EVAL_CASE_MESSAGE_MAX_CHARS`, because the model restates them in its answer, which has an output cap of 8,192 tokens. It then asks the model router for a rewrite with no personal details:
   - It uses the chatbot's published routing at tier Mid, with task type `quality.test_rewrite`.
   - It runs on the company's own key, and the budget is held like any other call.
   - The call is recorded as the chatbot's, with no conversation, so it shows under Usage › Test runs and never adds to the conversation's cost.
   - Nothing is saved.
   - A second router call (`quality.test_check`, tier Small, same budget and Usage line) reads the draft alone and lists the names it finds. If it doesn't run, the draft still comes back and the dialog says the extra check was skipped.
2. **Review.** The admin edits the name, each message and the rubric (what a good reply does and must not do). The dialog lists what the check flagged (see below).
3. **Save.** `POST /dashboard/quality-issues/:publicId/convert` writes the reviewed draft as the chatbot's `eval_cases` row and moves the issue to Converted, in one transaction:
   - `input` holds `{schemaVersion: 1, messages}`, ending with the user's question.
   - `expectations` holds `{schemaVersion: 1, rubric}`.
   - The row is active and is never a safety case.

The server saves what the admin saw, nothing from the model directly, and only after its own check passes.

### The personal details check (M5-7)

`Schemas.findQualityTestPersonalDetails` runs at draft and again at save, when the server re-reads the chat. It looks at the test's name, messages and rubric. Parts a host sends in place of a name ("Test User") are skipped. An issue with no rated reply reads the chat up to when it was opened, so messages sent later never change what the check compares.

| Found in the test                                                                                     | What the admin can do                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A part of the chat user's display name, an email, or a run of 6 or more digits                        | Edit it out. It can't be confirmed.  |
| A name part that is also an everyday word ("Will", "May"), written as the name is                     | Edit it out, or tick "Not personal". |
| A capitalised word from inside a sentence of the chat or note (the chat never writes it in lowercase) | Edit it out, or tick "Not personal". |
| A name the model's check listed (draft only)                                                          | Edit it out, or tick "Not personal". |

A save with something left answers 409 `PersonalDetailsFound` with the terms, writes nothing, and keeps the dialog open. The `converted` event records `confirmedTermCount` (the flags the confirmation cleared), never the words: a wrongly confirmed name stays out of `activity_log`.

**What isn't guaranteed.** A name opening a sentence or written in lowercase is invisible to the save's rules unless it is part of the user's display name. The model's check flags it at draft, the browser holds the save until it is dealt with, but the server can't enforce that, since the model's names aren't stored. A date written with 6 or more digits counts as a long number; reword it.

### When there is no draft or the save is refused

| Answer     | `failure`              | Meaning and what to do                                                                                                                                                                           |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 409        | `NotOpen`              | The issue was closed meanwhile.                                                                                                                                                                  |
| 409        | `NoConversation`       | The chat's content was purged, or the user never asked anything. Dismiss or mark it fixed instead.                                                                                               |
| 409        | `NoPublishedConfig`    | The chatbot has no published config, so there is no routing to call. Publish it (Settings › Bots).                                                                                               |
| 503        | `ModelUnavailable`     | The router refused: no active key for the Mid tier's provider, the budget is used up, or the provider is down. Check Settings › Model keys and Budget; a rejected key also opens a system issue. |
| 502        | `RewriteFailed`        | The model's answer wasn't a usable draft (not the shape asked for, or over the limits). Try again.                                                                                               |
| 409 (save) | `PersonalDetailsFound` | The test still holds a flagged term. Nothing was written; the dialog lists it. Edit it out or, where allowed, tick "Not personal".                                                               |
| 409 (save) | `ChatbotNotFound`      | The conversation's chatbot was removed, so no chatbot can own the test. Nothing was written; dismiss the issue or mark it fixed.                                                                 |

## What M5 adds

M5-1 extends the case shape (readback asserts, tool calls, forbidden tools) as v2, with an upgrader from v1; stored v1 rows are never rewritten. M5-7 added the personal details check above. A saved test runs through the eval harness (`docs/runbooks/evals.md`).

## Checking by hand

As the owner role, an issue's history and its test:

```sql
SELECT entity_action, actor_type, actor_id, detail, created_at
FROM activity_log
WHERE company_id = <id> AND entity_type = 'quality_issue' AND entity_id = <issue id>
ORDER BY created_at;

SELECT q.status, e.public_id, e.name, e.input, e.expectations
FROM quality_issues q LEFT JOIN eval_cases e ON e.id = q.eval_case_id
WHERE q.public_id = '<issue public id>';
```
