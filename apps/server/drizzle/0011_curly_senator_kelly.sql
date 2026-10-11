CREATE TABLE `chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`tagged` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chats_thread` ON `chats` (`thread_id`,`id`);--> statement-breakpoint
ALTER TABLE `seen` ADD `chat` integer DEFAULT 0 NOT NULL;