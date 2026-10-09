# Budget

Every model call is checked against a budget before it goes out (M2-4). A call that doesn't fit is refused before it reaches AI Gateway or the provider: the widget shows "Temporarily unavailable", nothing is billed and no `model_calls` row is written.

## The limits

| Limit                               | Where it is set                                                                             | Default                     | Counted in                   | When it is hit                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------- | -------------------------------------------- |
| Company spending budget (UTC month) | `companies.spending_budget` (Settings › Budget, M4)                                         | $10 when NULL               | `BudgetDO` (one per company) | Unavailable until the 1st or a higher budget |
| Chatbot user cost per UTC day       | config `limits.userDailyCostCapUsd`                                                         | $10                         | `BudgetDO`                   | Unavailable for that user until midnight UTC |
| Chatbot user messages per minute    | config `limits.userMessagesPerMinute`                                                       | 10                          | `BudgetDO`                   | "You're sending messages too quickly…"       |
| Conversation turns per hour         | config `limits.conversationTurnsPerHour`                                                    | 60                          | Conversation DO              | "You're sending messages too quickly…"       |
| Conversation cost                   | config `limits.conversationCostCapUsd`                                                      | $5                          | Conversation DO              | Unavailable in that conversation             |
| Turn cost / tokens / steps / time   | config `limits.turnCostCapUsd`, `maxTokensPerTurn`, `maxStepsPerTurn`, `turnTimeoutSeconds` | $0.50 / 32,000 / 12 / 120 s | Conversation DO (per turn)   | The turn ends early                          |

Config limits are platform defaults (`packages/schemas/src/configSpec/ConfigSpecDefaults.ts`) unless the chatbot's published config sets them. The company default lives in `DEFAULT_SPENDING_BUDGET_USD` (`packages/schemas/src/budget/BudgetCommon.ts`). AI Gateway spend and rate limits stay the second wall.

## How a call is counted

1. Before each provider call (each retry too), its worst case is held: the prompt at 3 characters per token plus `max_tokens` (at most 8,192, and never more than the turn's tokens left), priced from `MODEL_PRICES`.
2. After the call, the hold becomes the call's real cost, the same number its `model_calls` row gets.
3. A call that ended without usage (`usage_status` Pending or Unknown) stays counted at its whole hold. The Cron backfill fixes the row's cost later, but not BudgetDO's count: the budget may overcount, never undercount.
4. A hold never settled (the caller was evicted mid-call) counts as spent in full after 20 minutes.

When a new month starts, BudgetDO seeds the month from `SUM(model_calls.cost_usd)` since the 1st (UTC). Pending rows add 0 until backfilled, so a seed taken right after the 1st can be a few cents low.

## Change a company's budget

Until Settings › Budget ships (M4), set it on the owner connection (`DATABASE_URL`, staging or production):

```sql
UPDATE companies SET spending_budget = 50, updated_at = now() WHERE public_id = '<company public id>';
-- back to the platform default:
UPDATE companies SET spending_budget = NULL, updated_at = now() WHERE public_id = '<company public id>';
```

BudgetDO re-reads the budget at most a minute later (`BUDGET_REFRESH_MS`). Spend already counted this month stays counted: raising the budget is what lets a company that hit 100% answer again before the 1st.

## Reading the logs

All budget logs use the `Budget` category (`LogCategory.Budget`):

- `ReserveBudget` / `AdmitBudgetTurn` warning "Budget refused" with `refusal`: a limit doing its job (`CompanyBudget`, `UserDailyCost`, `UserMessageRate`, …).
- The same with `refusal: Unavailable` is an **error**: BudgetDO couldn't read Neon (`GetBudgetSeed` error alongside) or was asked for another company. Calls fail closed until it can, so the chatbot is unavailable: check Hyperdrive and Neon.
- `SettleBudget` error: a settle didn't reach BudgetDO. The hold expires into spend after 20 minutes; nothing to fix by hand.
- `ExpireBudgetReservation` warning: a hold expired unsettled. Frequent ones mean turns are being evicted mid-call.

## Known gaps (after M2-4)

Not built yet, each tracked in the dev plan's open questions:

- **Budget alerts at 50% / 80% / 100%** (the Cron in the architecture). Nothing tells an admin the budget is running out; at 100% the chatbot just shows "Temporarily unavailable". No task owns it yet (suggested: with M6-6).
- **Loop guard** (same tool + same args twice in a turn → stop). There are no tools until M3 (`activeTools: []`), so there is nothing to guard. Add it with the first tool calls (M3-1 / M3-4), next to `stopWhen` in `ConversationDO.beforeTurn`.
- **Sub-agents sharing the parent turn's budget** (architecture cost box). None exist yet.

Known inaccuracies, all on the safe side except the last:

- A Pending / Unknown call stays counted at its whole hold in BudgetDO even after the Cron backfills its real cost in `model_calls`. BudgetDO never re-reads `model_calls` mid-month, so a company with many cut streams is overcounted until the 1st.
- An expired (never settled) hold is charged in full, even if the call was cheap or never sent.
- The reservation estimate (prompt at 3 characters per token, full `max_tokens`) is deliberately high, so a company close to its budget is refused a call it could have afforded.
- The conversation's spend (`spentMicros` in the Conversation DO's runtime state) misses a call whose settle never ran (DO evicted mid-call). BudgetDO still counts it; only `conversationCostCapUsd` can be passed by that call's cost.
- **Undercount:** the month's seed adds Pending rows at 0 (not yet backfilled), so right after the 1st the count can be a few cents low.
- When a user is both over their message rate and out of budget, they see the rate-limit text (rate is checked first).
