CREATE TABLE "feedback_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_id" bigint NOT NULL,
	"feedback_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"chatbot_user_id" bigint NOT NULL,
	"rating" smallint NOT NULL,
	"comment_version" integer NOT NULL,
	"summary" text NOT NULL,
	"embedding" halfvec(1024),
	"theme_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_themes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_themes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"company_id" bigint NOT NULL,
	"chatbot_id" bigint NOT NULL,
	"rating" smallint NOT NULL,
	"label" text NOT NULL,
	"centroid" halfvec(1024) NOT NULL,
	"note_count" integer DEFAULT 0 NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "comment_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD COLUMN "feedback_theme_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_feedback_notes_public_id" ON "feedback_notes" ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_feedback_notes_feedback_id" ON "feedback_notes" ("feedback_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_notes_company_id" ON "feedback_notes" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_notes_chatbot_id" ON "feedback_notes" ("chatbot_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_notes_conversation_id" ON "feedback_notes" ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_notes_chatbot_user_id" ON "feedback_notes" ("chatbot_user_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_notes_theme_id" ON "feedback_notes" ("theme_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_feedback_themes_public_id" ON "feedback_themes" ("public_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_themes_company_id" ON "feedback_themes" ("company_id");--> statement-breakpoint
CREATE INDEX "IDX_feedback_themes_chatbot_id" ON "feedback_themes" ("chatbot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UNQ_quality_issues_feedback_theme_id" ON "quality_issues" ("feedback_theme_id");--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "CHK_quality_issues_feedback_theme_id" CHECK ("feedback_theme_id" IS NULL OR ("source" = 3 AND "conversation_id" IS NULL));