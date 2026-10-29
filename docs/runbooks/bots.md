# Bots

Settings › Bots (M4-10, `/settings/bots`) lists the company's chatbots, a chatbot's versions, and the company's read-only switch. A version is one `chatbot_configs` row: the chatbot's instructions, procedures, pinned tools, approval rules, models, knowledge sources, widget text and limits. Company admins manage their own company; operators get 403 (the dashboard is company-level).

## Bots

New bot (a name), Rename, Make default and Pause / Resume, each with its audit row. A new bot has no versions and doesn't answer until one is published. The default bot is the one the widget loads when the embed names none. A paused bot stops answering from the next message. There is no delete.

## Versions

- **One draft at a time.** A chatbot has at most one open version (Draft; Testing and Ready belong to the eval gate, M5-4). Open draft opens it; with none it copies the live version into a new draft, and with no live version it starts a blank one. Starting another while one is open answers 409 `DraftExists`.
- **Only a draft changes.** Save writes the form as a config body (checked in the browser and again with `normalizeConfigBody`; an invalid body is 400 `InvalidBody`, nothing saved). Saving an unchanged body records nothing. Published and Archived versions are read-only.
- **Rollback = copy.** Copy to new draft puts an old version's body into a new draft at the next version number; publish it to roll back. The old version itself never changes.
- **Discard** archives the draft (versions are never deleted: test runs and conversations point at them). The live version doesn't change.
- **Approval rules and removed tools.** A rule with no tools ticked applies to every tool. So if you remove the only tools a rule named, the rule keeps their names and the save is refused ("names tool …, which is not pinned"): tick another tool or delete the rule. It's never quietly turned into a rule for every tool.
- **Empty limits** keep the platform default (`CONFIG_SPEC_PLATFORM_DEFAULTS`, shown as the placeholder): the stored body holds only what the company set, so a later change to a default reaches every bot that didn't set it.

## Publish

Publish makes a draft the live version in one transaction, and every conversation uses it from its next message (the runtime reads the Published config at every turn). It is refused, with nothing changed, when:

- a provider the routing uses has no **Active** model key (409 `ModelKeyMissing`; an Invalid or Revoked key counts as none). Add or fix the key on Settings › Model keys;
- a tier's model isn't in `MODEL_PRICES` (409 `ModelNotPriced`): the router would refuse every call;
- a pinned tool version isn't Active (409 `ToolNotActive`): ask an operator to activate it, or pick another version.

The previous live version becomes Archived. The editor shows the same checks before you click Publish; the publish checks again under its locks.

The eval gate (Ready + a passing run, safety cases blocking) comes with M5-4. Until then a draft publishes straight from Draft.

## Tool versions and published configs

An operator can't disable a tool version that a Published config pins (409 `PinnedByPublishedConfig`). Publish a version without it first (or one pinning another version), then disable it. A publish and a disable at the same moment can't cross: the publish reads its pins `FOR SHARE`.

## Read-only mode

The emergency switch (`companies.is_read_only`) blocks every change to your data for every bot: new turns get read tools only, and every step of a change already proposed or approved (commit, undo) re-checks it and is refused while it's on. Answers and read tools keep working. Turning it on or off records an audit row.
