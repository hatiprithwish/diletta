-- Down for 20261008181205_diletta: drops model_calls.usage_status (M2-3 usage backfill) and its partial index.
DROP INDEX "IDX_model_calls_created_at_pending";--> statement-breakpoint
ALTER TABLE "model_calls" DROP COLUMN "usage_status";
