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
}
