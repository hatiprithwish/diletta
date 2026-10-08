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

  // DEV_NOTE: Widget auth (M2-1). The first WebSocket message must carry the companion JWT within the timeout. A token
  // lives at most WIDGET_JWT_MAX_LIFETIME_SECONDS (exp - iat), and exp / iat get WIDGET_JWT_CLOCK_SKEW_SECONDS of
  // slack for clock drift between the host and us.
  static readonly WIDGET_AUTH_TIMEOUT_MS = 10_000;
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
  static readonly AI_GATEWAY_LOG_FETCH_TIMEOUT_MS = 5_000;
}
