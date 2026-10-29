-- Down for 20261029070336_diletta: drops admins.removed_at / removed_by (Settings › Team removal, M4-10)
DROP INDEX IF EXISTS "IDX_admins_removed_by";--> statement-breakpoint
ALTER TABLE "admins" DROP COLUMN IF EXISTS "removed_by";--> statement-breakpoint
ALTER TABLE "admins" DROP COLUMN IF EXISTS "removed_at";
