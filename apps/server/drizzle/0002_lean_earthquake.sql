ALTER TABLE `threads` ADD `context` text DEFAULT '1m' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `fast` integer DEFAULT false NOT NULL;