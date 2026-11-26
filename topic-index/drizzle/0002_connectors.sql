CREATE TABLE `connector_sources` (
	`data_source_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_grants` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`data_source_id` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_subscriptions_data_source_idx` ON `graph_subscriptions` (`data_source_id`);--> statement-breakpoint
CREATE TABLE `oauth_pending` (
	`state` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`data` text NOT NULL
);
