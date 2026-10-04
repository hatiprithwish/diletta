export default class Constants {
  static readonly APP_REDACT_FIELDS = [/clerkId/i, /clerk_id/i, /^master_?key(_?v\d+)?$/i];

  static readonly APP_NAME = "diletta-worker" as const;

  // DEV_NOTE: Master key version new company keys are wrapped with. See docs/runbooks/master-key.md.
  static readonly CURRENT_MASTER_KEY_VERSION = 1;
}
