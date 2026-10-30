# Tests page

The dashboard's Tests page (M4-8) shows the eval runs of a company's chatbot configs, what each case's attempts found, and the transcript of any attempt. Cases are written and edited there too. The eval harness starts runs and writes their results through `/eval/*` (M5-2, `docs/runbooks/evals.md`); M5-3 adds the judge and the transcripts. The dashboard has no Run button yet.

## What the page reads

| View              | Route                                                              | Notes                                                                                                        |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Metric strip      | `GET /dashboard/eval-runs/summary`                                 | The `botId` chatbot, else the company's default                                                              |
| Runs              | `GET /dashboard/eval-runs`                                         | Paged, newest first, optional `botId`                                                                        |
| One run           | `GET /dashboard/eval-runs/:publicId`                               |                                                                                                              |
| A run's cases     | `GET /dashboard/eval-runs/:publicId/cases`                         | Paged, failed first (then safety, then name), or `sortColumn=name`                                           |
| A case's attempts | `GET /dashboard/eval-runs/:publicId/cases/:casePublicId`           | Grader output through `parseEvalGraderOutput`                                                                |
| A transcript      | `GET /dashboard/eval-runs/:publicId/transcripts/:filePublicId`     | Read from R2, parsed, never served raw. 404 if the file isn't this run's; 422 `Unreadable` if it won't parse |
| Cases             | `GET /dashboard/eval-cases`, `GET /dashboard/eval-cases/:publicId` | The company's cases and every platform case                                                                  |

Every route sits behind `authorizeCompany`: `EvalRunRead` for runs, `EvalCaseRead` / `EvalCaseCreate` / `EvalCaseUpdate` for cases.

## How results are counted

- A case's **result in a run** comes from `Schemas.evalCaseRunResult`:
  - **Passed** once every one of the run's `k` attempts passed.
  - **Failed** as soon as an attempt fails, or when the run ended (Done or Failed) without `k` passing attempts.
  - **Running** while the run is Queued or Running and nothing has failed yet. Such a case is never shown as failed, sorts between the failed and passed ones, and is left out of the safety tally until it is decided.
- A run's **safety tally** counts its safety cases and how many passed every attempt. A failed safety case blocks publishing (the gate, M5-4).
- The **Live** card shows the published config's gate run (`chatbot_configs.approved_by_run_id`), else its newest run. The **Draft** card shows the newest Draft / Testing / Ready config's newest run.
- **Runs on** shows the host of the oldest active staging connection. "Not set up" means the company has none.
- A run's **status** Failed means it didn't finish (the page says "Didn't finish"). When the harness said why it stopped (`eval_runs.failure`, M5-3), the reason shows under the chip and in the strip: "The judge couldn't be reached", "The staging host couldn't be reached" or "A server error stopped the run". Passed or failed comes from `has_passed` on a Done run.

## What the eval API writes (M5-2, M5-3)

The page reads these shapes. The harness sends the grader output; the backend builds and stores the transcript itself when the harness records an attempt that ran (`docs/runbooks/evals.md`). Their JSON Schema lives in `evals/schemas/` (`eval-grader-output.schema.json`, `eval-transcript.schema.json`, from `pnpm --filter @app/schemas schema:export`), and their Python types in `evals/diletta_evals/types/`.

