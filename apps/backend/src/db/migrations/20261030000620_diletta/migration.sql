ALTER TABLE "eval_runs" ADD COLUMN "company_connection_id" bigint;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "eval_case_ids" bigint[];--> statement-breakpoint
CREATE INDEX "IDX_eval_runs_company_connection_id" ON "eval_runs" ("company_connection_id");