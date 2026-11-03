# Incidents

What on-call does when one of four things goes wrong: a key fails, a change needs a person, events stop relaying, or a chatbot version has to be rolled back (M6-7). Each playbook goes **notice → limit the harm → fix → check → close**. The feature runbooks it links to hold the detail; this page holds the order.

## Before you start

- **Which environment and company.** The Sentry issue carries `environment` and, for a company's alert, `metadata.companyId` (the internal `companies.id`). `SELECT public_id, name, status, is_read_only FROM companies WHERE id = <id>;` names it.
- **SQL by hand** runs as the owner role (`DATABASE_URL`) on the right Neon branch (`staging` or `production`), never through the worker. Read first; write only where a playbook says so, and note every write in the incident's thread.
- **Who can do what.** The dashboard is company-level: operators get 403 on every company page, so pausing a chatbot, the read-only switch, model keys, Mark resolved and publishing are the **company admin's** buttons. Ask their admin first. An operator's SQL write records no audit row, so it is the fallback for when nobody at the company answers and the harm can't wait.
- **Logs.** Workers Logs (`diletta-worker` › Logs) filters by `category` and `action`; Sentry shows them as tags (`docs/runbooks/observability.md`).

## 1. Key failure

Every model call uses the company's own provider key through AI Gateway, and every stored secret, credential, tool call argument and change value is encrypted under the company key, which the platform master key wraps. When one of these fails, users see "Temporarily unavailable" or a change ends needing a person.

### Notice: which key

| What you see                                                                                                                               | Which key                                                            | Who is hit                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------- |
| A System / Model error issue on the company's Quality page; `ModelRouter` / `GetModel` **warnings** "No active model key for the provider" | The company's model key: the provider rejected it, or none is Active | One company, one provider          |
| `model_calls.error_code = 'http_401'` for many companies at once; no key turns Invalid                                                     | The platform's AI Gateway token                                      | Every company in that environment  |
| `Crypto` / `ReadMasterKey` "Master key version N is not configured" (or "is not base64 of 32 bytes")                                       | The master key binding                                               | Every company wrapped by version N |
| `Crypto` / `UnwrapCompanyKey` "Company key could not be decrypted"                                                                         | A company key whose wrap doesn't open with the master key            | One company                        |
| `Crypto` / `UnwrapCompanyKey` "Encryption key destroyed"                                                                                   | A value still on a destroyed company key version                     | One company, those rows            |
| `Crypto` / `DecryptValue` "Value could not be decrypted" (metadata: `companyId`, `column`, `encryptionKeyVersion`)                         | One stored value                                                     | One row                            |
| `Crypto` / `SweepKeyRotation` "Encryption key rotation is overdue"                                                                         | A rotation stuck on a value that won't decrypt                       | One company's next rotation        |

A rejected model key is a warning, not an alert: the System issue tells the company, and the fix is theirs. On-call hears about it from the company or from the Quality page; nothing posts to Slack for it.

### Model key rejected, or none Active

1. **Check** which provider and since when (as the owner role):

   ```sql
   SELECT provider, status, last_four_chars, last_validated_at, rotated_at, updated_at
   FROM company_secrets
   WHERE company_id = <id> AND type = 1 -- Model key
   ORDER BY provider, status;

   SELECT provider, model, error_code, count(*), max(created_at)
   FROM model_calls
   WHERE company_id = <id> AND created_at > now() - interval '1 hour' AND error_code IS NOT NULL
   GROUP BY 1, 2, 3 ORDER BY 4 DESC;
   ```

   Status 2 (Invalid) = the provider rejected it (Anthropic 401 `authentication_error`, OpenAI 401 not a missing-scope one, Google 400 `API_KEY_INVALID` / 401 `UNAUTHENTICATED`). No Active row = none to use. A 403 (`permission_error`, `PERMISSION_DENIED`) leaves the key Active: the key works, the model or API isn't enabled for it.

