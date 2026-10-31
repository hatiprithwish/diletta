# Production health per chatbot

Once a day the backend checks how each chatbot did in production yesterday and raises a Quality item when it did clearly worse than usual (M5-5). It catches a regression in live traffic: a bad publish, a knowledge source that went stale, a host API that started refusing writes.

## What it checks

At 04:00 UTC (`ChatbotHealthCheck` cron), for every chatbot of every Active company, yesterday (UTC) against the 7 days before it, from the chatbot's live `activity_rollups` (eval runs are never in them):

| Signal                             | Share                                                                                                                            | Needs at least (each side) |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Replies rated down                 | thumbs-down ÷ all ratings                                                                                                        | 10 ratings                 |
| Conversations it couldn't answer   | conversations ending "couldn't answer" ÷ conversations started                                                                   | 20 conversations           |
| Changes that needed help or failed | change requests ending Needs help or Failed ÷ every change request that ended (verified, needed help, failed, rejected, expired) | 5 changes                  |

A signal drops when yesterday's share is at least **15 percentage points** above the baseline's. Too little traffic on either side means no judgement for that signal. The numbers live in `packages/schemas/src/chatbotHealth/ChatbotHealthCommon.ts` (`CHATBOT_HEALTH_*`) and are unit-tested there.

## What happens on a drop

- **Quality page.** The chatbot gets one open issue, source Automatic check, type Health drop, titled "Daily health check: <chatbot>". Its note says what dropped, e.g. "Oct 30: Replies rated down 70% (usually 10%)." It has no conversation, so it has no excerpt, no Create test and no Open conversation; the admin marks it fixed or dismisses it.
- **Another bad day** while that issue is open adds a sentence to its note instead of opening a second issue, even if an admin retyped it. A rerun of the same day adds nothing (the days an issue covers are read from its events, not its note). The note stays within what an admin can save: the oldest lines give way to "…and N earlier lines (see the activity log)".
- **Our team.** Each newly recorded drop logs an error (`Health` / `RecordChatbotHealthDrop`, with the company, chatbot, day and signals), which reaches Sentry with M6-6.
- Once the issue is closed, the next drop opens a new one.

**Couldn't-answer lag.** A conversation's outcome is counted on the day it started, and at 04:00 UTC some of yesterday's conversations may not have closed yet, while the baseline days are complete. Yesterday's share can read low, so this signal can miss a regression but won't raise a false alarm.

## When the check fails

A chatbot removed since its bad day is skipped, with no error. A company whose rollups can't be read, or a drop that can't be written, is logged (`Health` / `CheckChatbotHealth` or `RecordChatbotHealthDrop`) and the sweep goes on with the next company. A missed day isn't judged later: the next run judges its own yesterday. The check reads rollups only, so if the hourly rollup failed for yesterday (`docs/runbooks/rollups.md`), rebuild that day first; the check then sees it the next morning.

## Tuning

Change the thresholds in `ChatbotHealthCommon.ts` and their tests. Raising the floor quiets small chatbots; lowering the rise catches smaller regressions but opens more items. A change applies from the next run; open issues stay as they are.
