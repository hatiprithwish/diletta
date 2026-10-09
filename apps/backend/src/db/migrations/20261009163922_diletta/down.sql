-- Down for 20261009163922_diletta: drops the one-document-per-page index and the sync run columns on knowledge_sources (M2-5 review).
DROP INDEX "UNQ_knowledge_documents_knowledge_source_id_source_url";--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP COLUMN "sync_heartbeat_at";--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP COLUMN "sync_run_id";
