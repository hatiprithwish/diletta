-- Down for 20261030193544_diletta: quality issues back to one per conversation (M5-5's chatbot-wide health issues removed)
ALTER TABLE "quality_issues" DROP CONSTRAINT IF EXISTS "CHK_quality_issues_system_conversation_id";--> statement-breakpoint
DELETE FROM "quality_issues" WHERE "conversation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "quality_issues" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_quality_issues_chatbot_id";--> statement-breakpoint
ALTER TABLE "quality_issues" DROP COLUMN IF EXISTS "chatbot_id";
