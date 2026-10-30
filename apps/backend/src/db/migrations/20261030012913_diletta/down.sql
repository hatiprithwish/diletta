-- Down for 20261030012913_diletta: drops an eval run's case set, staging connection and reset time, and an eval conversation's case and attempt (M5-2)
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "CHK_conversations_eval_attempt";--> statement-breakpoint
DROP INDEX IF EXISTS "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt";--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_conversations_eval_case_id";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "eval_attempt";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "eval_case_id";--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_eval_runs_company_connection_id";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "reset_at";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "eval_case_ids";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "company_connection_id";
