# Conversations page

The dashboard's Conversations page (M4-4) lists a company's conversations and opens one transcript at a time, with the cost of each turn. Unlike Overview, Usage and Impact, it reads the raw tables (`conversations`, `messages`, `tool_calls`, `model_calls`, `feedback`, `change_requests`, `quality_issues`), not `activity_rollups`: it shows single conversations, which the rollups don't keep.

## What a request reads

Every route runs one read-only `withTenant` as `diletta_app`, so RLS applies on top of the DAL's `company_id` filters.

| Route                                    | Queries                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dashboard/conversations`           | Config filter choices (every ever-published config), one page of rows, one count query for every tab                                   |
| `GET /dashboard/conversations/export`    | Config filter choices, up to `CONVERSATIONS_EXPORT_MAX_ROWS` + 1 rows (5,001)                                                          |
| `GET /dashboard/conversations/:publicId` | The conversation, its messages with their ratings, its tool calls with their change requests, its spend per `turn_id`                  |
| `POST …/:publicId/flag`                  | The conversation, an advisory lock on (company, conversation), the open admin issue or a new one plus its `quality_issue.opened` event |

Each listed row carries three correlated subqueries, all on indexed reference columns: the turn count (a `UNION` of turn ids over `messages`, `tool_calls` and spend `model_calls`), the rating (any Down, else any Up) and whether an admin flag is open.

## A turn's cost

A turn is one `turn_id`. Its cost is `SUM(model_calls.cost_usd)` over that `turn_id` with `provider <> 'workers_ai'`: the company key's spend, the same rule as the Usage page. Workers AI calls (the search's embed and rerank) are platform-paid and left out. Pending rows count at their cost as it stands (0 until the per-minute backfill fills them) and the turn says "some cost is still coming in"; Unknown rows stay at 0 and the turn says "some cost is unknown". To check a turn by hand, as the owner role:

```sql
SELECT turn_id, sum(cost_usd), count(*) FILTER (WHERE usage_status = 2) AS pending
FROM model_calls
WHERE company_id = <id> AND conversation_id = <id> AND provider <> 'workers_ai'
GROUP BY turn_id;
```

## Known costs as data grows

The page is sized for today's volumes. Watch these if a company's conversations reach the hundreds of thousands:

- **Tab counts.** The count query reads every conversation of the company under the current filters, running two correlated `EXISTS` per row (Needs attention: a change request that needs a person or an open quality issue; Rated down: a Down rating on any reply). It runs on every list load. If it gets slow, bound it to a date range (`created_at` is indexed with `company_id`) or count only up to a cap and show "1,000+".
- **Export.** Up to 5,001 rows, each with the three per-row subqueries. Lower `CONVERSATIONS_EXPORT_MAX_ROWS` before raising the Worker's time limits.
- **Config filter choices.** Every config ever published, unpaged. One company has a handful per chatbot.

## When an admin flags a conversation

The flag opens an admin-source quality issue (Open, untriaged, no note) that lands in the Quality inbox (M4-6). At most one admin issue per conversation is open at a time: a second flag, even sent at the same moment, returns the open one (200) instead of opening another (201). Once that issue is dismissed or fixed, a new flag opens a new issue.
