-- Nothing wrote these tables before M5-6, so existing rows are test residue. They take their company's default
-- chatbot (a gap its conversation's); a row that still has none fails the NOT NULL below, on purpose.
ALTER TABLE "doc_gap_clusters" ADD COLUMN "chatbot_id" bigint;--> statement-breakpoint
ALTER TABLE "doc_gaps" ADD COLUMN "chatbot_id" bigint;--> statement-breakpoint
UPDATE "doc_gap_clusters" c SET "chatbot_id" = b."id" FROM "chatbots" b WHERE b."company_id" = c."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "doc_gaps" g SET "chatbot_id" = v."chatbot_id" FROM "conversations" v WHERE v."id" = g."conversation_id" AND v."company_id" = g."company_id";--> statement-breakpoint
UPDATE "doc_gaps" g SET "chatbot_id" = b."id" FROM "chatbots" b WHERE g."chatbot_id" IS NULL AND b."company_id" = g."company_id" AND b."is_default";--> statement-breakpoint
ALTER TABLE "doc_gap_clusters" ALTER COLUMN "chatbot_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_gaps" ALTER COLUMN "chatbot_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD COLUMN "doc_gap_cluster_id" bigint;--> statement-breakpoint
CREATE INDEX "IDX_doc_gap_clusters_chatbot_id" ON "doc_gap_clusters" ("chatbot_id");--> statement-breakpoint
CREATE INDEX "IDX_doc_gaps_chatbot_id" ON "doc_gaps" ("chatbot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_quality_issues_doc_gap_cluster_id" ON "quality_issues" ("doc_gap_cluster_id");--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "CHK_quality_issues_doc_gap_cluster_id" CHECK ("doc_gap_cluster_id" IS NULL OR ("source" = 3 AND "conversation_id" IS NULL));