-- Down for 20261107030419_feedback_themes_rls: drops the feedback themes tables' policies, RLS and grants
DROP POLICY IF EXISTS "POL_feedback_notes_platform" ON "feedback_notes";--> statement-breakpoint
DROP POLICY IF EXISTS "POL_feedback_notes_tenant" ON "feedback_notes";--> statement-breakpoint
DROP POLICY IF EXISTS "POL_feedback_themes_platform" ON "feedback_themes";--> statement-breakpoint
DROP POLICY IF EXISTS "POL_feedback_themes_tenant" ON "feedback_themes";--> statement-breakpoint
ALTER TABLE "feedback_notes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_notes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_themes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_themes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "feedback_notes" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "feedback_themes" FROM diletta_app;
