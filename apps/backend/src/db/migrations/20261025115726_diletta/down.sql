-- Down for 20261025115726_diletta: drops the audit log index on activity_log (M4-9)
DROP INDEX IF EXISTS "IDX_activity_log_company_id_created_at_audit";
