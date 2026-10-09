ALTER TABLE "knowledge_sources" ADD COLUMN "sync_run_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "sync_heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_knowledge_documents_knowledge_source_id_source_url" ON "knowledge_documents" ("knowledge_source_id","source_url") WHERE "source_url" IS NOT NULL;