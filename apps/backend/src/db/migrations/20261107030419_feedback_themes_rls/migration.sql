-- Custom SQL migration file, put your code below! --
-- DEV_NOTE: feedback_themes and feedback_notes (M7-10): granted to diletta_app by name (no default privileges) and, as
-- tenant tables, RLS enabled and forced with a tenant and a platform policy, mirroring *_rls_policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON "feedback_themes" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "feedback_notes" TO diletta_app;--> statement-breakpoint
ALTER TABLE "feedback_themes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_themes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "POL_feedback_themes_tenant" ON "feedback_themes" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_feedback_themes_platform" ON "feedback_themes" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_feedback_notes_tenant" ON "feedback_notes" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_feedback_notes_platform" ON "feedback_notes" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');
