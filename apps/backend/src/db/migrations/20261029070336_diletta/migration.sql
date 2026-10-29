ALTER TABLE "admins" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "removed_by" bigint;--> statement-breakpoint
CREATE INDEX "IDX_admins_removed_by" ON "admins" ("removed_by");