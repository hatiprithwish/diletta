# Cloudflare Workflows Documentation Links

Index: [workflows/llms.txt](https://developers.cloudflare.com/workflows/llms.txt)

- [Get started](https://developers.cloudflare.com/workflows/get-started/guide/)
- [Workers API (WorkflowEntrypoint, step.do, create)](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [Step context](https://developers.cloudflare.com/workflows/build/step-context/)
- [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- [Local development](https://developers.cloudflare.com/workflows/build/local-development/)
- [Limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Wrangler commands](https://developers.cloudflare.com/workflows/reference/wrangler-commands/)

## How Diletta uses it

- One workflow: `KnowledgeSyncWorkflow` (`apps/backend/src/workflows/`), exported from `src/index.ts`, bound as `KNOWLEDGE_SYNC_WORKFLOW` (`diletta-knowledge-sync-{local,staging,production}`; bindings don't inherit, so each env declares its own). One instance per knowledge source sync (M2-5), id `ks-{source public_id}-{ULID}` (≤ 100 chars, `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`).
- Imports from `cloudflare:workers`: `WorkflowEntrypoint`, and the types `WorkflowEvent`, `WorkflowStep`, `WorkflowStepConfig`. `run(event, step)`: `event.payload` is `KnowledgeSyncWorkflowParams` (ids only).
- `step.do(name, [config], callback)`: the callback's return is persisted (≤ 1 MB, structured-cloneable) and replayed on resume, so steps return ids and outcomes only, never page text or bytes. Names must be unique and deterministic (`list-{round}`, `item-{round}-{index}`, `prune`, `finish`). Code outside a step re-runs on every resume: no side effects there.
- A step retries only when its callback throws (`retries: { limit, delay, backoff }`, `timeout`); expected failures are returned as an outcome instead. `NonRetryableError` stops retries.
- Instances start only through `KnowledgeSyncWorkflowProvider.start`, after `KnowledgeSourcesRepo.startSync` claimed the source. Tests mock that provider and drive `KnowledgeSyncWorkflow.prototype.run` with an inline step runner; no real instance runs in vitest.
- Limits that matter: 10,000 steps per instance by default (one per item: `KNOWLEDGE_MAX_ITEMS_PER_SYNC` = 500 stays far under), 1 MB per step result, 30 days retention on Paid.
