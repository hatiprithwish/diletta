-- Down for 20261008040849_activity_log_partition_maintenance: drops both functions (their grants go with them).
-- Partitions the Cron already created stay: they are ordinary activity_log partitions and may hold rows.
DROP FUNCTION "activity_log_default_has_rows"();--> statement-breakpoint
DROP FUNCTION "create_activity_log_partition"(timestamptz);
