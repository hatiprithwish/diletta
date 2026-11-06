ALTER TABLE "conversations" DROP CONSTRAINT "CHK_conversations_eval_attempt", ADD CONSTRAINT "CHK_conversations_eval_attempt" CHECK (("eval_run_id" IS NULL) = ("eval_case_id" IS NULL) AND ("eval_run_id" IS NULL) = ("eval_attempt" IS NULL));--> statement-breakpoint
DROP INDEX "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt_eval_try";--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt" ON "conversations" ("eval_run_id","eval_case_id","eval_attempt");--> statement-breakpoint
ALTER TABLE "eval_runs" DROP COLUMN "resumed_count";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "eval_try";
