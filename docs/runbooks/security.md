# Security

The Security page (M4-9) shows how the widget proves who the user is, the company's encryption keys, how long chat content is kept, prompt-injection events and the audit log. This runbook covers the audit log; the page's other sections land with the page.

## Audit log

The audit log is not its own table. It is the company's `activity_log` rows written by a person: an admin of the company (actor Admin) or a Diletta operator (actor Operator). Chatbot users' and the system's events stay out of it.

### What writes a row

Every dashboard and operator write records one row, in the write's own transaction, through `AuditEventProvider.record`. It is a critical event (`activity_log` + `event_outbox`), so a write never commits without its row, and the row is relayed to the events queue after the commit like any other event (the queue consumer logs and acks it).

| Where                       | Actions                                                                                | On                        |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| Chatbots                    | Created, Renamed, Paused, Resumed                                                      | the chatbot's name        |
| Knowledge sources           | Added, Edited (name or frequency), Paused, Resumed, Synced (Sync now / Retry), Deleted | the source's name         |
| Knowledge files             | Uploaded, Removed                                                                      | the file's title          |
| Unanswered questions        | Answered with a document, Dismissed                                                    | the group's label         |
| Test cases                  | Created, Edited, Turned on, Turned off                                                 | the case's name           |
| Minutes saved (Impact)      | Changed                                                                                | the task                  |
| Tool definitions (operator) | Added, Edited, Created version, Activated, Disabled, Deleted draft                     | the tool's name + version |

The writes that already had an admin event show up as they are: Flag a conversation, the Quality page's triage / fixed / dismissed / turned into a test, and Mark resolved on the Changes page.

Rules:

- One row per thing that happened. A save that changes a name and a status records two rows; a save that changes nothing records none; a refused request (409, 404) records none.
- A sync the platform starts (a new web source's first sync, an upload, a resumed upload source, the hourly re-sync) has no row: only an admin's Sync now does.
- The row stores a label only (`detail.label`, at most 200 characters): a name, title or task the company gave. Never chat text, a change's values, a case's conversation or a secret.
- Operators' names are never shown to a company (RLS hides operator rows from a tenant): their rows read "Operator".

### Reading it

`GET /dashboard/audit-log` (paged, newest first), `/count` and `/export` (at most 5,000 rows, `isTruncated` beyond) for the signed-in admin's company (`AuditLogRead`). A partial index, `IDX_activity_log_company_id_created_at_audit` (company, created_at) where the actor is an admin or operator, serves all three without reading the company's other events.

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
- Rows for quality issue and change events (written before the audit log) have no label, so their On column is empty.
- Creating a company and rebuilding rollups (operator maintenance) record no row.
