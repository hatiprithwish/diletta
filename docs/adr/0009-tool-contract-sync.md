# ADR 0009: Host tool schemas sync from the company's OpenAPI spec

- Status: Accepted
- Date: 2026-11-07
- Task: M7 follow-up (automatic tool schema updates for every company)
- Changes: the M3-1 rule that tool definitions are operator-curated by hand (feature-rules › Tool definitions) and the M7-2 rule that eRegister's input schemas are generated from an eregister-backend checkout (`EregisterInputSchemas.ts`). A tool's `input_schema` now follows its company's OpenAPI spec; everything else about a tool stays operator-owned.

## Context

Every company brings its own host API, and those APIs change. A tool's `input_schema` written by hand (or generated once from a checkout) falls behind the host, and the model sends calls the host refuses (the eRegister action create that lacked `flowSchema.steps.*.dependencies`). With more companies, keeping each tool's schema in step by hand doesn't scale. Every company will provide an OpenAPI URL; eRegister serves one at `/api/openapi.json`, built from its route validators.

A spec can't produce a whole tool. Which read checks a write (`readback_op`, `compare`), how it is undone (`inverse_op`), its risk, approval and idempotency are product decisions no spec states. What a spec does state, and what drifts, is the shape of the arguments.

## Decision

1. **A tool is a binding plus a schema.** The binding (name, description, risk, approval, idempotency, every op, and which args go where) is the operator's, as today. The schema of the args the binding maps to the host (path, query and body fields named in `call_op`) comes from the spec. An arg the binding adds that the spec doesn't name (a list tool's own paging args) keeps its definition.
2. **Per connection.** `company_connections` gets `openapi_url` (https, operator-set, audited), `openapi_shaping` (below), and the last sync's `openapi_spec_hash`, `openapi_synced_at` and `openapi_failure`. `tool_definitions` gets `operation_id` (the spec operation the tool's `call_op` sends) and `contract_hash` (the hash of the schema the version was made from). A tool without `operation_id` is never touched.
3. **The fetch** goes through `@app/adapter` (`RestAdapter.getSpec`, like every host call): GET, https only, no credentials, no redirects, the host timeout, at most `TOOL_CONTRACT_MAX_BYTES`, JSON only (YAML and Swagger 2.0 are refused with a clear failure). Public specs only for now.
4. **The conversion is pure** (`Schemas.deriveToolInputSchema`): OpenAPI 3.0 / 3.1, in-document `$ref`s only, components copied into the schema's `$defs`. Shaping, per connection (`ZOpenApiShaping`), turns a host's contract into args a model can fill: `isDefaultRequired` (a field with a default is required, so a read-back compares equal to what the host stored), `looseComponents` (named components replaced by a loose object with a description, so one large shared shape doesn't fill the context; the model reads it from a tool). A body whose top level is a union of objects is flattened into one object, the discriminator an enum. The result must pass `getToolInputSchemaIssue`; a schema we can't enforce is a failure, never a half-checked tool.
5. **A change is classified** (`Schemas.classifyToolSchemaChange`): Additive (a new optional field, a relaxed bound), Breaking (a new required field, a removed field, a changed type, a tighter bound or enum), or OperationRemoved. No change = nothing happens.
6. **An hourly sync** (`ToolContractSync`, a `CronJobEnum` value on the one cron trigger, ADR 0004): every Active connection with an `openapi_url`, at most `TOOL_CONTRACT_SYNC_MAX_CONNECTIONS` per tick, least recently synced first. The fetch and conversion run outside any transaction; the writes run in one `withTenant` per company, audited as System. A changed schema becomes a new Active version of the tool (the old version stays Active, so no live chatbot changes); every chatbot whose published config pins the old version gets its pins bumped in its Draft (an existing Draft, else a new one copied from the published version), and one open System "Tool update" Quality issue per chatbot (`chatbot_id` set, no conversation) names the tools and whether a change is breaking. The admin sends the draft to testing, the gate runs, and they publish (M5-4 unchanged). Nothing is ever published by the sync.
7. **Failures don't change tools.** A spec that can't be fetched, isn't JSON OpenAPI, or yields a schema we can't enforce, and an operation that's gone, records `openapi_failure` on the connection and logs an `AppLogger.error` (an alert). The tool versions stay as they are. Operators can sync one connection on demand (`POST /operator/companies/:companyPublicId/connections/:publicId/contract-sync`, `dryRun` answers what would change and writes nothing).
8. **Binding existing tools.** `operation_id` is set by matching a tool's `call_op` method and path template to the spec's (placeholders by position); operators can set it by hand. eRegister's 47 tools are bound once this way, after which `EregisterInputSchemas.ts` and its export script are removed.

## Consequences

- A host's schema change reaches its chatbots as a draft within the hour, through the same gate as any other change. Most drift no longer needs us.
- Spec text (descriptions) becomes untrusted input: it is checked with `detectPromptInjection` before it is stored, and a flagged description is dropped.
- The binding still needs an operator for each new tool. A new operation in the spec is only listed (dry run), never turned into a tool by itself.
- A host whose spec is wrong (claims fields it refuses) is caught by the gate and by ADR 0008's field issues, not by the sync.
- eRegister's shaping (`isDefaultRequired`, its form-field components loosened) moves from the export script into its connection's settings.
