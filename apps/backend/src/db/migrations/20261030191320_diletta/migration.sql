ALTER TABLE "eval_cases" ADD COLUMN "platform_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_eval_cases_platform_key" ON "eval_cases" ("platform_key");--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "CHK_eval_cases_platform_key" CHECK ("platform_key" IS NULL OR "company_id" IS NULL);