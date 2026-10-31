-- Down for 20261029140025_diletta: drops conversations.eval_run_id (eval attempts' conversations, M5-2)
DROP INDEX IF EXISTS "IDX_conversations_eval_run_id";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "eval_run_id";
