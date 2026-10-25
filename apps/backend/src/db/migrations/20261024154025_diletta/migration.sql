-- M4-7: knowledge_sources.name, what the admin calls the source on the Knowledge page. Hand-edited from drizzle-kit's
-- single ADD COLUMN … NOT NULL, which fails on existing rows: added nullable, existing rows named (a web source by its
-- URL's host without www., an upload source "Uploads"), then NOT NULL.
ALTER TABLE "knowledge_sources" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "knowledge_sources" SET "name" = coalesce(substring("url" from '^https?://(?:www\.)?([^/:?#]+)'), 'Uploads');--> statement-breakpoint
ALTER TABLE "knowledge_sources" ALTER COLUMN "name" SET NOT NULL;
