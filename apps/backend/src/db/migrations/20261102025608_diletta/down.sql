DROP INDEX IF EXISTS "IDX_conversations_company_id_last_activity_at_unpurged";--> statement-breakpoint
CREATE INDEX "IDX_conversations_last_activity_at_unpurged" ON "conversations" ("last_activity_at") WHERE "content_purged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "content_purge_attempted_at";
