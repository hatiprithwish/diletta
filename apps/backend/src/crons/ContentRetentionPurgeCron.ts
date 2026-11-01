import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import ContentRetentionRepo from "@/repositories/ContentRetentionRepo";

// DEV_NOTE: Every hour (M6-1): clear the content of chats past their company's retention. Goes through
// ContentRetentionRepo, never a DAL (pattern rule 1.1). What it skips or fails on stays due, so a missed hour only
// delays a purge by an hour.
export default async function runContentRetentionPurge(env: Env): Promise<void> {
  const purged = await new ContentRetentionRepo(env).purgeExpiredContent();
  if (!purged.isSuccess || purged.purgedCount || purged.skippedCount) {
    const entry = {
      category: Schemas.LogCategory.Conversation,
      action: Schemas.LogAction.PurgeConversationContent,
      message: purged.message ?? "Conversation content purged",
      metadata: { purgedCount: purged.purgedCount ?? 0, skippedCount: purged.skippedCount ?? 0 },
    };
    if (purged.isSuccess) {
      AppLogger.info(entry);
    } else {
      AppLogger.error(entry);
    }
  }
}
