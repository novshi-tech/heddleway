CREATE TABLE `dummy_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`data_source_id` text NOT NULL,
	`message` text NOT NULL,
	`consumed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `master` (
	`kind` text NOT NULL,
	`ord` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`kind`, `ord`)
);
--> statement-breakpoint
CREATE TABLE `projection_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_seq` integer NOT NULL,
	`idx` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`data_source_id` text NOT NULL,
	`thread_id` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`data_source_id` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_data_source_idx` ON `threads` (`data_source_id`);