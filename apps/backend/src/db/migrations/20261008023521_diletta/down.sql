-- Down for 20261008023521_diletta: recreates the scaffold users table (replaced by admins in M1-8) and its
-- diletta_app grant, so the rls_policies down can still revoke it.
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
CREATE UNIQUE INDEX "UNQ_users_public_id" ON "users" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_users_clerk_id" ON "users" ("clerk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_users_email" ON "users" ("email");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO diletta_app;
