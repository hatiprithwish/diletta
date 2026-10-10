export default class Constants {
  // DEV_NOTE: display_name is chatbot-user PII (erased on request), so it never reaches a log
  static readonly APP_REDACT_FIELDS = [
    /clerkId/i,
    /clerk_id/i,
    /^master_?key(_?v\d+)?$/i,
    /display_?name/i,
    // DEV_NOTE: Backstop for decrypted values (logtape's defaults already cover secret, key, token, credential)
    /plaintext/i,
  ];

  static readonly APP_NAME = "diletta-worker" as const;

  // DEV_NOTE: Page defaults the Repo fills when a list request leaves them out (cap: Schemas.MAX_PAGE_SIZE)
  static readonly DEFAULT_PAGE_NO = 1;
  static readonly DEFAULT_PAGE_SIZE = 10;

  // DEV_NOTE: Master key version new company keys are wrapped with. See docs/runbooks/master-key.md.
  static readonly CURRENT_MASTER_KEY_VERSION = 1;

  // DEV_NOTE: Outbox relay (M1-6). The Cron sweep picks pending rows older than the min age, so it never races the
  // after-commit relay of a row just written; a row the Queue rejects OUTBOX_MAX_ATTEMPTS times moves to Failed and
  // alerts (a Queue outage counts no attempts). Published rows are purged after the retention window, which also ends their dedupe window.
  static readonly OUTBOX_SWEEP_MIN_AGE_MS = 60_000;
  static readonly OUTBOX_BATCH_SIZE = 100; // sendBatch caps at 100 messages
  static readonly OUTBOX_SWEEP_MAX_BATCHES = 10;
  static readonly OUTBOX_MAX_ATTEMPTS = 5;
  static readonly OUTBOX_PUBLISHED_RETENTION_DAYS = 3;
  static readonly OUTBOX_LAST_ERROR_MAX_LENGTH = 500;

  // DEV_NOTE: activity_log partition maintenance (M1-9): the current UTC month plus this many after it must always
  // have a partition. The SQL function caps creation at 12 months ahead.
  static readonly ACTIVITY_LOG_PARTITION_MONTHS_AHEAD = 3;

  // DEV_NOTE: Cron expressions, matched against controller.cron in scheduled(). Each must equal its entry in
  // wrangler.jsonc triggers.crons exactly. The every-minute one also runs the model_calls usage backfill.
  static readonly OUTBOX_SWEEP_CRON = "* * * * *";
  static readonly ACTIVITY_LOG_PARTITIONS_CRON = "0 3 * * *";
  static readonly KNOWLEDGE_RESYNC_CRON = "0 * * * *";

  // DEV_NOTE: Widget auth (M2-1, ADR 0001). The companion JWT rides in Sec-WebSocket-Protocol on the upgrade. A token
  // lives at most WIDGET_JWT_MAX_LIFETIME_SECONDS (exp - iat), and exp / iat get WIDGET_JWT_CLOCK_SKEW_SECONDS of
  // slack for clock drift between the host and us.
  static readonly WIDGET_JWT_MAX_LENGTH = 8192;
  static readonly WIDGET_JWT_MAX_LIFETIME_SECONDS = 300;
  static readonly WIDGET_JWT_CLOCK_SKEW_SECONDS = 30;
  // DEV_NOTE: RSA keys shorter than 2048 bits are rejected (RFC 7518 §3.3)
  static readonly WIDGET_JWT_MIN_RSA_MODULUS_BYTES = 256;

  // DEV_NOTE: Issuer JWKS ({iss}/.well-known/jwks.json) cached in the JWKS_CACHE KV namespace. A token with a kid the
  // cached set lacks forces one refetch (the host rotated its keys), at most once per JWKS_REFETCH_MIN_INTERVAL_MS
  // per issuer. The fetch is capped in time and size; JWKS_CACHE_TTL_SECONDS must be ≥ 60 (KV minimum).
  static readonly JWKS_CACHE_KEY_PREFIX = "jwks:";
  static readonly JWKS_CACHE_TTL_SECONDS = 3600;
  static readonly JWKS_REFETCH_MIN_INTERVAL_MS = 60_000;
  static readonly JWKS_FETCH_TIMEOUT_MS = 5_000;
  static readonly JWKS_MAX_BYTES = 64 * 1024;

  // DEV_NOTE: Model call usage backfill (M2-3). A model_calls row whose call ended without usage (stream cut or
  // cancelled, connection lost) is Pending; the per-minute Cron reads its AI Gateway log once the row is older than the
  // min age (the log is written after the call), and gives up (Unknown + error log) once it is older than the max age.
  static readonly MODEL_CALL_BACKFILL_MIN_AGE_MS = 60_000;
  static readonly MODEL_CALL_BACKFILL_MAX_AGE_MS = 60 * 60_000;
  static readonly MODEL_CALL_BACKFILL_BATCH_SIZE = 50;
  static readonly MODEL_CALL_BACKFILL_CONCURRENCY = 10;
  static readonly AI_GATEWAY_LOG_FETCH_TIMEOUT_MS = 5_000;

  // DEV_NOTE: A model call the provider or gateway answers with a retryable status (408 / 409 / 429 / 5xx, the AI SDK's
  // isRetryable) is retried by the recording middleware, at most MODEL_CALL_MAX_RETRIES times: after the provider's
  // retry-after when it gives one (capped), else MODEL_CALL_RETRY_BASE_MS doubled per attempt. The SDK's own retry never
  // sees these errors (the middleware hands it only the safe ModelUnavailableError), so retries happen here only.
  static readonly MODEL_CALL_MAX_RETRIES = 2;
  static readonly MODEL_CALL_RETRY_BASE_MS = 1_000;
  static readonly MODEL_CALL_RETRY_MAX_DELAY_MS = 10_000;

  // DEV_NOTE: Budget (M2-4). Every provider call is sized at its worst case before it goes out: the prompt at
  // BUDGET_CHARS_PER_INPUT_TOKEN characters per token (fewer than any tokenizer averages, so it overcounts) plus its
  // maxOutputTokens: at most MODEL_CALL_MAX_OUTPUT_TOKENS, cut to the turn's output tokens and cost left; under
  // MODEL_CALL_MIN_OUTPUT_TOKENS the call is refused instead. BudgetDO re-reads companies.spending_budget every
  // BUDGET_REFRESH_MS, so an admin's change applies within it; a failed read is retried no sooner than
  // BUDGET_LOAD_RETRY_MS. A reservation never settled (its caller was evicted mid-call) is counted as spent after
  // BUDGET_RESERVATION_TTL_MS, longer than the longest turn (turnTimeoutSeconds ≤ 900) so a live call is never expired.
  static readonly MODEL_CALL_MAX_OUTPUT_TOKENS = 8_192;
  static readonly MODEL_CALL_MIN_OUTPUT_TOKENS = 256;
  static readonly BUDGET_CHARS_PER_INPUT_TOKEN = 3;
  static readonly BUDGET_REFRESH_MS = 60_000;
  static readonly BUDGET_LOAD_RETRY_MS = 5_000;
  static readonly BUDGET_RESERVATION_TTL_MS = 20 * 60_000;
  static readonly BUDGET_MESSAGE_WINDOW_MS = 60_000;
  static readonly BUDGET_TURN_WINDOW_MS = 60 * 60_000;

  // DEV_NOTE: The most activity rows read for one entity (an issue gathers a handful: opened, a provider per failing
  // key, triage events from M4)
  static readonly ACTIVITY_LOGS_BY_ENTITY_LIMIT = 100;

  // DEV_NOTE: Conversation DO (M2-2). The widget route hands the verified session to the DO in this header, which it
  // always sets itself (any client-sent copy is dropped); the DO has no public route, so only the worker reaches it.
  // A frame over WIDGET_FRAME_MAX_BYTES is dropped unread. A conversation idle for CONVERSATION_IDLE_CLOSE_MS closes
  // (platform default). The title is the first user message, cut to CONVERSATION_TITLE_MAX_CHARS.
  static readonly CONVERSATION_SESSION_HEADER = "x-diletta-conversation-session";
  static readonly WIDGET_FRAME_MAX_BYTES = 64 * 1024;
  static readonly CONVERSATION_IDLE_CLOSE_MS = 30 * 60_000;
  // DEV_NOTE: When the auto-close can't act yet (a turn is running, the database failed), it tries again no sooner than
  // this, so a stuck close never fires in a loop
  static readonly CONVERSATION_CLOSE_RETRY_MS = 60_000;
  static readonly CONVERSATION_TITLE_MAX_CHARS = 80;

  // DEV_NOTE: Knowledge ingestion (M2-5). One KnowledgeSyncWorkflow per source sync lists the source's items (at most
  // KNOWLEDGE_MAX_ITEMS_PER_SYNC: a sitemap's same-site page URLs, following nested sitemap indexes
  // KNOWLEDGE_SITEMAP_MAX_DEPTH deep and reading at most KNOWLEDGE_SITEMAP_MAX_FILES sitemap files, or an upload
  // source's documents with work to do), then fetches, converts, hashes, chunks and embeds one item per step. Each
  // fetch is capped in time, size and redirects (each hop must stay on the site). A Syncing source whose heartbeat is
  // older than KNOWLEDGE_SYNC_STALE_MS (its workflow died) may be claimed again; a Daily / Weekly source left Failed is
  // retried by the Cron KNOWLEDGE_FAILED_RETRY_MS after its last attempt. An upload source re-lists its Pending
  // documents after each round (files uploaded mid-sync), at most KNOWLEDGE_SYNC_MAX_ROUNDS rounds, and starts a new
  // sync if any are still Pending at the end.
  static readonly KNOWLEDGE_MAX_ITEMS_PER_SYNC = 500;
  static readonly KNOWLEDGE_SITEMAP_MAX_DEPTH = 2;
  static readonly KNOWLEDGE_SITEMAP_MAX_FILES = 20;
  static readonly KNOWLEDGE_SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
  static readonly KNOWLEDGE_PAGE_MAX_BYTES = 5 * 1024 * 1024;
  static readonly KNOWLEDGE_FETCH_TIMEOUT_MS = 15_000;
  static readonly KNOWLEDGE_FETCH_MAX_REDIRECTS = 5;
  static readonly KNOWLEDGE_FETCH_USER_AGENT = "DilettaBot/1.0 (knowledge sync)";
  static readonly KNOWLEDGE_SYNC_STALE_MS = 6 * 60 * 60_000;
  static readonly KNOWLEDGE_FAILED_RETRY_MS = 6 * 60 * 60_000;
  static readonly KNOWLEDGE_SYNC_MAX_ROUNDS = 3;
  // DEV_NOTE: The hourly Cron starts at most this many due syncs per run; the rest wait for the next hour
  static readonly KNOWLEDGE_RESYNC_BATCH_SIZE = 100;
  static readonly KNOWLEDGE_DAILY_SYNC_MS = 24 * 60 * 60_000;
  static readonly KNOWLEDGE_WEEKLY_SYNC_MS = 7 * 24 * 60 * 60_000;
  // DEV_NOTE: An upload request body is refused past this before it is parsed (the file cap plus multipart framing)
  static readonly KNOWLEDGE_UPLOAD_BODY_MAX_BYTES = 10 * 1024 * 1024 + 64 * 1024;

  // DEV_NOTE: Chunking (KnowledgeChunkerProvider): sections split at markdown headings, packed up to
  // KNOWLEDGE_CHUNK_TARGET_CHARS (~400 tokens, overlap included) with KNOWLEDGE_CHUNK_OVERLAP_CHARS carried into the
  // next chunk of the same section. Each heading is clipped to KNOWLEDGE_HEADING_MAX_CHARS and the path to
  // KNOWLEDGE_HEADING_PATH_MAX_CHARS, so the embedded text stays far under bge-m3's 8,192 tokens. A document past
  // KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT keeps its first chunks only (logged).
  static readonly KNOWLEDGE_CHUNK_TARGET_CHARS = 1_600;
  static readonly KNOWLEDGE_CHUNK_OVERLAP_CHARS = 200;
  static readonly KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT = 400;
  static readonly KNOWLEDGE_HEADING_MAX_CHARS = 200;
  static readonly KNOWLEDGE_HEADING_PATH_MAX_CHARS = 600;
  static readonly KNOWLEDGE_TITLE_MAX_CHARS = 200;

  // DEV_NOTE: Embedding (KnowledgeEmbedProvider): texts per Workers AI call (one model_calls row each)
  static readonly KNOWLEDGE_EMBED_BATCH_SIZE = 50;

  // DEV_NOTE: Hybrid search (KnowledgeSearchRepo, M2-6). Each side (HNSW vector, GIN keyword) returns its best
  // KNOWLEDGE_SEARCH_CANDIDATES_PER_SIDE; reciprocal rank fusion (1 / (KNOWLEDGE_SEARCH_RRF_K + rank), summed over the
  // sides) keeps the top KNOWLEDGE_SEARCH_RERANK_CANDIDATES for the reranker, and the config's topK of those scoring at
  // least KNOWLEDGE_SEARCH_MIN_SCORE (sigmoid rerank score, 0–1) reach the model. Fewer means the model says it
  // doesn't know. The min score is a starting value, to be tuned by the M5 evals. KNOWLEDGE_SEARCH_HNSW_EF_SEARCH is
  // the HNSW candidate list per scan (set per transaction, ≥ the candidates asked for); iterative scans keep recall
  // when the company and source filters drop most of it.
  static readonly KNOWLEDGE_SEARCH_CANDIDATES_PER_SIDE = 40;
  static readonly KNOWLEDGE_SEARCH_RRF_K = 60;
  static readonly KNOWLEDGE_SEARCH_RERANK_CANDIDATES = 20;
  static readonly KNOWLEDGE_SEARCH_MIN_SCORE = 0.2;
  static readonly KNOWLEDGE_SEARCH_HNSW_EF_SEARCH = 100;
}
