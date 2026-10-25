# Tests page

The dashboard's Tests page (M4-8) shows the eval runs of a company's chatbot configs, what each case's attempts found, and the transcript of any attempt. Cases are written and edited there too. Running tests is not built yet: the harness (M5-2) starts runs and writes their results, and M5-3 writes the grader output and transcripts. Until then, runs only appear when something writes them (the backend tests seed them).

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
- A run's **status** Failed means it didn't finish (the page says "Didn't finish"). Passed or failed comes from `has_passed` on a Done run.

## What the harness must write (M5-2, M5-3)

The page reads these shapes. Their JSON Schema lives in `evals/schemas/` (`eval-grader-output.schema.json`, `eval-transcript.schema.json`, from `pnpm --filter @app/schemas schema:export`).

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
- Store it in `FILES_BUCKET` at `Schemas.fileR2Key(company public id, file public id)`, with a `files` row: `owner_type = eval_result`, `owner_id` = the `eval_results.id`, mime `application/json`. Set `eval_results.transcript_file_id` to that file. The page only opens a file whose owner result points back at it and belongs to the run in the URL.

A shape change adds a v2 with an upgrader next to the v1 parser. A stored v1 body is never rewritten.

## Cases

- **New case** saves a v1 case (`input = {schemaVersion: 1, messages}`, `expectations = {schemaVersion: 1, rubric}`) for the `botId` chatbot, else the default one. It is active and never a safety case.
- **Edit** locks the case and merges a new conversation or rubric into the stored v1 body (`Schemas.readEvalCaseBody` / `toEvalCaseV1`). A body in another shape is refused with 409 `NotEditable`, and nothing is written. Turning it on or off still works.
- **Platform cases** (`company_id` null) show on every company's list, marked Platform. They are read-only: an edit answers 404.
- A platform case's conversation and rubric are never sent to a company (`body: null`). They include the safety cases that gate publishing (M5-4), and a company that could read the exact prompts and pass criteria could tune a config to the test instead of to the behaviour.
- With `botId`, a case's **Last result** comes only from that chatbot's runs, since a platform case runs against every chatbot.
- Editing a case changes it for future runs only. Past results still point at the same row, so they show its current name.
- Case text is never logged. Each case write records an audit row (M4-9) with the case's name only (`docs/runbooks/security.md`).

## Troubleshooting

| Symptom                                         | Check                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "This transcript isn't available"               | The `files` row exists but its R2 object is missing, or the file belongs to another run or company                                      |
| "This transcript can't be read"                 | The object is over 1 MiB, not UTF-8 JSON, or fails `ZEvalTranscriptV1`. Validate it against `evals/schemas/eval-transcript.schema.json` |
| "The grader's output can't be read"             | `grader_output` fails `ZEvalGraderOutputV1`. Validate it against `evals/schemas/eval-grader-output.schema.json`                         |
| Runs on: "Not set up"                           | The company has no active staging connection with a base URL                                                                            |
| "This case's conversation can't be edited here" | The case is stored in a shape the page doesn't edit (a later schema version)                                                            |
