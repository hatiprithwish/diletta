ALTER TABLE `notes` ADD `public_id` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `UNQ_notes_public_id` ON `notes` (`public_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `public_id` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `UNQ_users_public_id` ON `users` (`public_id`);