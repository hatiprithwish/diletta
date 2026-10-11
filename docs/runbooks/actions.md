# Actions (action engine)

The action engine (M3-4) lets the chatbot read and change records in the customer's app through the tools pinned in the bot's config. Every write is shown to the user as a diff and, unless policy says otherwise, waits for the user's approval before anything is sent to the host.

Code: `apps/backend/src/durable-objects/ConversationDO.ts` (the flow), `repositories/ActionEngineRepo.ts` (the database side), `providers/hostToolCall.ts` (the only backend caller of `@app/adapter`), `providers/hostTools.ts` (the pure decisions and texts).

## How a tool call runs

1. **Turn start.** The config's `tools` pins (`{name, version}`) are loaded exactly. A pin is left out of the turn (and logged as `Pinned tool left out of the turn`) when the version isn't Active, its connection isn't an Active REST connection with a `base_url` and valid auth settings, its ops don't load, or its `input_schema` can't be checked. A read-only company (`companies.is_read_only`) gets its read tools only.
2. **Every call.** The model's args are checked against the tool's `input_schema` (`Schemas.validateToolArgs`, zod's `fromJSONSchema`); only declared properties are kept. The same tool with the same args twice in one turn is refused and ends the turn (loop guard).
3. **Read tool.** `call_op` is sent as the user (`jwt_forward`, the host token from the DO's memory). The answer goes to the model inside a `<host_data>` fence, cut at `HOST_TOOL_OUTPUT_MAX_CHARS`. Reading host data makes the turn untrusted.
4. **Write tool** (Think `durable-pause` action). Before it parks:
   - the approval decision (`HostToolsProvider.decideApproval`): the tool's own setting (`Always`, `Never`, or `Policy` → the config's `approvalRules` against the host user's JWT roles, first match wins, no match = required). A destructive tool, or any write in an untrusted turn (one that read help docs or host data), always needs approval. A `blocked` rule refuses the call.
   - the read-before (`readback_op` with the args; a create has none, since its readback reads `{result.*}`),
   - the diff from the read-before and the real args (`Schemas.buildChangeRequestChanges`). A write that changes nothing proposes nothing.
   - one transaction: the `tool_calls` row (args encrypted), the `change_requests` row (payload encrypted: args, read-before, diff) and its `change_request.proposed` event.
5. **Approval needed.** The turn parks. The widget gets a `change_request` frame with the diff. The proposal waits `CHANGE_REQUEST_APPROVAL_EXPIRY_MS` (15 min); the conversation doesn't auto-close while it waits. At most `CHANGE_REQUEST_MAX_PENDING` (20) proposals wait per conversation.
6. **Decision.** The widget's `change_request_decision` frame approves or rejects. An approval needs the host token: without one the DO answers `token_needed` and nothing happens. The DO prepares the continuation turn (config, tools, model, budget), decides the change request, then Think resolves the pause from its own storage (`approveExecution` / `rejectExecution`) and continues the chat.
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

- **A change request stays Committing.** The DO was evicted mid-commit, or its database write failed after the host call. The next wake of that conversation's DO resumes it with `isResume: true` (a Native tool resends with the same key, an Emulated one reads back first, a None tool goes to NeedsHuman). Nothing resumes a conversation nobody reconnects to; check the host by hand and move it to NeedsHuman.
- **NeedsHuman.** Check the record in the host (the change request's tool call holds the tool and version; the payload is encrypted). M4-5 resolves these from the dashboard.
- **"Think holds no pause for this change request"** (warn log). Think's pending-approval row was gone when the user answered. An approval is still committed; there's no continuation, so the model doesn't mention it until the next message.
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

Large commits run in the Conversation DO, not a Workflow: the host token lives in DO memory only, and the pending cap bounds a batch.

## Tests

- `src/tests/actionConversation.test.ts`: end to end through the widget socket, the DO and the test host, including the eviction test (the Done-when).
- `src/tests/actionEngine.test.ts`: `ActionEngineRepo` as `diletta_app`, including cross-company isolation.
- `src/tests/hostTools.test.ts`: approval decisions, the loop guard key, untrusted history, the fence.
- A DO under test reaches the test host through `routeTestHostFetch()` (call it after `mockCloudflare`).

## Not built yet

- Review UI, edit and bulk review in the widget (M3-5).
- Read-after, verify, auto-undo (M3-6); undo within the window and purge after it (M3-7).
- `token_needed` pushed when a read needs a token, and the widget fetching one silently (M3-8).
