-- Custom SQL migration file, put your code below! --
-- DEV_NOTE: admin_invites (Settings › Team, M4-10), the first table added after *_rls_policies: granted to diletta_app by
-- name (no default privileges) and, as a tenant table, RLS enabled and forced with a tenant and a platform policy,
-- mirroring *_rls_policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_invites" TO diletta_app;--> statement-breakpoint
ALTER TABLE "admin_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "POL_admin_invites_tenant" ON "admin_invites" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_admin_invites_platform" ON "admin_invites" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');