2. **Fix.** The company admin rotates the key on Settings › Model keys (an Invalid key comes back Active), or adds one. The page checks it with the provider before saving (`docs/runbooks/model-keys.md`). For a 403, the admin enables the model at the provider or changes the routing in a new version (section 4).
3. **Check.** The next model call succeeds: new `model_calls` rows for that provider have `error_code` null. No restart or cache to clear: the router reads the Active key at every call.
4. **Close.** The admin marks the System issue fixed on the Quality page. Rotating doesn't close it, and while it stays Open later failures of other providers add to it rather than opening a new one.

### Gateway token wrong (every company 401)

The router records `http_401` and leaves every company key alone. Follow `docs/runbooks/ai-gateway.md` › Create a gateway and its token: make a new token with **AI Gateway → Run** and **Read**, replace the `diletta-aig-token-<env>` secret, and deploy. Check that new `model_calls` rows have no `error_code`. Then mark fixed any Model error issues the outage opened (none should: only a provider's own rejection opens one).

### Master key missing or wrong

- **"Master key version N is not configured"**: the deploy lost the `MASTER_KEY_V<N>` Secrets Store binding, or `MasterKeyProvider.getSource` has no `case N`. Nothing can be decrypted or written encrypted for every company on that version. Restore the binding in `wrangler.jsonc` and redeploy; never create a new secret under the old name (Secrets Store doesn't return values, and a new value can't open the old wraps). The only copy outside Cloudflare is the password manager entry (`docs/runbooks/master-key.md`).
- **"Company key could not be decrypted" for many companies**: the bound secret holds another value than the one that wrapped the keys (often a local `.dev.vars` key that wrapped rows on the staging branch). Compare `master_key_version` on the failing rows; re-bind the value from the password manager. Rows wrapped by a key nobody has are lost: their company must re-enter secrets.
- During either, users see "Temporarily unavailable" and changes end Failed or NeedsHuman `payload_unreadable`; nothing is written in plaintext instead.

### One company key or one value

- **"Company key could not be decrypted" for one company only**: its `company_encryption_keys` row was changed outside the code. Do not rotate (a rotation reads every value with the old key). Restore the row from a Neon branch restore point if one exists; otherwise the values under that version are lost and the company re-enters its secrets and model keys.
- **"Encryption key destroyed"**: a value was left on a version the rotation job destroyed. That should be impossible (the job counts every column under the key rows' lock first); treat it as a bug, record the table and row id, and the value is gone (crypto-shred).
- **One `DecryptValue` error**: one row is corrupt. A change request whose payload won't decrypt ends Failed or NeedsHuman `payload_unreadable` (section 2); a model key that won't decrypt makes that provider's calls fail with `ServerError` until the admin rotates it. Find the row by `companyId`, `column` and `encryptionKeyVersion`. Never re-encrypt by hand: live writes would race it.
- **Rotation overdue**: `docs/runbooks/security.md` › Encryption keys › Stuck Retiring.

## 2. A change needs a person (`NeedsHuman`)

A change request ends NeedsHuman when a write to the customer's app **may** have landed but we can't prove how, so nothing more is tried on its own. The record in the host app is the truth. The dashboard's Changes page (`/changes`, the "Needs a person" tab and the sidebar badge) lists them for the company's admins.

### Notice

Mostly from the company: the badge, Overview's needs attention, or a user saying a change didn't go through. There is no alert per NeedsHuman. To see them across companies:

```sql
SELECT c.public_id AS company, c.name, cr.public_id, cr.error_code, td.name AS tool, td.version,
       cr.summary, cr.updated_at
FROM change_requests cr
JOIN companies c ON c.id = cr.company_id
JOIN tool_calls tc ON tc.id = cr.tool_call_id
JOIN tool_definitions td ON td.id = tc.tool_id
WHERE cr.status = 11 -- NeedsHuman
ORDER BY cr.updated_at DESC;
```

### What `error_code` says about the host record

| `error_code`                                    | Did anything reach the host?                                                 | What to check in the host                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `host_unknown`                                  | Maybe: the commit's answer never came back                                   | Whether the change is there, once (a None tool can't be resent safely)           |
| `host_failed`, `host_refused`, `token_rejected` | Maybe: the send may have landed, or it was a resume after an earlier attempt | Whether the change is there, once                                                |
| `verify_unknown`                                | Yes, the host said 2xx                                                       | Whether the record shows what was asked; the read-after couldn't tell            |
| `not_undoable`                                  | Yes, and it read back otherwise (Mismatch)                                   | What the record holds now; the tool has no `inverse_op`, so put it right by hand |
| `undo_failed`, `undo_unconfirmed`               | Yes, then an undo that may or may not have landed                            | Whether the record is back to its value before the change                        |
| `undo_interrupted`                              | Yes; the user's undo started and never finished                              | Same as above                                                                    |
| `token_needed`                                  | Not after the token went missing; a Committing one may have landed before    | Whether the change is there                                                      |
| `payload_unreadable`                            | Not from the step that failed                                                | Whether an earlier step landed; then section 1 › One company key or one value    |

The full list and every step's rules: `docs/runbooks/actions.md` › When something is stuck.

### Fix and close, one change

1. The company admin opens it on the Changes page: the timeline shows each step in words, never the values (they stay encrypted).
2. They check the record in their app and put it right by hand if needed.
3. **Mark resolved**: NeedsHuman → Resolved, an admin event, and the next purge run (every 15 minutes) clears its values. Only the company's admin can do this (operators get 403); a second resolve answers 409 and writes nothing.

### Many at once: find the cause

| Pattern                                             | Likely cause                                                                  | Fix                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Many `token_needed` for one company                 | The host's `getHostToken` fails, or users close the widget mid-change         | Check the host's `getHostToken` (`docs/runbooks/widget.md`)                                       |
| Many `verify_unknown` / `not_undoable` for one tool | The host stores another form than was sent (lowercased email, "20.00" for 20) | Fix the tool's `input_schema` or `compare` in a new tool version (`docs/runbooks/actions.md`)     |
| Many `host_unknown` across tools of one connection  | The host app is slow or down                                                  | Tell the company; their admin can turn on the read-only switch (section 4) until the host is back |
| Many `payload_unreadable`                           | A key problem                                                                 | Section 1                                                                                         |

While the cause is open, the company admin can stop new writes with the read-only switch: answers and read tools keep working.

## 3. Relay failures

Critical events are written to `activity_log` and `event_outbox` in the write's own transaction, then relayed to the events Queue: right after the commit, and by the 15-minute sweep for anything that missed (`docs/runbooks/observability.md`). The write itself and its `activity_log` row (so the audit log and timelines) are already committed; a relay failure only delays what the queue consumer does. Today that is the doc gap candidate (`doc_gap.candidate` → `DocGapsRepo.processCandidate`); every other event is logged and acked.

### Notice

| Alert (`Relay`)                                                                                                            | Means                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| "Outbox events waiting too long to publish" (`CheckEventOutboxHealth`)                                                     | A Pending row older than 5 min after the sweep                       |
| "Outbox events failed and need a manual retry" (`CheckEventOutboxHealth`)                                                  | Rows in Failed: the Queue rejected them 5 times. Never retried alone |
| "Queue unavailable, events left pending", "Events rejected by the Queue", "Events failed after 5 attempts" (`RelayEvents`) | One relay's send failed                                              |

### Look

```sql
SELECT status, count(*), min(created_at), max(attempts)
FROM event_outbox GROUP BY status;                 -- 1 Pending, 2 Published, 3 Failed

SELECT id, company_id, event_type, attempts, last_error, created_at
FROM event_outbox WHERE status = 3 ORDER BY created_at LIMIT 50;
```

### Fix

- **Lag, no Failed rows.** Look for "Queue unavailable, events left pending" around the alert. A Queue outage clears itself; the sweep keeps retrying without counting attempts. A `DAL` error means Neon or Hyperdrive. A backlog bigger than `OUTBOX_SWEEP_MAX_BATCHES × OUTBOX_BATCH_SIZE` (1,000) per tick drains over a few ticks: watch `pendingCount` fall.
- **Failed rows.** Read `last_error` (cut at 500 characters). Fix the cause (for example a Queue binding missing after a deploy), then send them again:

  ```sql
  UPDATE event_outbox SET status = 1, attempts = 0, last_error = NULL
  WHERE status = 3 AND id IN (<ids>);
  ```

  The next sweep sends them. A resend is safe: delivery is at-least-once and the consumer dedupes on `outboxId`.

- **Consumer side.** A doc gap candidate the consumer couldn't process retries up to the queue's `max_retries` (3), then goes to `diletta-events-<env>-dlq`, which nothing reads. Look for `Queue` / `ProcessDocGapCandidate` errors. After the fix, set the row back to Pending as above (Published rows are kept `OUTBOX_PUBLISHED_RETENTION_DAYS`, 3 days; after that the candidate is lost, which costs one question in a gap group and nothing else).

### Check and close

The next tick logs no `CheckEventOutboxHealth` error, the first query shows no Failed rows and no Pending row older than 5 minutes. With the alert gone, Sentry auto-resolves the issue after 7 days.

## 4. Config rollback

A published chatbot version is misbehaving: wrong answers, a bad instruction, a tool it shouldn't call. There is no instant rollback: a version goes live only through its gate (M5-4), so a rollback is a new version with the old body. Limit the harm first, then roll back.

### Limit the harm (minutes)

| Problem                                        | Switch                             | Effect                                                                                           |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Wrong or harmful changes in the customer's app | Read-only switch (Settings › Bots) | Every bot of the company: read tools only, any change under way is refused. Answers keep working |
| Wrong or harmful answers from one bot          | Pause the bot (Settings › Bots)    | That bot stops answering from the next message                                                   |

Both are the company admin's, each with an audit row, and both apply at the next message: the runtime reads them every turn. If nobody at the company answers and the harm can't wait, an operator can set them as the owner role, with **no audit row** (say so in the incident thread and tell the company):

```sql
UPDATE companies SET is_read_only = true, updated_at = now() WHERE id = <id>;
UPDATE chatbots  SET status = 2, updated_at = now() WHERE id = <chatbot id> AND company_id = <id>; -- Paused
```

### Roll back (the gate's time)

1. **Pick the version.** Settings › Bots › the chatbot's versions: the newest Archived one before the bad version, usually.

   ```sql
   SELECT public_id, config_version, status, published_at
   FROM chatbot_configs WHERE chatbot_id = <chatbot id> ORDER BY config_version DESC LIMIT 10;
   -- status: 1 Draft, 2 Testing, 3 Ready, 4 Published, 5 Archived
   ```

2. **Clear the way.** A chatbot holds one open version at a time. A Draft: Discard it. Testing or Ready: Back to draft, then Discard.
3. **Copy to new draft** on the old version: its body becomes a new draft at the next version number. The old version never changes.
4. **Send to testing.** Refused for the same reasons as a publish (`ModelKeyMissing`, `ModelNotPriced`, `ToolNotActive`): the old body may pin a tool version since disabled or a model since unpriced. Fix that in the draft and save before sending.
5. **Gate run**: `pnpm evals:run --config <new configPublicId> --trigger gate` (k ≥ 3), on the company's staging connection (`docs/runbooks/evals.md`). Safety cases added since the old version was live run too; if one fails, the old body isn't safe as it is: fix forward in the draft instead.
6. **Publish** the Ready version. The bad version becomes Archived; every conversation uses the new one from its next message (`docs/runbooks/bots.md`).
7. **Undo the switches**: Resume the bot, turn the read-only switch off.

### Check and close

New turns run on the new version: `SELECT chatbot_config_id, count(*) FROM conversations WHERE chatbot_id = <chatbot id> AND updated_at > now() - interval '15 minutes' GROUP BY 1;`. Look at the changes the bad version made (section 2 for any NeedsHuman) and at its quality issues. Turn what went wrong into a test case (Quality › Create test, or Tests › New) so the gate catches it next time.
