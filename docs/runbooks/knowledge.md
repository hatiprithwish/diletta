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

| Step      | What happens                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start     | Creating a web source, `POST /dashboard/knowledge-sources/:id/sync`, an upload, or the hourly Cron (Daily sources after 24 h, Weekly after 7 days). The source becomes Syncing and one workflow instance starts. If the start fails, the source becomes Failed. |
| List      | Sitemap: every page URL on the sitemap's own host, following sitemap indexes 2 levels deep, at most 500. URL source: that page. Upload source: its documents.                                                                                                   |
| Each item | Fetch (15 s, 5 MB cap) or read from R2 → convert to markdown → hash the text. Same hash as the stored document: only `last_synced_at` moves. Otherwise chunk, embed, and store the file, document and chunks in one transaction.                                |
| Prune     | Web sources: documents whose URL is no longer listed are deleted with their chunks, file rows and R2 objects.                                                                                                                                                   |
| Finish    | Active with `last_synced_at` = now. Failed when the sitemap couldn't be read or every item failed.                                                                                                                                                              |

A page that fails (404, timeout, unsupported type, conversion or embedding error) marks its document Failed and the sync goes on. A Failed document keeps its old chunks until a later sync indexes it again.

Pausing a source (`PATCH … { status: 4 }`) or deleting it stops a running sync at its next item: the sync writes nothing more. A paused source can't sync until it's resumed (`status: 1`).

Formats: HTML, PDF and DOCX are converted by Workers AI `toMarkdown`; Markdown and plain text are read as they are. Uploads are at most 10 MB.

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

**A source sits in Syncing.** Its workflow may have died. After 6 hours (`KNOWLEDGE_SYNC_STALE_MS`) the next sync request or the hourly Cron claims it again. To look at the instance:

```bash
pnpm --filter backend exec wrangler workflows instances list diletta-knowledge-sync-staging
pnpm --filter backend exec wrangler workflows instances describe diletta-knowledge-sync-staging <instance id>
```

Instance ids are `ks-{source public_id}-{ULID}`.

**A page keeps failing.** Find the reason in the worker logs (`IngestKnowledgeSyncItem`, metadata `reason`). Common causes: the site blocks our user agent (`DilettaBot/1.0`), the page is over 5 MB, or the content type isn't supported.

**Force a full re-index of a source** (after a chunking or embedding model change). Clear the hashes, then sync:

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
