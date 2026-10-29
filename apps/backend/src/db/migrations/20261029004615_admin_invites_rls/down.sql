-- Down for 20261029004615_admin_invites_rls: drops admin_invites' policies, RLS and grant
DROP POLICY IF EXISTS "POL_admin_invites_platform" ON "admin_invites";--> statement-breakpoint
DROP POLICY IF EXISTS "POL_admin_invites_tenant" ON "admin_invites";--> statement-breakpoint
ALTER TABLE "admin_invites" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_invites" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "admin_invites" FROM diletta_app;
