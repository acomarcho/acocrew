CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`text` text NOT NULL,
	`time` text NOT NULL,
	`days` text NOT NULL,
	`from_branch` text NOT NULL,
	`is_on` integer DEFAULT true NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`context` text NOT NULL,
	`fast` integer NOT NULL,
	`access` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `automation_id` text REFERENCES automations(id) ON DELETE set null;