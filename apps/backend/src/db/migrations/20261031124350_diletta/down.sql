-- Down for 20261031124350_diletta: doc gaps back to per company, quality issues no longer tied to a group of questions
ALTER TABLE "quality_issues" DROP CONSTRAINT IF EXISTS "CHK_quality_issues_doc_gap_cluster_id";--> statement-breakpoint
DROP INDEX IF EXISTS "UNQ_quality_issues_doc_gap_cluster_id";--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_doc_gaps_chatbot_id";--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_doc_gap_clusters_chatbot_id";--> statement-breakpoint
ALTER TABLE "quality_issues" DROP COLUMN IF EXISTS "doc_gap_cluster_id";--> statement-breakpoint
ALTER TABLE "doc_gaps" DROP COLUMN IF EXISTS "chatbot_id";--> statement-breakpoint
ALTER TABLE "doc_gap_clusters" DROP COLUMN IF EXISTS "chatbot_id";
