-- Down for 20261107030410_diletta: drops the feedback themes tables (M7-10), feedback.comment_version and quality_issues.feedback_theme_id
ALTER TABLE "quality_issues" DROP CONSTRAINT IF EXISTS "CHK_quality_issues_feedback_theme_id";--> statement-breakpoint
DROP INDEX IF EXISTS "UNQ_quality_issues_feedback_theme_id";--> statement-breakpoint
ALTER TABLE "quality_issues" DROP COLUMN IF EXISTS "feedback_theme_id";--> statement-breakpoint
ALTER TABLE "feedback" DROP COLUMN IF EXISTS "comment_version";--> statement-breakpoint
DROP TABLE IF EXISTS "feedback_notes";--> statement-breakpoint
DROP TABLE IF EXISTS "feedback_themes";
