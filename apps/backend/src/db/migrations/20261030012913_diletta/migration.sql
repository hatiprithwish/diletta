ALTER TABLE "conversations" ADD COLUMN "eval_case_id" bigint;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "eval_attempt" smallint;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "company_connection_id" bigint;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "eval_case_ids" bigint[];--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "reset_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "IDX_conversations_eval_case_id" ON "conversations" ("eval_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt" ON "conversations" ("eval_run_id","eval_case_id","eval_attempt");--> statement-breakpoint
CREATE INDEX "IDX_eval_runs_company_connection_id" ON "eval_runs" ("company_connection_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "CHK_conversations_eval_attempt" CHECK (("eval_run_id" IS NULL) = ("eval_case_id" IS NULL) AND ("eval_run_id" IS NULL) = ("eval_attempt" IS NULL));