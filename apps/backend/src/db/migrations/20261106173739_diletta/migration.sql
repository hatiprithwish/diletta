DROP INDEX "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "eval_try" smallint;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "resumed_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "conversations" SET "eval_try" = 0 WHERE "eval_run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt_eval_try" ON "conversations" ("eval_run_id","eval_case_id","eval_attempt","eval_try");--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "CHK_conversations_eval_attempt", ADD CONSTRAINT "CHK_conversations_eval_attempt" CHECK (("eval_run_id" IS NULL) = ("eval_case_id" IS NULL) AND ("eval_run_id" IS NULL) = ("eval_attempt" IS NULL) AND ("eval_run_id" IS NULL) = ("eval_try" IS NULL));