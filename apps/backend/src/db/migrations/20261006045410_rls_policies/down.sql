-- Down for 20261006045410_rls_policies: drops every policy, turns RLS off, revokes diletta_app's grants and drops it.
-- Explicit REVOKEs, not DROP OWNED BY: the Neon owner role isn't a member of diletta_app, so DROP OWNED is denied.
DROP POLICY "POL_eval_cases_platform_case_select" ON "eval_cases";--> statement-breakpoint
DROP POLICY "POL_tool_definitions_platform" ON "tool_definitions";--> statement-breakpoint
DROP POLICY "POL_tool_definitions_tenant" ON "tool_definitions";--> statement-breakpoint
DROP POLICY "POL_tool_calls_platform" ON "tool_calls";--> statement-breakpoint
DROP POLICY "POL_tool_calls_tenant" ON "tool_calls";--> statement-breakpoint
DROP POLICY "POL_roi_assumptions_platform" ON "roi_assumptions";--> statement-breakpoint
DROP POLICY "POL_roi_assumptions_tenant" ON "roi_assumptions";--> statement-breakpoint
DROP POLICY "POL_quality_issues_platform" ON "quality_issues";--> statement-breakpoint
DROP POLICY "POL_quality_issues_tenant" ON "quality_issues";--> statement-breakpoint
DROP POLICY "POL_model_calls_platform" ON "model_calls";--> statement-breakpoint
DROP POLICY "POL_model_calls_tenant" ON "model_calls";--> statement-breakpoint
DROP POLICY "POL_messages_platform" ON "messages";--> statement-breakpoint
DROP POLICY "POL_messages_tenant" ON "messages";--> statement-breakpoint
DROP POLICY "POL_knowledge_sources_platform" ON "knowledge_sources";--> statement-breakpoint
DROP POLICY "POL_knowledge_sources_tenant" ON "knowledge_sources";--> statement-breakpoint
DROP POLICY "POL_knowledge_documents_platform" ON "knowledge_documents";--> statement-breakpoint
DROP POLICY "POL_knowledge_documents_tenant" ON "knowledge_documents";--> statement-breakpoint
DROP POLICY "POL_knowledge_chunks_platform" ON "knowledge_chunks";--> statement-breakpoint
DROP POLICY "POL_knowledge_chunks_tenant" ON "knowledge_chunks";--> statement-breakpoint
DROP POLICY "POL_files_platform" ON "files";--> statement-breakpoint
DROP POLICY "POL_files_tenant" ON "files";--> statement-breakpoint
DROP POLICY "POL_feedback_platform" ON "feedback";--> statement-breakpoint
DROP POLICY "POL_feedback_tenant" ON "feedback";--> statement-breakpoint
DROP POLICY "POL_event_outbox_platform" ON "event_outbox";--> statement-breakpoint
DROP POLICY "POL_event_outbox_tenant" ON "event_outbox";--> statement-breakpoint
DROP POLICY "POL_eval_runs_platform" ON "eval_runs";--> statement-breakpoint
DROP POLICY "POL_eval_runs_tenant" ON "eval_runs";--> statement-breakpoint
DROP POLICY "POL_eval_results_platform" ON "eval_results";--> statement-breakpoint
DROP POLICY "POL_eval_results_tenant" ON "eval_results";--> statement-breakpoint
DROP POLICY "POL_eval_cases_platform" ON "eval_cases";--> statement-breakpoint
DROP POLICY "POL_eval_cases_tenant" ON "eval_cases";--> statement-breakpoint
DROP POLICY "POL_doc_gaps_platform" ON "doc_gaps";--> statement-breakpoint
DROP POLICY "POL_doc_gaps_tenant" ON "doc_gaps";--> statement-breakpoint
DROP POLICY "POL_doc_gap_clusters_platform" ON "doc_gap_clusters";--> statement-breakpoint
DROP POLICY "POL_doc_gap_clusters_tenant" ON "doc_gap_clusters";--> statement-breakpoint
DROP POLICY "POL_conversations_platform" ON "conversations";--> statement-breakpoint
DROP POLICY "POL_conversations_tenant" ON "conversations";--> statement-breakpoint
DROP POLICY "POL_company_secrets_platform" ON "company_secrets";--> statement-breakpoint
DROP POLICY "POL_company_secrets_tenant" ON "company_secrets";--> statement-breakpoint
DROP POLICY "POL_company_encryption_keys_platform" ON "company_encryption_keys";--> statement-breakpoint
DROP POLICY "POL_company_encryption_keys_tenant" ON "company_encryption_keys";--> statement-breakpoint
DROP POLICY "POL_company_connections_platform" ON "company_connections";--> statement-breakpoint
DROP POLICY "POL_company_connections_tenant" ON "company_connections";--> statement-breakpoint
DROP POLICY "POL_chatbots_platform" ON "chatbots";--> statement-breakpoint
DROP POLICY "POL_chatbots_tenant" ON "chatbots";--> statement-breakpoint
DROP POLICY "POL_chatbot_users_platform" ON "chatbot_users";--> statement-breakpoint
DROP POLICY "POL_chatbot_users_tenant" ON "chatbot_users";--> statement-breakpoint
DROP POLICY "POL_chatbot_user_secrets_platform" ON "chatbot_user_secrets";--> statement-breakpoint
DROP POLICY "POL_chatbot_user_secrets_tenant" ON "chatbot_user_secrets";--> statement-breakpoint
DROP POLICY "POL_chatbot_configs_platform" ON "chatbot_configs";--> statement-breakpoint
DROP POLICY "POL_chatbot_configs_tenant" ON "chatbot_configs";--> statement-breakpoint
DROP POLICY "POL_change_requests_platform" ON "change_requests";--> statement-breakpoint
DROP POLICY "POL_change_requests_tenant" ON "change_requests";--> statement-breakpoint
DROP POLICY "POL_admins_platform" ON "admins";--> statement-breakpoint
DROP POLICY "POL_admins_tenant" ON "admins";--> statement-breakpoint
DROP POLICY "POL_activity_rollups_platform" ON "activity_rollups";--> statement-breakpoint
DROP POLICY "POL_activity_rollups_tenant" ON "activity_rollups";--> statement-breakpoint
DROP POLICY "POL_activity_log_platform" ON "activity_log";--> statement-breakpoint
DROP POLICY "POL_activity_log_tenant" ON "activity_log";--> statement-breakpoint
DROP POLICY "POL_companies_platform" ON "companies";--> statement-breakpoint
DROP POLICY "POL_companies_tenant_update" ON "companies";--> statement-breakpoint
DROP POLICY "POL_companies_tenant_select" ON "companies";--> statement-breakpoint
ALTER TABLE "tool_definitions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_definitions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_calls" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_calls" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roi_assumptions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roi_assumptions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quality_issues" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quality_issues" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_calls" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_calls" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_documents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_results" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_results" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_cases" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_cases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gaps" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gaps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gap_clusters" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_gap_clusters" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_secrets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_secrets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_encryption_keys" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_encryption_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_connections" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbots" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_user_secrets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_user_secrets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_configs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chatbot_configs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_requests" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_requests" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admins" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admins" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_rollups" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_rollups" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_log" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_log" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companies" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "users" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "tool_definitions" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "tool_calls" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "roi_assumptions" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "quality_issues" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "model_calls" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "messages" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "knowledge_sources" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "knowledge_documents" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "knowledge_chunks" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "files" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "feedback" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "event_outbox" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "eval_runs" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "eval_results" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "eval_cases" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "doc_gaps" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "doc_gap_clusters" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "conversations" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "company_secrets" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "company_encryption_keys" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "company_connections" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "companies" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "chatbots" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "chatbot_users" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "chatbot_user_secrets" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "chatbot_configs" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "change_requests" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "admins" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "activity_rollups" FROM diletta_app;--> statement-breakpoint
REVOKE ALL ON "activity_log" FROM diletta_app;--> statement-breakpoint
REVOKE USAGE ON SCHEMA public FROM diletta_app;--> statement-breakpoint
DROP ROLE diletta_app;
