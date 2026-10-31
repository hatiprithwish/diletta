# Bots

Settings › Bots (M4-10, `/settings/bots`) lists the company's chatbots, a chatbot's versions, and the company's read-only switch. A version is one `chatbot_configs` row: the chatbot's instructions, procedures, pinned tools, approval rules, models, knowledge sources, widget text and limits. Company admins manage their own company; operators get 403 (the dashboard is company-level).

## Bots

New bot (a name), Rename, Make default and Pause / Resume, each with its audit row. A new bot has no versions and doesn't answer until one is published. The default bot is the one the widget loads when the embed names none. A paused bot stops answering from the next message. There is no delete.

## Versions

- **One draft at a time.** A chatbot has at most one open version (Draft, Testing or Ready: see [The gate](#the-gate)). Open draft opens it; with none it copies the live version into a new draft, and with no live version it starts a blank one. Starting another while one is open answers 409 `DraftExists`.
- **Only a draft changes.** Save writes the form as a config body (checked in the browser and again with `normalizeConfigBody`; an invalid body is 400 `InvalidBody`, nothing saved). Saving an unchanged body records nothing. Testing, Ready, Published and Archived versions are read-only.
- **Rollback = copy.** Copy to new draft puts an old version's body into a new draft at the next version number; send it through the gate and publish it to roll back. The old version itself never changes.
- **Discard** archives the draft (versions are never deleted: test runs and conversations point at them). The live version doesn't change.
- **Approval rules and removed tools.** A rule with no tools ticked applies to every tool. So if you remove the only tools a rule named, the rule keeps their names and the save is refused ("names tool …, which is not pinned"): tick another tool or delete the rule. It's never quietly turned into a rule for every tool.
- **Empty limits** keep the platform default (`CONFIG_SPEC_PLATFORM_DEFAULTS`, shown as the placeholder): the stored body holds only what the company set, so a later change to a default reaches every bot that didn't set it.

## The gate

A version goes live only through its tests (M5-4). It runs them on the company's staging connection (`docs/runbooks/evals.md`).

1. **Send to testing** (Draft → Testing, `POST …/configs/:publicId/send-to-testing`). The version is locked: it can't be edited, discarded or published. It is refused, with nothing changed, for the same reasons as a publish (below), so a version that couldn't go live isn't tested. Audit row "Sent a version to testing".
2. **The gate run.** We start it with the harness: `pnpm evals:run --config <configPublicId> --trigger gate [--k 3]`. A Gate run of a version that isn't Testing is refused (409 `NotTesting`), and so is one with `--k` below 3 (400 `Invalid`: every safety case must hold three times, not once). The editor rereads a version in testing every 15 s, so it changes to Ready or Draft once the run finishes. A Manual or Nightly run of any version never moves it.
3. **The finish moves it.** Passed → **Ready** (`approved_by_run_id` = that run). Failed or didn't finish → back to **Draft**, editable again. The audit log shows the move as System: "Passed its tests, ready to publish" or "Failed its tests, back to draft". A run passes when it finished, at least `EVAL_GATE_PASS_PERCENT` (95%) of its cases passed every attempt, **and every safety case passed every attempt** (one that never ran counts as failed): one failed safety case blocks publishing even above the threshold. The draft then shows "A failed safety case blocks publishing", linking to that run; it reads the version's newest Gate run only, so a later Manual or Nightly run never changes it.
4. **Back to draft** (Testing or Ready → Draft, `POST …/back-to-draft`): to edit it, or when a gate run never finished. Its approval is cleared. A gate run started before this never moves it again (the finish moves only a version sent to testing before the run started). Audit row "Moved a version back to draft".

## Publish

Publish makes a **Ready** version the live version in one transaction, and every conversation uses it from its next message (the runtime reads the Published config at every turn). It is refused, with nothing changed, when:

- the version isn't Ready (409 `NotReady`): send it to testing first;
- its approving run isn't its own finished, passed Gate run with at least 3 attempts per case (409 `NotApproved`): move it back to draft and send it to testing again;
- an active safety case (the chatbot's own or the platform's) wasn't in that run, or was edited after it started, i.e. one was added, turned on or changed since (409 `GateOutdated`): move it back to draft and send it to testing again;
- a provider the routing uses has no **Active** model key (409 `ModelKeyMissing`; an Invalid or Revoked key counts as none). Add or fix the key on Settings › Model keys;
- a tier's model isn't in `MODEL_PRICES` (409 `ModelNotPriced`): the router would refuse every call;
- a pinned tool version isn't Active (409 `ToolNotActive`): ask an operator to activate it, or pick another version.

The last three are checked at the send to testing too, and again at the publish (a key or tool can change in between). The previous live version becomes Archived. The editor shows the key, price and tool checks before you send or publish; the server checks again under its locks.

## Tool versions and published configs

An operator can't disable a tool version that a Published config pins (409 `PinnedByPublishedConfig`). Publish a version without it first (or one pinning another version), then disable it. A publish and a disable at the same moment can't cross: the publish reads its pins `FOR SHARE`.

## Read-only mode

The emergency switch (`companies.is_read_only`) blocks every change to your data for every bot: new turns get read tools only, and every step of a change already proposed or approved (commit, undo) re-checks it and is refused while it's on. Answers and read tools keep working. Turning it on or off records an audit row.
