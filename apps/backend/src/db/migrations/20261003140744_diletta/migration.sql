CREATE TABLE "notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_notes_public_id" ON "notes" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_notes_user_id" ON "notes" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_users_public_id" ON "users" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_users_clerk_id" ON "users" ("clerk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_users_email" ON "users" ("email");