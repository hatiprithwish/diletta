# Tool contracts: schemas that follow the host's OpenAPI spec (ADR 0009)

A tool is a **binding** (which call it makes, how a write is read back and undone, risk, approval, idempotency) plus a **schema** (the shape of the args). Operators own the binding. The schema follows the host's OpenAPI spec, so a host's API change reaches its chatbots without anyone editing a tool.

## Set a company up

1. The connection (`docs/runbooks/operators.md`) gets the spec URL: on the operator pages, Company › Connections › Edit › **OpenAPI spec** (the address and, optionally, the shaping as JSON; empty shaping is the default). Or `PATCH /operator/companies/<companyPublicId>/connections/<publicId>` with `{ "companyConnection": { "openapiUrl": "https://…/openapi.json" } }`. It must be https, public (no login) and OpenAPI 3.0 / 3.1 as JSON; YAML and Swagger 2.0 are refused. `openapiShaping` (optional) is `{ isDefaultRequired, replaceComponents }`: a field with a default required on a write (so a read-back compares equal), and named components replaced by a short schema when one shape would fill the model's context.
2. Bind the tools: **Load tool set** (eRegister) fetches the spec, matches each tool's call to a spec operation by method and path, stores the derived schema with its `operation_id`. Tools made by hand are bound when an operator sets their `operation_id`.
3. Check what would change: `POST …/connections/<publicId>/contract-sync` with `{ "isDryRun": true }` answers `changes` (tool, versions, Additive or Breaking, the field paths), `skipped` and `problems`, and writes nothing. With `false` it syncs now.

## What happens every hour

The `ToolContractSync` cron takes up to 10 connections with a spec URL, oldest first. A spec with the hash already read changes nothing. Otherwise each bound tool's schema is derived and, where it differs:

- a new Active version of the tool is made (the old one stays Active, so a live chatbot is untouched);
- each chatbot whose setup lags behind gets its pins bumped in its **Draft** (or a new Draft copied from the live one; a setup in testing or ready is left alone);
- the chatbot gets one open **Tool update** item on Quality, saying which tools changed and whether a change can break calls.

Nothing is published. The admin opens the draft in Settings › Bots, sends it to testing, the gate runs, and they publish. Rolling back is publishing the older setup, which still pins the older tool versions.

## When it doesn't work

| Symptom                                                             | Cause and fix                                                                                                                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry alert "Tool contract sync failed", `Couldn't fetch the spec` | The URL is wrong, needs a login, redirects (use the final address), is over 4 MB or is down. Tools keep their last schema. Fix the URL, or the host.                                                      |
| `Not a JSON OpenAPI 3 spec`                                         | The URL serves YAML, Swagger 2.0 or HTML.                                                                                                                                                                 |
| `A tool's operation is gone`                                        | The host removed or renamed the endpoint. The tool keeps its last version; change the tool's binding (a new version) or restore the endpoint. `problems` in a dry run names the tool.                     |
| `A schema can't be checked`                                         | The spec uses a keyword the args check can't enforce (`uniqueItems`, `contains`, an unknown `format`…) or a component that isn't in the spec. Fix the spec, or replace the component in `openapiShaping`. |
| A tool never updates                                                | Its newest version is a Draft (an operator is editing it: make it active or delete it), or it has no `operation_id`, or its newest version is on another connection (`skipped` in a dry run).             |
| The chatbot still sends the old shape                               | Its published setup still pins the old version: finish the draft the Tool update item points to. Until then the host's refusals reach the model as field issues (ADR 0008), so it can often fix one call. |
| A tool "sends fields the spec doesn't name"                         | The binding maps a body field the spec doesn't have (the host changed its body). The load or sync reports it; update the tool's binding.                                                                  |

An alert is an error log (Workers Logs → Sentry → Slack); the connection's `openapi_failure` says the last sync's reason, and the Tools section shows each tool's version history.

## Tests

- `packages/schemas/src/toolContracts/*.test.ts`: the converter, the change classifier.
- `packages/adapter/src/HostSpec.test.ts`: the spec fetch (no credentials, no redirect, size, JSON).
- `apps/backend/src/tests/toolContractSync.test.ts`: new version + draft + Tool update item, nothing the second time, dry run, an open draft bumped in place, operation gone, fetch and format failures, another company.
- `apps/backend/src/tests/toolDefinitions.test.ts` › loadToolSet: schemas from the spec, no spec URL, no operation.
