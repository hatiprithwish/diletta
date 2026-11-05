-- Down for 20261105034105_diletta: eval_runs without the admin who started a run from the dashboard (M7-9)
DROP INDEX IF EXISTS "IDX_eval_runs_started_by";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "started_by";
