ALTER TABLE "quality_issues" ADD COLUMN "chatbot_id" bigint;--> statement-breakpoint
-- Backfill (M5-5): every issue so far is on a conversation; its chatbot is the conversation's
UPDATE "quality_issues" AS "q" SET "chatbot_id" = "c"."chatbot_id" FROM "conversations" AS "c" WHERE "c"."id" = "q"."conversation_id" AND "c"."company_id" = "q"."company_id";--> statement-breakpoint
ALTER TABLE "quality_issues" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "IDX_quality_issues_chatbot_id" ON "quality_issues" ("chatbot_id");--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "CHK_quality_issues_system_conversation_id" CHECK ("conversation_id" IS NOT NULL OR ("source" = 3 AND "chatbot_id" IS NOT NULL));