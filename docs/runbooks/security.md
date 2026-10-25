# Security

The Security page (M4-9, `/security`) shows how the widget proves who the user is, the company's encryption keys, how long chat content is kept, prompt-injection events and the audit log. Company admins see and change their own company; operators get 403 (the dashboard is company-level).

## Identity and origins

One card per connection (production first, then staging): the JWT issuer, when its signing keys were last fetched, and the allowed origins.

- **Signing keys** come from the JWKS cache (`JWKS_CACHE`, `jwks:<issuer>`, 1 h TTL). "Last refreshed" is the cached set's `fetchedAt`; nothing cached shows "Fetched from the issuer when a user next signs in". The page never fetches the issuer itself.
- **Edit** replaces the connection's allowed origins (`PUT /dashboard/security/connections/:publicId/origins`). Each must be an exact origin (`https://host[:port]`, no path, no trailing slash), at least one, at most 20, each once. The widget gate reads the new list at the next connect; open widgets keep their socket.
- **The issuer** is not editable here: it decides which keys the platform trusts and is unique across companies, so an operator sets it (and the connection) with the company.

## Encryption keys

Every version of the company key, newest first, with its status, when it was created and when it stopped being the active key.

- **Rotate key** (after a confirm) makes a new version active at once and moves the old one to Retiring; new writes use the new key and stored values keep decrypting with their own version.
- **One rotation at a time.** While a key is Retiring, the button is disabled and a direct call answers 409 (`RotationInProgress`). The job that re-encrypts rows and retires the old key is M6-3; until it lands, a Retiring key stays Retiring and a second rotation isn't possible. There is no manual unblock: re-encrypting the old key's rows by hand would race live writes.

## Retention

"Keep chat content for" is one of 7, 30, 90, 180 or 365 days, counted from a conversation's last message (`companies.content_retention_days`; empty = 30, shown as the default). Saving records an audit row.

- The purge that deletes transcripts past the period is M6-1. Until it runs, the setting is stored and shown, and the page says transcripts are kept until automatic deletion is switched on.
- Model gateway logs are kept 7 days (AI Gateway setting, not this page).
- **Erase a user** is not on the page yet: user erasure end to end (chats, files, saved credentials) is M6-2.

## Prompt-injection events

Until M6-4 detects them automatically, the events are the company's quality issues typed **Prompt injection** on the Quality page, in any status, newest first. "Detected in" is the issue's note (else where it came from), "Action taken" its status in words, and each row links to the issue and the conversation (no title once the conversation is purged).

## Audit log

The audit log is not its own table. It is the company's `activity_log` rows written by a person: an admin of the company (actor Admin) or a Diletta operator (actor Operator). Chatbot users' and the system's events stay out of it.

### What writes a row

Every dashboard and operator write records one row, in the write's own transaction, through `recordAuditOrRollback` (`repositories/audit.ts`, over `AuditEventProvider.record`). It is a critical event (`activity_log` + `event_outbox`), so a write never commits without its row, and the row is relayed to the events queue after the commit like any other event (the queue consumer logs and acks it).

| Where                       | Actions                                                                                | On                        |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| Chatbots                    | Created, Renamed, Paused, Resumed                                                      | the chatbot's name        |
| Knowledge sources           | Added, Edited (name or frequency), Paused, Resumed, Synced (Sync now / Retry), Deleted | the source's name         |
| Knowledge files             | Uploaded, Removed                                                                      | the file's title          |
| Unanswered questions        | Answered with a document, Dismissed                                                    | the group's label         |
| Test cases                  | Created, Edited, Turned on, Turned off                                                 | the case's name           |
| Minutes saved (Impact)      | Changed                                                                                | the task                  |
| Tool definitions (operator) | Added, Edited, Created version, Activated, Disabled, Deleted draft                     | the tool's name + version |
| Allowed origins             | Changed                                                                                | the environment           |
| Encryption key              | Rotated                                                                                | the new version           |
| Chat retention              | Changed                                                                                | the days                  |

The writes that already had an admin event show up as they are: Flag a conversation, the Quality page's triage / fixed / dismissed / turned into a test, and Mark resolved on the Changes page.

Rules:

- One row per thing that happened. A save that changes a name and a status records two rows; a save that changes nothing records none; a refused request (409, 404) records none.
- A sync the platform starts (a new web source's first sync, an upload, a resumed upload source, the hourly re-sync) has no row: only an admin's Sync now does.
- The row stores a label only (`detail.label`, at most 200 characters): a name, title or task the company gave. Never chat text, a change's values, a case's conversation or a secret.
- Operators' names are never shown to a company (RLS hides operator rows from a tenant): their rows read "Operator".

### Reading it

`GET /dashboard/audit-log` (paged, newest first), `/count` and `/export` (at most 5,000 rows, `isTruncated` beyond) for the signed-in admin's company (`AuditLogRead`). A partial index, `IDX_activity_log_company_id_created_at_audit` (company, created_at) where the actor is an admin or operator, serves all three without reading the company's other events.

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

- System actions on security settings (the M6-3 key rotation job) aren't in the log yet: that job adds its rows when it lands.
- Security page writes show as "Changed allowed origins" (on the environment), "Rotated encryption key" (on the new version) and "Changed chat retention" (on the days).
- Rows for quality issue and change events (written before the audit log) have no label, so their On column is empty.
- Creating a company and rebuilding rollups (operator maintenance) record no row.
