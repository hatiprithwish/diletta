-- Custom SQL migration (drizzle-kit generate --custom). Recreates activity_log as a table partitioned by month on
-- created_at; drizzle-kit can't declare partitioning. Columns, primary key and indexes match tables.ts and the
-- snapshot, so later drizzle-kit diffs stay correct. Safe only because the table is still empty (created by the
-- previous migration). Monthly partitions run through 2027-12 (UTC bounds); the DEFAULT partition catches anything
-- later; months must be added ahead of time, since a new partition can't cover rows already in DEFAULT.
-- Indexes on the parent cascade to every partition.
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
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_company_id" ON "activity_log" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_actor_id" ON "activity_log" ("actor_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_entity_id" ON "activity_log" ("entity_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_parent_log_id" ON "activity_log" ("parent_log_id");--> statement-breakpoint
CREATE INDEX "IDX_activity_log_root_log_id" ON "activity_log" ("root_log_id");--> statement-breakpoint
CREATE TABLE "activity_log_y2026m10" PARTITION OF "activity_log" FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2026m11" PARTITION OF "activity_log" FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2026m12" PARTITION OF "activity_log" FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m01" PARTITION OF "activity_log" FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m02" PARTITION OF "activity_log" FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m03" PARTITION OF "activity_log" FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m04" PARTITION OF "activity_log" FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m05" PARTITION OF "activity_log" FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m06" PARTITION OF "activity_log" FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m07" PARTITION OF "activity_log" FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m08" PARTITION OF "activity_log" FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m09" PARTITION OF "activity_log" FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m10" PARTITION OF "activity_log" FOR VALUES FROM ('2027-10-01 00:00:00+00') TO ('2027-11-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m11" PARTITION OF "activity_log" FOR VALUES FROM ('2027-11-01 00:00:00+00') TO ('2027-12-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_y2027m12" PARTITION OF "activity_log" FOR VALUES FROM ('2027-12-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "activity_log_default" PARTITION OF "activity_log" DEFAULT;
