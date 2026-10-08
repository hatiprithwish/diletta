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
  // wrangler.jsonc triggers.crons exactly.
  static readonly OUTBOX_SWEEP_CRON = "* * * * *";
  static readonly ACTIVITY_LOG_PARTITIONS_CRON = "0 3 * * *";
}
