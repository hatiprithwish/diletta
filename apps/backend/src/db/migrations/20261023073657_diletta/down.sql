-- Down for 20261023073657_diletta: back to the single-column company_id indexes (M4-2 replaced them with
-- (company_id, created_at) for the activity rollup day reads).
CREATE INDEX "IDX_activity_log_company_id" ON "activity_log" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_conversations_company_id" ON "conversations" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_company_id" ON "feedback" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_company_id" ON "model_calls" ("company_id");--> statement-breakpoint
DROP INDEX "IDX_activity_log_company_id_created_at";--> statement-breakpoint
DROP INDEX "IDX_conversations_company_id_created_at";--> statement-breakpoint
DROP INDEX "IDX_feedback_company_id_created_at";--> statement-breakpoint
DROP INDEX "IDX_model_calls_company_id_created_at";
