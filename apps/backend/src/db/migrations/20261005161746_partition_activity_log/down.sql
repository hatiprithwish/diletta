-- Down for 20261005161746_partition_activity_log: back to the plain table the previous migration created.
DROP TABLE "activity_log";--> statement-breakpoint
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_log_pkey" PRIMARY KEY("id","created_at")
);--> statement-breakpoint
CREATE INDEX "IDX_activity_log_company_id" ON "activity_log" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_actor_id" ON "activity_log" ("actor_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_entity_id" ON "activity_log" ("entity_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_parent_log_id" ON "activity_log" ("parent_log_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_root_log_id" ON "activity_log" ("root_log_id");
