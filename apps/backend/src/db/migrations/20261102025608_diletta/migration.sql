DROP INDEX "IDX_conversations_last_activity_at_unpurged";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "content_purge_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "IDX_conversations_company_id_last_activity_at_unpurged" ON "conversations" ("company_id","last_activity_at") WHERE "content_purged_at" IS NULL;