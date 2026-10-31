CREATE TABLE "admin_invites" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_invites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"email" text NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"clerk_invitation_id" text,
	"clerk_user_id" text,
	"invited_by" bigint,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_admin_invites_public_id" ON "admin_invites" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_admin_invites_company_id_email_pending" ON "admin_invites" ("company_id","email") WHERE "status" = 1;--> statement-breakpoint
CREATE INDEX "IDX_admin_invites_company_id" ON "admin_invites" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_admin_invites_invited_by" ON "admin_invites" ("invited_by");