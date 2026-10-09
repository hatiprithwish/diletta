# Knowledge ingestion

A company's knowledge comes from sources: a sitemap, a single URL, or uploaded files (M2-5). Each sync turns them into documents (one per page or file, bytes in R2) and chunks (searchable pieces with a bge-m3 embedding). A page whose text hasn't changed since the last sync is skipped: no chunking and no embed call.

## One-time setup (per environment)

1. Create the R2 bucket the worker binds as `FILES_BUCKET`:

   ```bash
   pnpm --filter backend exec wrangler r2 bucket create diletta-files-staging
   pnpm --filter backend exec wrangler r2 bucket create diletta-files-production
   ```

   Keep both buckets private: no public access and no custom domain. Objects are read only through the worker.

2. Nothing else needs creating by hand. The `KNOWLEDGE_SYNC_WORKFLOW` workflow (`diletta-knowledge-sync-staging` / `-production`) is created on the first deploy, and the `AI` binding has no setup. Embeddings go through the env's AI Gateway (`AI_GATEWAY_NAME`, `docs/runbooks/ai-gateway.md`) for logs.

Local dev (`pnpm dev`) uses a local bucket and local workflows, but the `AI` binding always calls Cloudflare, so run `wrangler login` first. Tests never call Workers AI.

## How a sync runs

| Step      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start     | Creating a web source, `POST /dashboard/knowledge-sources/:id/sync`, an upload, resuming an upload source, or the hourly Cron (Daily sources after 24 h, Weekly after 7 days, Failed Daily / Weekly sources 6 h after their last attempt, syncs whose heartbeat stopped 6 h ago). The source becomes Syncing under a new run id, and one workflow instance with that id starts. If the start fails, the source becomes Failed. |
| List      | Sitemap: every page URL on the sitemap's site (`www.` and the bare domain count as one), following sitemap indexes 2 levels deep, at most 20 sitemap files and 500 pages. URL source: that page. Upload source: its documents that are Pending, Failed or indexed by an older pipeline.                                                                                                                                        |
| Each item | Fetch (15 s and 5 MB caps; every redirect must stay on the site) or read from R2 → convert to markdown → hash the text. Same hash as the stored document: only `last_synced_at` moves. Otherwise chunk, embed, write the bytes to R2 as a new file, then store the file row, document and chunks in one transaction.                                                                                                           |
| Prune     | Web sources, only when the listing was complete and not empty: documents whose URL is no longer listed are deleted with their chunks, file rows and R2 objects. If a nested sitemap failed or a cap cut the listing short, nothing is pruned.                                                                                                                                                                                  |
| Finish    | Active with `last_synced_at` = now. Failed when the sitemap couldn't be read or every item failed. An upload source that got files after its last listing starts another sync.                                                                                                                                                                                                                                                 |

Only the run whose id the source holds can write. Pausing, deleting, or claiming a new sync makes an older run stop at its next step without writing anything. A step that hits a database or storage error is retried by Workflows (3 times, backing off); after that the source is marked Failed.

A page that fails (404, timeout, redirect to another site, unsupported type, conversion or embedding error) marks its document Failed and the sync goes on. A Failed document keeps its old chunks until a later sync indexes it again.

A paused source can't sync until it's resumed (`status: 1`). Resuming an upload source syncs the files uploaded while it was paused.

Formats: HTML, PDF and DOCX are converted by Workers AI `toMarkdown`; Markdown and plain text are decoded by their byte-order mark or charset. Uploads are at most 10 MB (the request is refused with 413 before it's read), and a PDF or DOCX must really be one (400 otherwise).

## Cost

Embeddings are the only model calls the platform pays for: `@cf/baai/bge-m3`, $0.012 per million input tokens (2026-10-09). Each Workers AI call writes one `model_calls` row (tier 4 Embed, provider `workers_ai`, usage Estimated at one token per character, which overcounts). They are left out of the company's budget.

```sql
-- Embedding spend per company this month (owner connection)
SELECT c.public_id, count(*) AS calls, sum(m.input_tokens) AS tokens, sum(m.cost_usd) AS cost_usd
FROM model_calls m JOIN companies c ON c.id = m.company_id
WHERE m.task_type = 'knowledge.embed' AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
GROUP BY c.public_id ORDER BY cost_usd DESC;
```

## Operations

**A source sits in Syncing.** Its workflow may have died. Once `sync_heartbeat_at` is 6 hours old (`KNOWLEDGE_SYNC_STALE_MS`; every step refreshes it), the next sync request or the hourly Cron claims it again under a new run id. The old run, if it wakes up, stops without writing. To look at the instance:

```bash
pnpm --filter backend exec wrangler workflows instances list diletta-knowledge-sync-staging
pnpm --filter backend exec wrangler workflows instances describe diletta-knowledge-sync-staging <instance id>
```

Instance ids are `ks-{source public_id}-{ULID}`.

**A page keeps failing.** Find the reason in the worker logs (`IngestKnowledgeSyncItem`, metadata `reason`). Common causes: the site blocks our user agent (`DilettaBot/1.0`), the page is over 5 MB, or the content type isn't supported.

**Re-index after a chunking or embedding model change.** Bump `KNOWLEDGE_PIPELINE_VERSION` (`packages/schemas/src/knowledgeIngestion/`). Every stored `content_hash` starts with the old version, so each document is chunked and embedded again at its next sync. Upload sources list those documents too.

**Force a re-index of one source** without a code change. Clear its hashes, then sync:

```sql
UPDATE knowledge_documents SET content_hash = NULL, updated_at = now()
WHERE knowledge_source_id = (SELECT id FROM knowledge_sources WHERE public_id = '<source public id>');
```

**R2 objects with no row.** A failed delete after a commit is logged (`DeleteFileObjects`, metadata `keys`). Delete those keys by hand:

```bash
pnpm --filter backend exec wrangler r2 object delete diletta-files-staging/<key>
```

## Known gaps

- robots.txt is not read: sources are the company's own sites.
- Pages are fetched, not rendered, so content built by JavaScript after load is missed.
- Converted HTML keeps navigation and footer text, which ends up in chunks.
- No audit events for source changes yet (M4-9).
- The same page listed under both `www.` and the bare domain is stored twice (one document per URL).
