# Actions (action engine)

The action engine (M3-4) lets the chatbot read and change records in the customer's app through the tools pinned in the bot's config. Every write is shown to the user as a diff and, unless policy says otherwise, waits for the user's approval before anything is sent to the host.

Code: `apps/backend/src/durable-objects/ConversationDO.ts` (the flow), `repositories/ActionEngineRepo.ts` (the database side), `providers/hostToolCall.ts` (the only backend caller of `@app/adapter`), `providers/hostTools.ts` (the pure decisions and texts).

## How a tool call runs

1. **Turn start.** The config's `tools` pins (`{name, version}`) are loaded exactly. A pin is left out of the turn (and logged as `Pinned tool left out of the turn`) when the version isn't Active, its connection isn't an Active REST connection with a `base_url` and valid auth settings, its ops don't load, or its `input_schema` can't be checked. A read-only company (`companies.is_read_only`) gets its read tools only.
2. **Every call.** The model's args are checked against the tool's `input_schema` (`Schemas.validateToolArgs`, zod's `fromJSONSchema`); only declared properties are kept, at every depth (an object whose schema sets `additionalProperties`, `patternProperties` or `propertyNames` keeps its other keys). A schema using a keyword zod accepts but never enforces (`uniqueItems`, `contains`, `min/maxProperties`, an unknown `format`, a `pattern` needing the `u` flag) is refused on save and left out of turns. The same tool with the same args twice in one turn is refused and ends the turn (loop guard).
3. **Read tool.** `call_op` is sent as the user (`jwt_forward`, the host token from the DO's memory). The answer goes to the model inside a `<host_data>` fence, cut at `HOST_TOOL_OUTPUT_MAX_CHARS`. Reading host data makes the turn untrusted. In later turns, the transcript counts as untrusted when any tool part holds host data, a search, or an output Think trimmed (judged by content, not by tool name).
4. **Write tool** (Think `durable-pause` action). Before it parks:
   - the approval decision (`HostToolsProvider.decideApproval`): the first `approvalRules` entry matching the host user's JWT roles and the tool; if it says `blocked`, the call is refused whatever the tool's setting. Otherwise the tool's own setting (`Always`, `Never`, or `Policy` → that rule's answer, no match = required). A destructive tool, or any write in an untrusted turn (one that read help docs or host data), always needs approval. Roles count only until the JWT they came with expires (5 min at most); after that the user has none until the widget reconnects.
   - the read-before (`readback_op` with the args; a create has none, since its readback reads `{result.*}`),
   - the diff from the read-before and the real args (`Schemas.buildChangeRequestChanges`). It shows every arg the commit sends: the `compare` fields (before → after), any other arg `call_op` sends in its query or body (shown as set, always a change), and the args that only pick the record (path, shown unchanged). A write that changes nothing proposes nothing.
   - one transaction: the `tool_calls` row (args encrypted), the `change_requests` row (payload encrypted: args, read-before, diff) and its `change_request.proposed` event.
5. **Approval needed.** The turn parks. The widget gets a `change_request` frame with the diff. The proposal waits `CHANGE_REQUEST_APPROVAL_EXPIRY_MS` (15 min) from its `created_at`, the one deadline: the DO schedules its expiry then, and the database turns an approval after it into Expired. The conversation doesn't auto-close while it waits. At most `CHANGE_REQUEST_MAX_PENDING` (20) proposals wait per conversation (parallel calls of one step count from their check on).
6. **Decision.** The widget's `change_request_batch_decision` frame answers one or more proposals at once (the widget sends every answer this way; the single `change_request_decision` frame is a batch of one). At most `DECISION_FRAMES_PER_WINDOW` frames per minute per conversation. An approval needs the host token: without one the DO answers `token_needed` and decides nothing. The answers (or the expiry) claim the conversation before anything else, so a second click, the expiry or a new message waits ("A reply is still in progress"). Each change request is decided in the database first, then the DO follows the row's status, whoever set it: Approved → commit; Committing → left to that commit; an end status → the entry goes. Next, the approved ones are committed one after another. Last, the continuation is prepared once (config, tools, model, budget), and every pause Think holds is resolved from its own storage (`approveExecution` / `rejectExecution`) back to back. Each action's `execute` answers its commit's cached outcome, and Think merges the resolutions into **one** continuation (it coalesces those that land within 50 ms).
7. **Commit.** Approved → Committing (key `cr-<publicId>-commit` stored first) → the host write → Committed, Failed (nothing may have landed) or NeedsHuman (it may have). A change needing no approval commits inside its `execute`.
8. **Read-after (M3-6).** A Committed change is read back as the user before `execute` answers (`readback_op` with the args and the commit's own response, kept encrypted in the payload; a create's new id also goes in `host_ref`). `Schemas.checkReadAfter` judges it: every field the args set reads back as sent (a delete: the record answers 404) → **Verified**; it reads back otherwise → **Mismatch**, with what it found; the read failed, answered something else, or there's nothing to compare → **NeedsHuman** (`verify_unknown`). An unknown is never undone.
9. **Auto-undo (M3-6).** A Mismatch is undone at once, on its own (other change requests of the same answer stay as they are). No `inverse_op` → NeedsHuman (`not_undoable`). Otherwise the undo key `cr-<publicId>-undo` is stored first (event `change_request.undoing`), `inverse_op` is sent (args, read-before, the commit's result; an Emulated tool checks first whether it already landed), and the record is read again: back to its read-before values (a create: gone) → **Undone**; anything else → NeedsHuman (`undo_failed` when the undo didn't succeed, `undo_unconfirmed` when it did but the record doesn't read back so).

## Undo window and purge (M3-7)

Every change request that ends gets `undo_until` = its end + `CHANGE_REQUEST_UNDO_WINDOW_MS` (1 hour): Verified, Undone, Failed, Rejected and Expired. NeedsHuman keeps `undo_until` null, so its values stay until a person resolves it (M4-5 sets it then).

1. **Undo.** While a Verified change request is inside its window and its tool has an `inverse_op`, the widget's card shows **Undo** and "Undo available until HH:MM". Undo sends one `change_request_undos` frame with every record of the card the user can still undo. Same gate as an answer: the rate limit, no turn running, and the host token (`token_needed` otherwise).
2. **Re-checked like a commit** (`ActionEngineRepo.startUndo`): the conversation open, the chatbot and company active and not read-only, and then, under the row lock, Verified with no undo under way, the tool has an `inverse_op`, the values not purged, before `undo_until`, and the tool version still loading. A refusal changes nothing; the widget gets a `change_request_undo` answer with a safe message ("The time to undo this change has passed. Nothing changed.", …).
3. **Started.** The user's undo key `cr-<publicId>-user-undo` (not the auto-undo's `cr-<publicId>-undo`) is stored with a `change_request.undoing` event by the chatbot user. The change request stays Verified while the undo runs (the view says `isUndoing`); `undo_until` is left as it is, and the purge spares a Verified row holding that key until `undo_until` + `CHANGE_REQUEST_UNDO_GRACE_MS`. Because the key column is never purged, an Undone row holding it was undone by the user (the view's `undoneBy`).
4. **Run like the auto-undo** (M3-6): `inverse_op` as the user, then the record is read again. Back as before → **Undone** (a new window for its values). The undo didn't succeed and nothing may have reached the host (refused, failed, the token refused) → it stays **Verified** with a `change_request.undo_not_sent` event (not a status change): the commit key again, its window kept, and the widget hears why (`token_needed`, or "The app didn't take the undo…"). Anything that may have landed, or a record that doesn't read back as before → **NeedsHuman** (`undo_failed` / `undo_unconfirmed`). The events that end a user undo are the chatbot user's, like its start (a resume's `undoing` is the system's).
5. **The model.** No model call for an undo. The DO keeps the summaries of what the user undid in this conversation (`userUndos`, by public id, no values; added from the Undone view whichever path ended the undo, the resume included); every later turn's or continuation's system prompt says those changes no longer stand, since the transcript still says they were made.
6. **The DO.** It keeps Verified change requests the user can still undo in `undoWindows` (by Think tool call id), re-sends them on connect (so the card keeps its Undo after a reload), and doesn't auto-close until the last window ends. An undo under way is an open entry (stage `user_undoing`), resumed like an auto-undo. If the widget never brings the host token back, the auto-close's check hands it to a person once `undo_until` + `CHANGE_REQUEST_UNDO_GRACE_MS` (1 h) has passed (`abandonUndo`: NeedsHuman `undo_interrupted`), so the conversation can close.
7. **Purge.** The `ChangeRequestPurge` cron job (every minute, `ChangeRequestPurgeRepo` in `withPlatform`) nulls `encrypted_changes`, `iv` and `encryption_key_version` where `undo_until` has passed, at most `CHANGE_REQUEST_PURGE_BATCH_SIZE` × `CHANGE_REQUEST_PURGE_MAX_BATCHES` rows a run (`FOR UPDATE SKIP LOCKED`). The status, summary, counts and timeline stay. `tool_calls.encrypted_args` is not purged here (M6-1 purges it with the chat).

## Edits (M3-5)

The widget's `change_request_edits` frame sends new values for Proposed change requests. Nothing is approved by an edit. Each one is re-checked like a new proposal (pattern rule 3.34):

1. `ActionEngineRepo.getEditPlan`: still Proposed and before its deadline, the conversation, chatbot and company re-checked (and not read-only), and the tool version still loading.
2. Only editable fields (`Schemas.getEditableFields`): args `call_op` sends in its query or body that have one scalar type in the input schema. The path args that pick the record can never be edited, and a delete has no editable fields.
3. The edited args go through `Schemas.validateToolArgs` again.
4. The record is read again as the user (none for a create), and the diff is rebuilt from that read and the edited args. An edit that changes nothing is refused.
5. `ActionEngineRepo.saveEdit` re-checks the status and deadline under the row lock. It stores the new payload (encrypted), `summary`, `change_count` and `was_edited`, plus a `change_request.edited` event (actor: the chatbot user), in one transaction.

The proposal stays Proposed with its original deadline. The widget gets the new `change_request` frame and one `change_request_edit` answer per edit (`isSaved`, or a safe message saying what didn't happen). An edit's read needs the host token (`token_needed` otherwise).

No approval needed (`Never`, or an `auto` rule in a trusted turn): the change request is created Approved and committed at once.

## Statuses and events

Every status change writes `change_request.<action>` to `activity_log` + `event_outbox` in the same transaction, under the conversation's root log. Actor: the chatbot user for approve and reject, the system for everything else.

`change_request.edited` (M3-5) is the one event that isn't a status change: the user changed a Proposed one's values.

| Status     | Set when                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------- |
| Proposed   | the write was proposed and waits for the user                                               |
| Approved   | the user approved, or no approval was needed                                                |
| Rejected   | the user rejected                                                                           |
| Expired    | nobody answered within the expiry                                                           |
| Committing | the commit started (a resumed commit writes a second `committing` event)                    |
| Committed  | the host answered 2xx, or an Emulated readback proved the write landed; read-after to come  |
| Verified   | the read-after shows the change (a delete: the record is gone)                              |
| Mismatch   | the read-after shows something else; its auto-undo is starting or running                   |
| Undone     | an undo (auto, or the user's within the window) put the record back, confirmed by a read    |
| Failed     | the host refused or failed, and no send may have landed                                     |
| NeedsHuman | a person must look: the commit or its undo may have landed, or the read-after couldn't tell |

`change_request.undoing` (M3-6) isn't a status change either: the auto-undo of a Mismatch started (a resumed undo writes another). Since M3-7 it also marks the user's undo of a Verified one (actor: the chatbot user), which stays Verified until the undo ends.

## When something is stuck

- **A change request stays Committing (or Approved).** The DO was evicted mid-commit, or a database write before or after the host call failed. The commit runs as the user, so it resumes only once the DO holds the host token again: on the widget's next `host_token` frame (every reconnect sends one), on the `ACTION_COMMIT_RETRY_MS` retry after a failed write, and on the auto-close's check. It resumes with `isResume: true` (a Native tool resends with the same key, an Emulated one reads back first, a None tool goes to NeedsHuman). A resume that can't send for want of the token stays Committing; the retry and the auto-close's check ask any open widget for one (M3-8). One whose first send reached nothing (no token, or a refused one) resumes as a fresh send (`isUnsent`), so a None tool isn't handed to a person for it. With no widget back `HOST_TOKEN_GRACE_MS` after it first needed the token, it goes to NeedsHuman `token_needed`; a conversation idle long enough for its auto-close check is what wakes it.
- **A change request stays Committed or Mismatch.** Its read-after or undo was cut short (an eviction, a failed database write, no host token before the send). It resumes like a commit: on the next `host_token` frame, the `ACTION_COMMIT_RETRY_MS` retry, and the auto-close's check. A Mismatch whose `idempotency_key` is `cr-<publicId>-undo` may have sent its undo already, so it resumes with `isResume` (a None tool then ends NeedsHuman unsent).
- **Many Undone or `verify_unknown` for one tool.** The host stores a value in another form than it was sent (lowercased email, rounded number, "20.00" for 20): the read-after can't see the change, so it is undone. Fix the tool's `input_schema` (send the stored form) or its `compare` map; nothing in the engine loosens the comparison.
- **A user undo stays under way (Verified holding `cr-<publicId>-user-undo`).** An eviction or a failed write cut it short. It resumes like an auto-undo (next `host_token`, the retry, the auto-close's check) with `isResume`. Without a host token by `undo_until` + `CHANGE_REQUEST_UNDO_GRACE_MS`, the DO hands it to a person (NeedsHuman `undo_interrupted`: check the record in the host); the purge stops sparing it then too.
- **"The time to undo this change has passed".** `undo_until` is in the past. Nothing was sent. The change stands as verified.
- **Values still there after the window.** Check the cron runs (`ChangeRequestPurge` in the logs, `purgedCount`). A row with `undo_until` null (NeedsHuman, or written before M3-7) is never purged here.
- **NeedsHuman.** Check the record in the host (the change request's tool call holds the tool and version; the payload is encrypted). M4-5 resolves these from the dashboard.
- **"Think holds no pause for this change request"** (warn log). Think's pending-approval row was gone when the user answered (swept, or resolved elsewhere), or Think couldn't resolve it. An approval is still committed; there's no continuation, so the model doesn't mention it until the next message.
- **`error_code`.** `Schemas.ChangeRequestErrorCodeEnum`: why a change request ended Failed / NeedsHuman (a refused step: `tool_unavailable`, `read_only`, `conversation_closed`, `chatbot_unavailable`, `payload_unreadable`, `server_error`; the host call: `token_needed`, `token_rejected`, `host_refused`, `host_failed`, `host_unknown`; after a commit landed (M3-6): `verify_unknown`, `not_undoable`, `undo_failed`, `undo_unconfirmed`; the user's undo never resumed (M3-7): `undo_interrupted`).
- **"Continuation not prepared"** (warn log). The answer was applied, but the model couldn't run (no key, budget used up). The chat shows the generic unavailable text after it.
- **Host token.** The DO holds it in memory only. After an eviction the widget must send it again (`host_token` frame). Since M3-5 the widget sends it on every connect (`getHostToken` init option). On `token_needed` for an answer or an edit (`reason: answer`), it fetches a fresh one and sends that frame again once. A host without `getHostToken` can't approve changes. Since M3-8 the DO asks for one itself (`reason: refresh`) whenever a host call finds none or the host refuses it with nothing landed, waits up to `HOST_TOKEN_WAIT_MS`, and tries once more; the widget answers silently. A read that still has none tells the model to ask the user to sign in again (`tool_calls.error_code` `token_needed` / `token_rejected`).
- **NeedsHuman `token_needed`.** A commit, read-after or undo waited `HOST_TOKEN_GRACE_MS` for a host token that never came: the widget was closed (no socket) or its host's `getHostToken` failed. Nothing was sent after the token went missing, but a Committing one may have landed before: check the record in the host. Many of these for one company: check the host's `getHostToken` (see `docs/runbooks/widget.md`).
- **The model replied twice after a bulk answer.** Think fired a continuation before the last pause was resolved (the resolutions came more than 50 ms apart). Each continuation is prepared like a turn, so a second one with no prepared turn ends with the generic safe text. Look for slow `approveExecution` storage writes.
- **An edit says "This change can't be edited right now".** The tool version is no longer Active, or its connection can't serve calls (`getEditPlan` → `ToolUnavailable`). The proposal can still be rejected; an approval would end it Failed.

## Defaults

| Constant                            | Value  | Where                      |
| ----------------------------------- | ------ | -------------------------- |
| `CHANGE_REQUEST_APPROVAL_EXPIRY_MS` | 15 min | `packages/schemas`         |
| `CHANGE_REQUEST_MAX_PENDING`        | 20     | `packages/schemas`         |
| `HOST_TOOL_OUTPUT_MAX_CHARS`        | 8,000  | `packages/schemas`         |
| `ACTION_COMMIT_TIMEOUT_MS`          | 120 s  | `apps/backend` `Constants` |
| `ACTION_PENDING_APPROVAL_TTL_MS`    | 24 h   | `apps/backend` `Constants` |
| `ACTION_COMMIT_RETRY_MS`            | 60 s   | `apps/backend` `Constants` |
| `DECISION_FRAMES_PER_WINDOW`        | 30/min | `apps/backend` `Constants` |
| `CHANGE_REQUEST_UNDO_WINDOW_MS`     | 1 h    | `packages/schemas`         |
| `CHANGE_REQUEST_UNDO_GRACE_MS`      | 1 h    | `packages/schemas`         |
| `CHANGE_REQUEST_PURGE_BATCH_SIZE`   | 500    | `apps/backend` `Constants` |
| `CHANGE_REQUEST_PURGE_MAX_BATCHES`  | 10     | `apps/backend` `Constants` |
| `HOST_TOKEN_WAIT_MS`                | 15 s   | `apps/backend` `Constants` |
| `HOST_TOKEN_GRACE_MS`               | 5 min  | `apps/backend` `Constants` |

Large commits run in the Conversation DO, not a Workflow: the host token lives in DO memory only, and the pending cap bounds a batch.

## Tests

- `src/tests/actionConversation.test.ts`: end to end through the widget socket, the DO and the test host, including the eviction test (the Done-when), a double-clicked approval, an approval after the deadline, a decision the database already took, and a commit cut short by an eviction resumed on the host token.
- `src/tests/actionConversation.test.ts` › "edit and bulk review" (M3-5, the Done-when): an edited value is re-checked (a host change in between shows in the new diff) and is what commits; locked fields, bad values and no-change edits are refused; an edit after the deadline is refused; an edit or an approval without the host token asks for it; a batch commits the approved, rejects the rest, and the model replies once.
- `src/tests/actionConversation.test.ts` › "read-after, auto-undo and needs a person" (M3-6, the Done-when): a create and a delete verified; a commit overwritten on the host (`overwrite` fault) undone, with what was found on the frame; an undo that fails and a tool with no `inverse_op` handed to a person; a read-after the host won't answer handed to a person, nothing undone.
- `src/tests/actionConversation.test.ts` › "undo window and purge" (M3-7, the Done-when): the card's Undo puts the record back and later turns hear it; Undo comes back after a reconnect, asks for the host token, and is refused after the window; no auto-close while a change can be undone; `encrypted_changes` is null once the window ends.
- `src/tests/actionConversation.test.ts` › "token refresh (M3-8)" (the Done-when): a read with no host token asks the widget and goes on with no UI; a commit whose token the host refuses (401) asks for a fresh one and commits once; an approved commit whose widget closed is handed to a person once the grace has passed, the host untouched.
- `src/tests/actionEngine.test.ts`: `ActionEngineRepo` as `diletta_app`, including cross-company isolation (and `getEditPlan` / `saveEdit`, M3-6's `finishVerify` / `startFollowUp` / `finishUndo`, an undo resumed from the stored key, M3-7's `startUndo` and the purge, M3-8's `isUnsent` resumes and `handOverForToken`).
- `src/tests/hostTools.test.ts`: approval decisions, role expiry, the loop guard key, untrusted history, the fence.
- `src/tests/changeRequests.test.ts`: the deadline, how a commit's host call, its read-after and its undo end, error codes, the view.
- `packages/schemas` `ChangeRequestsVerify.test.ts`: `checkReadAfter` per kind and step, `host_ref`, the payload upgrade.
- A DO under test reaches the test host through `routeTestHostFetch()` (call it after `mockCloudflare`).
