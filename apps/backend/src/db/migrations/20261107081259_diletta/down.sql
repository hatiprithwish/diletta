-- Down for 20261107081259_diletta: drops the tool contract sync columns (ADR 0009)
ALTER TABLE "tool_definitions" DROP COLUMN IF EXISTS "contract_hash";--> statement-breakpoint
ALTER TABLE "tool_definitions" DROP COLUMN IF EXISTS "operation_id";--> statement-breakpoint
ALTER TABLE "company_connections" DROP COLUMN IF EXISTS "openapi_failure";--> statement-breakpoint
ALTER TABLE "company_connections" DROP COLUMN IF EXISTS "openapi_synced_at";--> statement-breakpoint
ALTER TABLE "company_connections" DROP COLUMN IF EXISTS "openapi_spec_hash";--> statement-breakpoint
ALTER TABLE "company_connections" DROP COLUMN IF EXISTS "openapi_shaping";--> statement-breakpoint
ALTER TABLE "company_connections" DROP COLUMN IF EXISTS "openapi_url";
