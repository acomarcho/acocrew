CREATE TABLE `seen` (
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `thread_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Threads from before this table start out as seen by everyone, so nothing old asks to be looked at.
INSERT INTO `seen` (`user_id`, `thread_id`, `at`) SELECT `user`.`id`, `threads`.`id`, `threads`.`updated_at` FROM `user`, `threads`;
--> statement-breakpoint
-- 'needs' used to cover a failed turn too. A thread that waited for an answer when the server stopped can no longer get one, so both are 'failed' now.
UPDATE `threads` SET `status` = 'failed' WHERE `status` = 'needs';
