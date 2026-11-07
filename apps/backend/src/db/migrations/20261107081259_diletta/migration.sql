ALTER TABLE "company_connections" ADD COLUMN "openapi_url" text;--> statement-breakpoint
ALTER TABLE "company_connections" ADD COLUMN "openapi_shaping" jsonb;--> statement-breakpoint
ALTER TABLE "company_connections" ADD COLUMN "openapi_spec_hash" text;--> statement-breakpoint
ALTER TABLE "company_connections" ADD COLUMN "openapi_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_connections" ADD COLUMN "openapi_failure" smallint;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD COLUMN "contract_hash" text;