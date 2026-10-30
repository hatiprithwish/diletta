-- Down for 20261030184111_diletta: the audit log index back to admin and operator rows only (M4-9), without the gate's System rows (M5-4)
DROP INDEX IF EXISTS "IDX_activity_log_company_id_created_at_audit";--> statement-breakpoint
CREATE INDEX "IDX_activity_log_company_id_created_at_audit" ON "activity_log" ("company_id","created_at") WHERE "actor_type" IN (2, 3);
