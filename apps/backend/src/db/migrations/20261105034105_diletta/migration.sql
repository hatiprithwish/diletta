ALTER TABLE "eval_runs" ADD COLUMN "started_by" bigint;--> statement-breakpoint
CREATE INDEX "IDX_eval_runs_started_by" ON "eval_runs" ("started_by");