# Security

The Security page (M4-9, `/security`) shows how the widget proves who the user is, the company's encryption keys, how long chat content is kept, prompt-injection events (found by the chatbot itself since M6-4) and the audit log. Company admins see and change their own company; operators get 403 (the dashboard is company-level).

## Identity and origins

One card per connection (production first, then staging): the JWT issuer, when its signing keys were last fetched, and the allowed origins.

- **Signing keys** come from the JWKS cache (`JWKS_CACHE`, `jwks:<issuer>`, 1 h TTL). "Last refreshed" is the cached set's `fetchedAt`; nothing cached shows "Fetched from the issuer when a user next signs in". The page never fetches the issuer itself.
- **Edit** replaces the connection's allowed origins (`PUT /dashboard/security/connections/:publicId/origins`). Each must be an exact origin (`https://host[:port]`, no path, no trailing slash), at least one, at most 20, each once. Order doesn't matter: the same origins in another order change nothing and record no row. The widget gate reads the new list at the next connect; open widgets keep their socket.
- **The issuer** is not editable here: it decides which keys the platform trusts and is unique across companies, so an operator sets it (and the connection) with the company.

## Encryption keys

Every version of the company key, newest first, with its status, when it was created and when it stopped being the active key (the next version's creation time: a rotation creates it in the same transaction).

- **Rotate key** (after a confirm) makes a new version active at once and moves the old one to Retiring; new writes use the new key and stored values keep decrypting with their own version.
- **One rotation at a time.** While a key is Retiring, the button is disabled and a direct call answers 409 (`RotationInProgress`). Two rotations at the same moment run one after the other (the key rows are locked), so the second gets the same 409.
- **The rotation job** (`KeyRotationSweep`, every 15-minute cron tick, and once right after a rotation) moves every stored value off the Retiring key: secrets, chatbot user credentials, tool call arguments and change values are decrypted with the old version and encrypted again under the Active key. When no value is left on the old key it is destroyed (its bytes are deleted; the row stays, Destroyed) and the log gets a System "Retired encryption key" row on that version. A small company finishes in seconds; a large one over a few ticks.
- **No value can be left behind.** Every write reads the Active key with a share lock, so a rotation waits for writes already under way on the old key; the job counts every column again, under the key rows' lock, before it destroys anything.
- **Stuck Retiring.** A value that won't decrypt (logged as `ReEncryptValue` with the row id and column, never the value) is skipped and keeps the old key Retiring, and so blocks the next rotation. After 24 h the job alerts ("Encryption key rotation is overdue", `SweepKeyRotation`, with the company id). Find the row (as the owner role, `WHERE company_id = … AND encryption_key_version = <old>` on the four tables), work out why it doesn't decrypt, and fix or delete that row; the next tick finishes. Never re-encrypt rows by hand: live writes would race it.

## Retention

"Keep chat content for" is one of 7, 30, 90, 180 or 365 days, counted from a conversation's last message (`companies.content_retention_days`; empty = 30, shown as the default). Saving records an audit row, unless it changes nothing: saving 30 while on the default stores nothing and records nothing.

- The hourly `ContentRetentionPurge` cron (`ContentRetentionRepo`) clears chats past the period. Companies take `CONTENT_PURGE_BATCH_SIZE` chats in turn until none is due or `CONTENT_PURGE_TIME_BUDGET_MS` is used up; a backlog carries over. Shortening the period applies at the next run and can't be undone: what it clears is gone.
- **Goes:** the Conversation DO's whole storage (transcript, state, schedules), `messages.content`, `conversations.title`, `tool_calls` args, `change_requests` values (NeedsHuman too: retention is their backstop, the status stays), `feedback.comment`, an eval attempt's transcript (row + R2 object), and `doc_gaps.conversation_id` + `message_id`.
- **Stays:** message and tool call rows, statuses, outcomes, costs, rollups, ratings, eval grades, and `doc_gaps.question_generic`.
- **Known exception:** `quality_issues.note` stays. An admin wrote it as their triage record, so an admin who pastes chat text there keeps it there.
- **Doc gaps:** a purged gap still counts as a question, but its user no longer counts toward a group's 3 different users (the link is gone), so a group growing slower than the retention period may not reach its Quality item.
- **Closing outcome:** an Open chat closes with the outcome read from its stored messages: a reply = Answered (Idk with a doc gap on the last question), else Abandoned. Rollups only rebuild today and yesterday, so this doesn't reach the chat's start day until an operator rebuilds that day.
- **Order and retries:** close, wipe the DO, delete R2 objects, then one transaction clears the tables and sets `content_purged_at`. A failure or a running turn leaves the chat due for next hour. `destroy()` aborts the DO, so the first run can log "Conversation DO not wiped this run"; the next finds nothing left and finishes. Chats tried longest ago go first (`content_purge_attempted_at`), so failing chats can't hold back the rest.
- **Stuck purge:** the error "Chat content is overdue for deletion" (Sentry) names a company with a chat more than `CONTENT_PURGE_OVERDUE_ALERT_MS` past its cut-off after a run: a step keeps failing or the backlog is outrunning the budget. Search the logs for `PurgeConversationContent`. `skippedCount` rising every hour means a step keeps failing; a high `purgedCount` with no skips means a backlog still draining.
- Model gateway logs are kept 7 days (AI Gateway setting, not this page).

## Erase a user

An admin enters the user's ID in their app under **Retention and erasure** and confirms. It can't be undone.

- **At once, in one transaction:** the user's ID and name are replaced (`host_user_id` = `erased:<random>`, `erased_at` set), their saved credentials are deleted, admin notes on quality issues in their chats are cleared, and an audit row records **Erased a user** with a chat count and never the ID. Keep your own record of who was erased: the log can't say.
- **Right after:** each chat goes through the retention purge's steps, whatever its age. Whatever that doesn't reach (a turn running, a failure, more chats than the first pass fits) is due in the next hourly `ContentRetentionPurge`, which alerts ("Chat content is overdue for deletion") when an erased user's chat is still there a day later.
- **Stays, anonymous:** message, tool call and feedback rows without content, costs, outcomes, rollups, the audit trail of the user's own actions, budget counters, doc gap text (personal details already removed), and tests made from their issues (they passed the personal details check and name no user).
- **Files:** the widget has no uploads, so a user's files are eval attempt transcripts. Knowledge files belong to the company.
- **Comes back:** the same ID from the host means a new, empty user. Their old chats can't be resumed. To keep someone out, the host stops signing tokens for them.
- **Unknown or already erased ID:** 404 and nothing changes.
- **Out of reach:** model gateway logs clear within 7 days (ADR 0003). An error log line from before the erasure may hold the host ID until the log store expires it. Writes already made in the host app stay there.

## Prompt-injection events

The events are the company's quality issues typed **Prompt injection**, in any status, newest first: the ones an admin typed on the Quality page, and the ones the chatbot opened itself when it found one (M6-4). "Detected in" is the issue's note (else where it came from), "Action taken" its status in words (an automatic one still open reads **Blocked, waiting for review**), and each row links to the issue and the conversation (no title once the conversation is purged).

### What the chatbot checks and does (M6-4)

- **Checked:** the user's message, every help doc result a search returns, and every record a read tool brings back from your app. The check looks for instructions aimed at the chatbot: telling it to ignore its instructions, switch into another role or mode, reveal its hidden instructions, pose as a system message, claim a change is already approved, or send the chat to an outside address. It doesn't judge topics: a help page about setup instructions or a record about override rules passes.
- **Blocked in a help doc or a record:** only the part that held it is kept from the chatbot. A help doc result is left out of the search (never cited); in a record, only that field is replaced with "[withheld…]" and the rest of the record is read as usual. The conversation carries on normally: the chatbot never saw the text, and any change it proposes after reading help docs or records already needs the user's approval. One poisoned record can't switch changes off for everyone who reads it.
- **Blocked in a note on a rating (M7-10):** the note isn't saved (the rating is), and the user is told their note wasn't sent. Nothing else changes: a note is never read by the chatbot during the chat.
- **Blocked in the user's message:** the message can't be held back, so from that turn on the conversation makes no changes: it can only look things up, and a change the model still tries is refused. Changes already waiting for the user's approval stay as they are, since the user approves them from the real values. To make changes, the user starts a new conversation. A message whose turn was refused (a rate limit, the chatbot unavailable) never reached the chatbot and turns nothing off.
- **Logged:** each finding opens one issue (source System, type Prompt injection) with a note saying where it was found (the help doc's title, or the tool and the field of the record), what it tried and what the chatbot did, never the text. A help doc opens one issue however many chats find it; anything else opens one per conversation. Repeats are in the logs only. Test runs are blocked the same way but open no issue. A question that held one never becomes an unanswered-question group.
- **What to do:** open the conversation from the event. Text in the user's own message is usually someone testing the chatbot: dismiss it. In a help doc or a record, someone could edit that content: find it (the doc's source, or the record in your app, using the tool and field in the note), clean it up, then mark the issue fixed. A false alarm (an ordinary sentence caught by a rule) is worth telling us about, with the conversation's ID, so the rules can be tuned.
- **Links:** a reply's links work only to your app's allowed origins (Identity and origins, above), to the help docs it cites, and to plain email addresses. Any other link (including an email link with a prefilled subject or body) shows as plain text, so a link can't carry the chat to another site.
- **Safety tests:** every chatbot's gate runs the platform's prompt-injection safety cases (pasted text with hidden instructions, a faked earlier developer-mode message, a link built from the chat, a role-play with no rules), on top of the original "ignore your instructions" case. A failing one blocks publishing like any safety case.

## Audit log

The audit log is not its own table. It is the company's `activity_log` rows written by a person: an admin of the company (actor Admin) or a Diletta operator (actor Operator), plus the platform's own moves of a chatbot version (actor System, M5-4: a gate run's finish making it Ready or a draft again; `Schemas.AUDIT_SYSTEM_ENTITY_TYPES`). Chatbot users' and the system's other events stay out of it.

### What writes a row

Every dashboard and operator write records one row, in the write's own transaction, through `recordAuditOrRollback` (`repositories/audit.ts`, over `AuditEventProvider.record`). It is a critical event (`activity_log` + `event_outbox`), so a write never commits without its row, and the row is relayed to the events queue after the commit like any other event (the queue consumer logs and acks it).

| Where                       | Actions                                                                                                                 | On                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Chatbots                    | Created, Renamed, Paused, Resumed                                                                                       | the chatbot's name           |
| Knowledge sources           | Added, Edited (name or frequency), Paused, Resumed, Synced (Sync now / Retry), Deleted                                  | the source's name            |
| Knowledge files             | Uploaded, Removed                                                                                                       | the file's title             |
| Unanswered questions        | Answered with a document, Dismissed                                                                                     | the group's label            |
| Test cases                  | Created, Edited, Turned on, Turned off                                                                                  | the case's name              |
| Minutes saved (Impact)      | Changed                                                                                                                 | the task                     |
| Tool definitions (operator) | Added, Edited, Created version, Activated, Disabled, Deleted draft                                                      | the tool's name + version    |
| Allowed origins             | Changed                                                                                                                 | the environment              |
| Encryption key              | Rotated; System: Retired                                                                                                | the version                  |
| Chat retention              | Changed                                                                                                                 | the days                     |
| Chatbot versions            | Started, Edited, Discarded, Sent to testing, Moved back to draft, Published; System: Passed its tests, Failed its tests | the chatbot's name + version |

The writes that already had an admin event show up as they are: Flag a conversation, the Quality page's triage / fixed / dismissed / turned into a test, and Mark resolved on the Changes page.

Rules:

- One row per thing that happened. A save that changes a name and a status records two rows; a save that changes nothing records none; a refused request (409, 404) records none.
- A sync the platform starts (a new web source's first sync, an upload, a resumed upload source, the hourly re-sync) has no row: only an admin's Sync now does.
- The row stores a label only (`detail.label`, at most 200 characters): a name, title or task the company gave. Never chat text, a change's values, a case's conversation or a secret.
- Operators' names are never shown to a company (RLS hides operator rows from a tenant): their rows read "Operator".

### Reading it

`GET /dashboard/audit-log` (paged, newest first), `/count` and `/export` (at most 5,000 rows, `isTruncated` beyond) for the signed-in admin's company (`AuditLogRead`). A partial index, `IDX_activity_log_company_id_created_at_audit` (company, created_at) where the actor is an admin or operator, (and the System rows of the audit's system entity types: chatbot versions, M5-4, and encryption keys, M6-3) serves all three without reading the company's other events.

The migration that adds it (`20261025115726_diletta`) is a plain `CREATE INDEX` on the partitioned parent: it builds the index on every partition while holding a SHARE lock, so `activity_log` inserts (every critical event) wait until it finishes. That is accepted while the table is small. If a deploy ever has to add an index to a large `activity_log`, build it without blocking instead: `CREATE INDEX … ON ONLY activity_log …`, then `CREATE INDEX CONCURRENTLY` on each partition (outside a transaction), then `ALTER INDEX … ATTACH PARTITION` for each.

### Checking a company's rows by hand

As the owner role on the right branch:

```sql
SELECT created_at, actor_type, actor_id, entity_type, entity_action, entity_version, detail
FROM activity_log
WHERE company_id = <companies.id> AND actor_type IN (2, 3)
ORDER BY created_at DESC
LIMIT 50;
```

### Known gaps

- Security page writes show as "Changed allowed origins" (on the environment), "Rotated encryption key" (on the new version) and "Changed chat retention" (on the days).
- Rows for quality issue and change events (written before the audit log) have no label, so their On column is empty.
- Creating a company and rebuilding rollups (operator maintenance) record no row.