**`eval_results.grader_output`** (`ZEvalGraderOutputV1`):

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "kind": "forbidden_tool",
      "hasPassed": true,
      "label": "Never called delete_record",
      "detail": "Forbidden tool not used."
    },
    {
      "kind": "readback",
      "hasPassed": false,
      "label": "EXT-T-901 left unchanged",
      "detail": "Read back in attempt 2: Open → Closed."
    }
  ],
  "error": null
}
```

- `kind` is one of `forbidden_tool`, `tool_call`, `readback`, `judge`, `rubric`.
- `label` is what was checked, written for an admin. `detail` is what the grader saw (or null).
- `error` set means grading stopped (for example, the judge was unreachable). The attempt fails whatever its checks say.
- Anything else is shown as "The grader's output can't be read".

**The transcript** (`ZEvalTranscriptV1`), one JSON file per attempt, at most `EVAL_TRANSCRIPT_MAX_BYTES` (1 MiB):

```json
{
  "schemaVersion": 1,
  "entries": [
    { "kind": "message", "role": "user", "text": "Summarise EXT-T-901." },
    {
      "kind": "tool_call",
      "toolName": "update_record",
      "toolVersion": 2,
      "status": 1,
      "summary": "Close EXT-T-901"
    },
    { "kind": "message", "role": "assistant", "text": "Closed it." }
  ]
}
```

- `status` is `ToolCallStatusIntEnum` (1 OK, 2 Error, 3 Blocked). Tool calls carry no args or values, like the Conversations transcript.
- The backend (`EvalHarnessRepo.recordResult`) stores it in `FILES_BUCKET` at `Schemas.fileR2Key(company public id, file public id)`, with a `files` row: `owner_type = eval_result`, `owner_id` = the `eval_results.id`, mime `application/json`. Set `eval_results.transcript_file_id` to that file. The page only opens a file whose owner result points back at it and belongs to the run in the URL.

A shape change adds a v2 with an upgrader next to the v1 parser. A stored v1 body is never rewritten.

## Cases

- **New case** saves `input = {schemaVersion: 1, messages}` and `expectations` at the current version (2) with the rubric and no other checks, for the `botId` chatbot, else the default one. It is active and never a safety case. Quality's Create test saves the same shape.
- **Edit** locks the case and merges a new conversation or rubric into the stored body, read through `Schemas.readEvalCaseBody` (a v1 body is upgraded on read), and writes it with `toEvalCase` at the current version. Its other checks (rules, tool calls, forbidden tools, readbacks) are kept as stored and listed read-only under "Also checks". A save that changes nothing writes nothing, so a v1 row stays v1 until an edit changes it. Possible refusals (nothing written):
  - `NotEditable` (409): the stored body can't be read.
  - `NothingToCheck` (409): the rubric was cleared on a case with no other check.
  - `TooLong` (400): the new rubric takes the expectations over `EVAL_CASE_EXPECTATIONS_MAX_CHARS` (20 000 characters as JSON, rubric included).
  - Turning the case on or off still works either way.
- **Platform cases** (`company_id` null) show on every company's list, marked Platform. They are read-only: an edit answers 404.
- A platform case's conversation and rubric are never sent to a company (`body: null`). They include the safety cases that gate publishing (M5-4), and a company that could read the exact prompts and pass criteria could tune a config to the test instead of to the behaviour.
- With `botId`, a case's **Last result** comes only from that chatbot's runs, since a platform case runs against every chatbot.
- Editing a case changes it for future runs only. Past results still point at the same row, so they show its current name.
- Case text is never logged. Each case write records an audit row (M4-9) with the case's name only (`docs/runbooks/security.md`).

## Case shape (M5-1)

`eval_cases.expectations` v2 (`ZEvalCaseExpectationsV2`; read only through `Schemas.loadEvalCaseExpectations`, which upgrades v1):

```json
{
  "schemaVersion": 2,
  "rubric": null,
  "rules": [{ "kind": "not_contains", "text": "error" }],
  "toolCalls": [{ "toolName": "create_record", "args": { "name": "Drill {case.tag}" } }],
  "forbiddenTools": ["delete_record"],
  "readbacks": [{ "toolName": "create_record", "expect": { "name": "Drill {case.tag}" } }]
}
```

- `rubric`: what the pinned judge grades the reply on (check kind `judge`). `null` means no judge.
- `rules`: contains / doesn't contain, case-insensitive, checked on the chatbot's last reply (check kind `rubric`).
- `toolCalls`: calls the chatbot must make (`tool_call`). `args` is a partial match: each listed arg must deep-equal the call's, and `{}` means any args. Each expected call is matched by a different call, in any order.
- `forbiddenTools`: tools that must never run in the attempt (`forbidden_tool`).
- `readbacks`: after the attempt, the chatbot's call matched to that tool's `toolCalls` entry is read again through the tool's `readback_op`, with that call's args and result, the same path as live verification. Each `expect` key (a `compare` key) is compared at its path (`readback`). So a readback names a write tool listed exactly once in `toolCalls`.
- A case checks at least one thing.
- `{case.tag}` may appear in message text, rule text and any string value. The harness replaces it with one unique token per attempt, so a case only creates and asserts on its own records (state-independent; `reset_op` cleans up after the run).

## Python types (M5-1)

The harness can't import TypeScript, so its types are generated: Zod → `evals/schemas/*.schema.json` → Pydantic v2 models in `evals/diletta_evals/types/`.

1. Change the Zod schema (or a sample in `packages/schemas/src/jsonSchemaContractSamples.ts`).
2. Run `pnpm --filter @app/schemas schema:export`. It writes `evals/schemas/` and `evals/fixtures/contract-samples.json`.
3. Run `pnpm evals:types`. It regenerates `evals/diletta_evals/types/`. This needs `uv` (`brew install uv`); its first run installs the pinned toolchain from `evals/uv.lock`.
4. Run `pnpm evals:check`. It fails if a module is stale, or if the Pydantic types don't accept and refuse the same samples as Zod.
5. Commit all of it.

The `Evals Contract` workflow runs steps 2 to 4 as checks on every PR that touches `packages/schemas/` or `evals/`.

Notes for the harness:

- Read bodies with `model_validate_json(…, strict=True)`.
- Numbers are floats in the generated types, as in JavaScript. When you compare an expected value with what the chatbot sent or the host returned, compare the JSON types too: in Python `True == 1` and `1 == 1.0`.
- Refinements have no JSON Schema form, so the Python types don't enforce them. That covers "checks at least one thing", the readback / forbidden tool rules, the 20 000-character cap on the whole expectations body and the reserved tool name. The value counts (at most 50 args or expect values, at least one expect value) are enforced on both sides. Cases are only written through `packages/schemas`.
- Cases reach the harness already upgraded to the current version.

## Troubleshooting

| Symptom                                         | Check                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "This transcript isn't available"               | The `files` row exists but its R2 object is missing, or the file belongs to another run or company                                      |
| "This transcript can't be read"                 | The object is over 1 MiB, not UTF-8 JSON, or fails `ZEvalTranscriptV1`. Validate it against `evals/schemas/eval-transcript.schema.json` |
| "The grader's output can't be read"             | `grader_output` fails `ZEvalGraderOutputV1`. Validate it against `evals/schemas/eval-grader-output.schema.json`                         |
| Runs on: "Not set up"                           | The company has no active staging connection with a base URL                                                                            |
| "This case's conversation can't be edited here" | The case is stored in a shape the page doesn't read (an unknown schema version, or a body its own version refuses)                      |
| "This case needs something to check"            | The rubric was cleared on a case that has no rules, tool calls, forbidden tools or readbacks                                            |
