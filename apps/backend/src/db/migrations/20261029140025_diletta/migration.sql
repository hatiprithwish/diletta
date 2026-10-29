ALTER TABLE "conversations" ADD COLUMN "eval_run_id" bigint;--> statement-breakpoint
CREATE INDEX "IDX_conversations_eval_run_id" ON "conversations" ("eval_run_id");