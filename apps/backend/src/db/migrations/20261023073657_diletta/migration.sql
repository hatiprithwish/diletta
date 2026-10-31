CREATE INDEX "IDX_activity_log_company_id_created_at" ON "activity_log" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_conversations_company_id_created_at" ON "conversations" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_feedback_company_id_created_at" ON "feedback" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_company_id_created_at" ON "model_calls" ("company_id","created_at");--> statement-breakpoint
DROP INDEX "IDX_activity_log_company_id";--> statement-breakpoint
DROP INDEX "IDX_conversations_company_id";--> statement-breakpoint
DROP INDEX "IDX_feedback_company_id";--> statement-breakpoint
DROP INDEX "IDX_model_calls_company_id";
