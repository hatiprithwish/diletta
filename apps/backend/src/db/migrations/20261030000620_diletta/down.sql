-- Down for 20261030000620_diletta: drops eval_runs.company_connection_id and eval_case_ids (an eval run's staging connection and case set, M5-2)
DROP INDEX IF EXISTS "IDX_eval_runs_company_connection_id";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "eval_case_ids";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "company_connection_id";
