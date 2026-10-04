CREATE TABLE "chatbots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatbots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"name" text NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"name" text NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"is_read_only" boolean DEFAULT false NOT NULL,
	"spending_budget" numeric(12,6),
	"content_retention_days" integer,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbots_public_id" ON "chatbots" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_chatbots_company_id_default" ON "chatbots" ("company_id") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "IDX_chatbots_company_id" ON "chatbots" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_chatbots_created_by" ON "chatbots" ("created_by");--> statement-breakpoint
CREATE INDEX "IDX_chatbots_updated_by" ON "chatbots" ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_companies_public_id" ON "companies" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_companies_updated_by" ON "companies" ("updated_by");