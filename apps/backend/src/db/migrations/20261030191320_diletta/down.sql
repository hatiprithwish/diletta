-- Down for 20261030191320_diletta: eval_cases without the platform suite's platform_key (M5-5)
ALTER TABLE "eval_cases" DROP CONSTRAINT IF EXISTS "CHK_eval_cases_platform_key";--> statement-breakpoint
DROP INDEX IF EXISTS "UNQ_eval_cases_platform_key";--> statement-breakpoint
ALTER TABLE "eval_cases" DROP COLUMN IF EXISTS "platform_key";
