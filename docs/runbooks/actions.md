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
6. **Decision.** The widget's `change_request_decision` frame approves or rejects (at most `DECISION_FRAMES_PER_WINDOW` per minute per conversation). An approval needs the host token: without one the DO answers `token_needed` and nothing happens. The answer (or the expiry) claims the conversation before anything else, so a second click, the expiry or a new message waits ("A reply is still in progress"). The change request is decided in the database first, then the DO follows the row's status, whoever set it: Approved → commit; Committing → left to that commit; an end status → the entry goes and a pause Think still holds is rejected with the reason. Only then is the continuation prepared (config, tools, model, budget) and Think resolves the pause from its own storage (`approveExecution` / `rejectExecution`) and continues the chat.
7. **Commit.** Approved → Committing (key `cr-<publicId>-commit` stored first) → the host write → Committed, Failed (nothing may have landed) or NeedsHuman (it may have).

No approval needed (`Never`, or an `auto` rule in a trusted turn): the change request is created Approved and committed at once.

## Statuses and events

Every status change writes `change_request.<action>` to `activity_log` + `event_outbox` in the same transaction, under the conversation's root log. Actor: the chatbot user for approve and reject, the system for everything else.

| Status     | Set when                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------- |
| Proposed   | the write was proposed and waits for the user                                               |
| Approved   | the user approved, or no approval was needed                                                |
| Rejected   | the user rejected                                                                           |
| Expired    | nobody answered within the expiry                                                           |
| Committing | the commit started (a resumed commit writes a second `committing` event)                    |
| Committed  | the host answered 2xx, or an Emulated readback proved the write landed                      |
| Failed     | the host refused or failed, and no send may have landed                                     |
| NeedsHuman | the outcome is unknown: a send may have landed (timeout, 5xx, a token refused after a send) |

M3-6 adds the read-after (Committed → Verified / Mismatch → auto-undo).

## When something is stuck

- **A change request stays Committing (or Approved).** The DO was evicted mid-commit, or a database write before or after the host call failed. The commit runs as the user, so it resumes only once the DO holds the host token again: on the widget's next `host_token` frame (every reconnect sends one), on the `ACTION_COMMIT_RETRY_MS` retry after a failed write, and on the auto-close's check. It resumes with `isResume: true` (a Native tool resends with the same key, an Emulated one reads back first, a None tool goes to NeedsHuman). A resume that can't send for want of the token stays Committing. Nothing resumes a conversation nobody reconnects to; check the host by hand and move it to NeedsHuman.
- **NeedsHuman.** Check the record in the host (the change request's tool call holds the tool and version; the payload is encrypted). M4-5 resolves these from the dashboard.
- **"Think holds no pause for this change request"** (warn log). Think's pending-approval row was gone when the user answered (swept, or resolved elsewhere), or Think couldn't resolve it. An approval is still committed; there's no continuation, so the model doesn't mention it until the next message.
- **`error_code`.** `Schemas.ChangeRequestErrorCodeEnum`: why a change request ended Failed / NeedsHuman (a refused step: `tool_unavailable`, `read_only`, `conversation_closed`, `chatbot_unavailable`, `payload_unreadable`, `server_error`; the host call: `token_needed`, `token_rejected`, `host_refused`, `host_failed`, `host_unknown`).
- **"Continuation not prepared"** (warn log). The answer was applied, but the model couldn't run (no key, budget used up). The chat shows the generic unavailable text after it.
- **Host token.** The DO holds it in memory only. After an eviction the widget must send it again (`host_token` frame). Until M3-8, the widget doesn't fetch one on its own, so reads and approvals answer "sign in again".

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

Large commits run in the Conversation DO, not a Workflow: the host token lives in DO memory only, and the pending cap bounds a batch.

## Tests

- `src/tests/actionConversation.test.ts`: end to end through the widget socket, the DO and the test host, including the eviction test (the Done-when), a double-clicked approval, an approval after the deadline, a decision the database already took, and a commit cut short by an eviction resumed on the host token.
- `src/tests/actionEngine.test.ts`: `ActionEngineRepo` as `diletta_app`, including cross-company isolation.
- `src/tests/hostTools.test.ts`: approval decisions, role expiry, the loop guard key, untrusted history, the fence.
- `src/tests/changeRequests.test.ts`: the deadline, how a commit's host call ends, error codes, the view.
- A DO under test reaches the test host through `routeTestHostFetch()` (call it after `mockCloudflare`).

## Not built yet

- Review UI, edit and bulk review in the widget (M3-5).
- Read-after, verify, auto-undo (M3-6); undo within the window and purge after it (M3-7).
- `token_needed` pushed when a read needs a token, and the widget fetching one silently (M3-8).
