CREATE TABLE `shares` (
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `user_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `automations` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `visibility` text DEFAULT 'private' NOT NULL;