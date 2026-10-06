-- Custom SQL migration (drizzle-kit generate --custom). Row-level security for every tenant table (M1-3).
-- diletta_app is the least-privilege role the worker connects as (via Hyperdrive). It is created NOLOGIN here;
-- login and password are set per Neon branch outside git (docs/runbooks/app-role.md). The owner role keeps
-- BYPASSRLS and runs migrations only.
-- Grants are explicit per table, with no default privileges: a new table is invisible to the app until its own
-- migration grants it and adds its policies. activity_log partitions get no grants, so the app reaches them only
-- through the parent, where its policies apply.
-- Policies (permissive, OR-ed): tenant = company_id matches app.company_id (withTenant); platform =
-- app.is_platform is 'on' (withPlatform: operator, cross-company Cron, pre-tenant lookups). Both settings are
-- transaction-local; with neither set the app sees no rows and can write none. NULLIF turns the '' a reset
-- setting reads back as into NULL, so a missing context matches nothing instead of failing the cast.
-- companies matches on id; tenants may read and update their own row only. admins with company_id NULL
-- (operators) and eval_cases with company_id NULL (platform cases) never match a tenant; tenants may read
-- platform cases (their publish gate runs the platform safety cases) but never write them.
-- users is the non-tenant scaffold table: granted, no RLS.
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'diletta_app') THEN
		CREATE ROLE diletta_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "activity_log" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "activity_rollups" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "admins" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "change_requests" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chatbot_configs" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chatbot_user_secrets" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chatbot_users" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chatbots" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "companies" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_connections" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_encryption_keys" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_secrets" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "conversations" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "doc_gap_clusters" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "doc_gaps" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "eval_cases" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "eval_results" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "eval_runs" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "event_outbox" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "feedback" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "files" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_chunks" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_documents" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_sources" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "messages" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "model_calls" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "quality_issues" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "roi_assumptions" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tool_calls" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tool_definitions" TO diletta_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO diletta_app;--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_rollups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_rollups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admins" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_configs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_user_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_user_secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_encryption_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_encryption_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gap_clusters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gap_clusters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gaps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gaps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_calls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quality_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quality_issues" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roi_assumptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roi_assumptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_calls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "POL_companies_tenant_select" ON "companies" FOR SELECT TO diletta_app USING ("id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_companies_tenant_update" ON "companies" FOR UPDATE TO diletta_app USING ("id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_companies_platform" ON "companies" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_activity_log_tenant" ON "activity_log" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_activity_log_platform" ON "activity_log" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_activity_rollups_tenant" ON "activity_rollups" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_activity_rollups_platform" ON "activity_rollups" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_admins_tenant" ON "admins" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_admins_platform" ON "admins" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_change_requests_tenant" ON "change_requests" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_change_requests_platform" ON "change_requests" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_chatbot_configs_tenant" ON "chatbot_configs" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_chatbot_configs_platform" ON "chatbot_configs" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_chatbot_user_secrets_tenant" ON "chatbot_user_secrets" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_chatbot_user_secrets_platform" ON "chatbot_user_secrets" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_chatbot_users_tenant" ON "chatbot_users" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_chatbot_users_platform" ON "chatbot_users" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_chatbots_tenant" ON "chatbots" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_chatbots_platform" ON "chatbots" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_company_connections_tenant" ON "company_connections" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_company_connections_platform" ON "company_connections" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_company_encryption_keys_tenant" ON "company_encryption_keys" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_company_encryption_keys_platform" ON "company_encryption_keys" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_company_secrets_tenant" ON "company_secrets" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_company_secrets_platform" ON "company_secrets" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_conversations_tenant" ON "conversations" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_conversations_platform" ON "conversations" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_doc_gap_clusters_tenant" ON "doc_gap_clusters" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_doc_gap_clusters_platform" ON "doc_gap_clusters" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_doc_gaps_tenant" ON "doc_gaps" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_doc_gaps_platform" ON "doc_gaps" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_eval_cases_tenant" ON "eval_cases" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_eval_cases_platform" ON "eval_cases" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_eval_results_tenant" ON "eval_results" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_eval_results_platform" ON "eval_results" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_eval_runs_tenant" ON "eval_runs" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_eval_runs_platform" ON "eval_runs" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_event_outbox_tenant" ON "event_outbox" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_event_outbox_platform" ON "event_outbox" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_feedback_tenant" ON "feedback" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_feedback_platform" ON "feedback" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_files_tenant" ON "files" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_files_platform" ON "files" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_knowledge_chunks_tenant" ON "knowledge_chunks" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_knowledge_chunks_platform" ON "knowledge_chunks" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_knowledge_documents_tenant" ON "knowledge_documents" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_knowledge_documents_platform" ON "knowledge_documents" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_knowledge_sources_tenant" ON "knowledge_sources" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_knowledge_sources_platform" ON "knowledge_sources" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_messages_tenant" ON "messages" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_messages_platform" ON "messages" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_model_calls_tenant" ON "model_calls" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_model_calls_platform" ON "model_calls" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_quality_issues_tenant" ON "quality_issues" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_quality_issues_platform" ON "quality_issues" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_roi_assumptions_tenant" ON "roi_assumptions" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_roi_assumptions_platform" ON "roi_assumptions" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_tool_calls_tenant" ON "tool_calls" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_tool_calls_platform" ON "tool_calls" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_tool_definitions_tenant" ON "tool_definitions" FOR ALL TO diletta_app USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint)) WITH CHECK ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint));--> statement-breakpoint
CREATE POLICY "POL_tool_definitions_platform" ON "tool_definitions" FOR ALL TO diletta_app USING ((SELECT current_setting('app.is_platform', true)) = 'on') WITH CHECK ((SELECT current_setting('app.is_platform', true)) = 'on');--> statement-breakpoint
CREATE POLICY "POL_eval_cases_platform_case_select" ON "eval_cases" FOR SELECT TO diletta_app USING ("company_id" IS NULL);
