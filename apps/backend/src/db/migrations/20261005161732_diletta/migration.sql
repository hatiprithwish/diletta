CREATE TABLE "activity_log" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "activity_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"actor_type" smallint NOT NULL,
	"actor_id" bigint,
	"entity_type" text NOT NULL,
	"entity_id" bigint,
	"entity_action" text NOT NULL,
	"entity_version" integer,
	"parent_log_id" bigint,
	"root_log_id" bigint,
	"detail" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "activity_log_pkey" PRIMARY KEY("id","created_at")
);
--> statement-breakpoint
CREATE TABLE "activity_rollups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_rollups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"chatbot_id" bigint,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" numeric NOT NULL,
	CONSTRAINT "UNQ_activity_rollups_company_id_chatbot_id_day_metric" UNIQUE NULLS NOT DISTINCT("company_id","chatbot_id","day","metric")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"clerk_user_id" text NOT NULL,
	"company_id" bigint,
	"email" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"tool_call_id" bigint NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"encrypted_changes" bytea,
	"iv" bytea,
	"encryption_key_version" integer,
	"summary" text NOT NULL,
	"change_count" integer NOT NULL,
	"was_edited" boolean DEFAULT false NOT NULL,
	"think_execution_id" text,
	"idempotency_key" text,
	"host_ref" text,
	"undo_until" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_configs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatbot_configs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_id" bigint NOT NULL,
	"config_version" integer NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"body" jsonb NOT NULL,
	"body_hash" text NOT NULL,
	"approved_by_run_id" bigint,
	"created_by" bigint,
	"updated_by" bigint,
	"published_by" bigint,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_user_secrets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatbot_user_secrets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_user_id" bigint NOT NULL,
	"connection_id" bigint NOT NULL,
	"type" text NOT NULL,
	"encrypted_secret" bytea NOT NULL,
	"iv" bytea NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"scopes" text[],
	"expires_at" timestamp with time zone,
	"status" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatbot_users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"host_user_id" text NOT NULL,
	"display_name" text,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_connections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_connections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"environment" smallint NOT NULL,
	"adapter_type" smallint DEFAULT 1 NOT NULL,
	"base_url" text,
	"auth_type" text NOT NULL,
	"auth_config" jsonb NOT NULL,
	"credential_scope" smallint NOT NULL,
	"jwt_issuer" text NOT NULL,
	"allowed_origins" text[] NOT NULL,
	"reset_op" jsonb,
	"status" smallint DEFAULT 1 NOT NULL,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_company_connections_base_url" CHECK ("base_url" IS NOT NULL OR "adapter_type" = 2)
);
--> statement-breakpoint
CREATE TABLE "company_encryption_keys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_encryption_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"encrypted_key" bytea,
	"master_key_version" integer NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"destroyed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_secrets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_secrets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"type" smallint NOT NULL,
	"provider" text,
	"connection_id" bigint,
	"encrypted_secret" bytea NOT NULL,
	"iv" bytea NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"last_four_chars" text NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_company_secrets_model_key_provider" CHECK (("type" = 1) = ("provider" IS NOT NULL)),
	CONSTRAINT "CHK_company_secrets_connection_id" CHECK (("type" <> 1) = ("connection_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_user_id" bigint NOT NULL,
	"chatbot_id" bigint NOT NULL,
	"chatbot_config_id" bigint,
	"status" smallint DEFAULT 1 NOT NULL,
	"outcome" smallint,
	"title" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"root_log_id" bigint,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_gap_clusters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "doc_gap_clusters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"label" text NOT NULL,
	"centroid" halfvec(1024) NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"answered_by_document_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_gaps" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "doc_gaps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"conversation_id" bigint,
	"message_id" bigint,
	"question_generic" text NOT NULL,
	"signal" smallint NOT NULL,
	"embedding" halfvec(1024),
	"cluster_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eval_cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint,
	"chatbot_id" bigint,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"expectations" jsonb NOT NULL,
	"is_safety" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_eval_cases_platform_chatbot_id" CHECK (("company_id" IS NULL) = ("chatbot_id" IS NULL)),
	CONSTRAINT "CHK_eval_cases_platform_safety_active" CHECK ("company_id" IS NOT NULL OR NOT "is_safety" OR "is_active")
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eval_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"eval_run_id" bigint NOT NULL,
	"eval_case_id" bigint NOT NULL,
	"attempt" smallint NOT NULL,
	"has_passed" boolean NOT NULL,
	"grader_output" jsonb,
	"transcript_file_id" bigint,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eval_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_config_id" bigint NOT NULL,
	"trigger" smallint NOT NULL,
	"harness_version" text NOT NULL,
	"k" smallint NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"case_count" integer,
	"pass_all_k_count" integer,
	"has_passed" boolean,
	"cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"activity_log_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"chatbot_user_id" bigint NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"filename" text,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "knowledge_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"knowledge_document_id" bigint NOT NULL,
	"knowledge_source_id" bigint NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading_path" text,
	"text" text NOT NULL,
	"embedding" halfvec(1024),
	"embedding_model" text,
	"tsv" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("heading_path", '')), 'A') || setweight(to_tsvector('english', "text"), 'B')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "knowledge_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"knowledge_source_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"title" text,
	"source_url" text,
	"content_hash" text,
	"index_status" smallint DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "knowledge_sources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"type" smallint NOT NULL,
	"url" text,
	"sync_frequency" smallint,
	"status" smallint DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_knowledge_sources_web_url" CHECK (("type" IN (1, 2)) = ("url" IS NOT NULL)),
	CONSTRAINT "CHK_knowledge_sources_web_sync_frequency" CHECK (("type" IN (1, 2)) = ("sync_frequency" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"session_message_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"role" smallint NOT NULL,
	"content" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_id" bigint,
	"chatbot_user_id" bigint,
	"conversation_id" bigint,
	"eval_run_id" bigint,
	"turn_id" text,
	"task_type" text NOT NULL,
	"tier" smallint NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"gateway_log_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"was_escalated" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_issues" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quality_issues_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"change_request_id" bigint,
	"feedback_id" bigint,
	"source" smallint NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"issue_type" smallint,
	"note" text,
	"eval_case_id" bigint,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_quality_issues_user_feedback_id" CHECK (("source" = 1) = ("feedback_id" IS NOT NULL)),
	CONSTRAINT "CHK_quality_issues_admin_created_by" CHECK (("source" = 2) = ("created_by" IS NOT NULL)),
	CONSTRAINT "CHK_quality_issues_converted_eval_case_id" CHECK (("status" = 3) = ("eval_case_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "roi_assumptions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roi_assumptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"task_type" text NOT NULL,
	"manual_minutes" numeric NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"message_id" bigint,
	"turn_id" text NOT NULL,
	"tool_id" bigint NOT NULL,
	"tool_version" integer NOT NULL,
	"encrypted_args" bytea,
	"iv" bytea,
	"encryption_key_version" integer,
	"has_untrusted_context" boolean DEFAULT false NOT NULL,
	"status" smallint NOT NULL,
	"error_code" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_definitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"connection_id" bigint NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"risk" smallint NOT NULL,
	"input_schema" jsonb NOT NULL,
	"call_op" jsonb NOT NULL,
	"readback_op" jsonb,
	"inverse_op" jsonb,
	"idempotency_mode" smallint NOT NULL,
	"approval" smallint NOT NULL,
	"source" smallint NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CHK_tool_definitions_readback_op" CHECK (("risk" = 1) = ("readback_op" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "IDX_activity_log_company_id" ON "activity_log" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_actor_id" ON "activity_log" ("actor_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_entity_id" ON "activity_log" ("entity_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_parent_log_id" ON "activity_log" ("parent_log_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_root_log_id" ON "activity_log" ("root_log_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_rollups_chatbot_id" ON "activity_rollups" ("chatbot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_admins_clerk_user_id" ON "admins" ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "IDX_admins_company_id" ON "admins" ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_change_requests_public_id" ON "change_requests" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_change_requests_tool_call_id" ON "change_requests" ("tool_call_id");--> statement-breakpoint
CREATE INDEX "IDX_change_requests_company_id" ON "change_requests" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_change_requests_conversation_id" ON "change_requests" ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_change_requests_undo_until_unpurged" ON "change_requests" ("undo_until") WHERE "encrypted_changes" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_configs_public_id" ON "chatbot_configs" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_configs_chatbot_id_config_version" ON "chatbot_configs" ("chatbot_id","config_version");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_configs_chatbot_id_published" ON "chatbot_configs" ("chatbot_id") WHERE "status" = 4;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_configs_approved_by_run_id" ON "chatbot_configs" ("approved_by_run_id");--> statement-breakpoint
CREATE INDEX "IDX_chatbot_configs_company_id" ON "chatbot_configs" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_chatbot_configs_created_by" ON "chatbot_configs" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_chatbot_configs_updated_by" ON "chatbot_configs" ("updated_by");--> statement-breakpoint
CREATE INDEX "IDX_chatbot_configs_published_by" ON "chatbot_configs" ("published_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_user_secrets_public_id" ON "chatbot_user_secrets" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_user_secrets_chatbot_user_id_connection_id" ON "chatbot_user_secrets" ("chatbot_user_id","connection_id");--> statement-breakpoint
CREATE INDEX "IDX_chatbot_user_secrets_company_id" ON "chatbot_user_secrets" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_chatbot_user_secrets_connection_id" ON "chatbot_user_secrets" ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbot_users_company_id_host_user_id" ON "chatbot_users" ("company_id","host_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_connections_public_id" ON "company_connections" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_connections_jwt_issuer" ON "company_connections" ("jwt_issuer");--> statement-breakpoint
CREATE INDEX "IDX_company_connections_company_id" ON "company_connections" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_company_connections_created_by" ON "company_connections" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_company_connections_updated_by" ON "company_connections" ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_encryption_keys_public_id" ON "company_encryption_keys" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_encryption_keys_company_id_version" ON "company_encryption_keys" ("company_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_encryption_keys_company_id_active" ON "company_encryption_keys" ("company_id") WHERE "status" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_secrets_public_id" ON "company_secrets" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_secrets_company_id_provider_active" ON "company_secrets" ("company_id","provider") WHERE "type" = 1 AND "status" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_company_secrets_company_id_connection_id_type_active" ON "company_secrets" ("company_id","connection_id","type") WHERE "type" <> 1 AND "status" = 1;--> statement-breakpoint
CREATE INDEX "IDX_company_secrets_company_id" ON "company_secrets" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_company_secrets_connection_id" ON "company_secrets" ("connection_id");--> statement-breakpoint
CREATE INDEX "IDX_company_secrets_created_by" ON "company_secrets" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_company_secrets_updated_by" ON "company_secrets" ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_conversations_public_id" ON "conversations" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_conversations_root_log_id" ON "conversations" ("root_log_id");--> statement-breakpoint
CREATE INDEX "IDX_conversations_company_id" ON "conversations" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_conversations_chatbot_user_id" ON "conversations" ("chatbot_user_id");--> statement-breakpoint
CREATE INDEX "IDX_conversations_chatbot_id" ON "conversations" ("chatbot_id");--> statement-breakpoint
CREATE INDEX "IDX_conversations_chatbot_config_id" ON "conversations" ("chatbot_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_doc_gap_clusters_public_id" ON "doc_gap_clusters" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_doc_gap_clusters_company_id" ON "doc_gap_clusters" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_doc_gap_clusters_answered_by_document_id" ON "doc_gap_clusters" ("answered_by_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_doc_gaps_public_id" ON "doc_gaps" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_doc_gaps_message_id" ON "doc_gaps" ("message_id");--> statement-breakpoint
CREATE INDEX "IDX_doc_gaps_company_id" ON "doc_gaps" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_doc_gaps_conversation_id" ON "doc_gaps" ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_doc_gaps_cluster_id" ON "doc_gaps" ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_eval_cases_public_id" ON "eval_cases" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_eval_cases_company_id" ON "eval_cases" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_eval_cases_chatbot_id" ON "eval_cases" ("chatbot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_eval_results_eval_run_id_eval_case_id_attempt" ON "eval_results" ("eval_run_id","eval_case_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_eval_results_transcript_file_id" ON "eval_results" ("transcript_file_id");--> statement-breakpoint
CREATE INDEX "IDX_eval_results_company_id" ON "eval_results" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_eval_results_eval_case_id" ON "eval_results" ("eval_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_eval_runs_public_id" ON "eval_runs" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_eval_runs_company_id" ON "eval_runs" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_eval_runs_chatbot_config_id" ON "eval_runs" ("chatbot_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_event_outbox_company_id_dedupe_key" ON "event_outbox" ("company_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_event_outbox_activity_log_id" ON "event_outbox" ("activity_log_id");--> statement-breakpoint
CREATE INDEX "IDX_event_outbox_pending_created_at" ON "event_outbox" ("created_at") WHERE "status" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_feedback_public_id" ON "feedback" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_company_id" ON "feedback" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_message_id" ON "feedback" ("message_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_chatbot_user_id" ON "feedback" ("chatbot_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_files_public_id" ON "files" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_files_company_id" ON "files" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_files_owner_id_owner_type" ON "files" ("owner_id","owner_type");--> statement-breakpoint
CREATE INDEX "IDX_files_created_by" ON "files" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_chunks_company_id" ON "knowledge_chunks" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_chunks_knowledge_document_id" ON "knowledge_chunks" ("knowledge_document_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_chunks_knowledge_source_id" ON "knowledge_chunks" ("knowledge_source_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_chunks_embedding" ON "knowledge_chunks" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "IDX_knowledge_chunks_tsv" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_knowledge_documents_public_id" ON "knowledge_documents" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_knowledge_documents_file_id" ON "knowledge_documents" ("file_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_documents_company_id" ON "knowledge_documents" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_documents_knowledge_source_id" ON "knowledge_documents" ("knowledge_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_knowledge_sources_public_id" ON "knowledge_sources" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_sources_company_id" ON "knowledge_sources" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_sources_created_by" ON "knowledge_sources" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_knowledge_sources_updated_by" ON "knowledge_sources" ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_messages_public_id" ON "messages" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_messages_company_id" ON "messages" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_messages_conversation_id" ON "messages" ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_model_calls_public_id" ON "model_calls" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_company_id" ON "model_calls" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_chatbot_id" ON "model_calls" ("chatbot_id");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_chatbot_user_id" ON "model_calls" ("chatbot_user_id");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_conversation_id" ON "model_calls" ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_model_calls_eval_run_id" ON "model_calls" ("eval_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_quality_issues_public_id" ON "quality_issues" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_quality_issues_feedback_id" ON "quality_issues" ("feedback_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_quality_issues_eval_case_id" ON "quality_issues" ("eval_case_id");--> statement-breakpoint
CREATE INDEX "IDX_quality_issues_company_id" ON "quality_issues" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_quality_issues_conversation_id" ON "quality_issues" ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_quality_issues_change_request_id" ON "quality_issues" ("change_request_id");--> statement-breakpoint
CREATE INDEX "IDX_quality_issues_created_by" ON "quality_issues" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_quality_issues_updated_by" ON "quality_issues" ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_roi_assumptions_public_id" ON "roi_assumptions" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_roi_assumptions_company_id" ON "roi_assumptions" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_roi_assumptions_created_by" ON "roi_assumptions" ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_tool_calls_public_id" ON "tool_calls" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_tool_calls_company_id" ON "tool_calls" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_tool_calls_conversation_id" ON "tool_calls" ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_tool_calls_message_id" ON "tool_calls" ("message_id");--> statement-breakpoint
CREATE INDEX "IDX_tool_calls_tool_id" ON "tool_calls" ("tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_tool_definitions_public_id" ON "tool_definitions" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_tool_definitions_company_id_name_version" ON "tool_definitions" ("company_id","name","version");--> statement-breakpoint
CREATE INDEX "IDX_tool_definitions_connection_id" ON "tool_definitions" ("connection_id");--> statement-breakpoint
CREATE INDEX "IDX_tool_definitions_created_by" ON "tool_definitions" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_tool_definitions_updated_by" ON "tool_definitions" ("updated_by");