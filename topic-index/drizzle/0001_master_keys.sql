CREATE TABLE `master_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_user_id` text,
	`reason` text,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`before` text,
	`after` text
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_master` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`ord` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
INSERT INTO `__new_master`("kind", "key", "ord", "data") SELECT "kind", CASE "kind" WHEN 'listMembers' THEN json_extract("data", '$.listId') || '|' || COALESCE(json_extract("data", '$.userId'), json_extract("data", '$.contactId')) WHEN 'attributeDefs' THEN json_extract("data", '$.dataSourceId') || '|' || json_extract("data", '$.name') ELSE json_extract("data", '$.id') END, "ord", "data" FROM `master`;--> statement-breakpoint
DROP TABLE `master`;--> statement-breakpoint
ALTER TABLE `__new_master` RENAME TO `master`;--> statement-breakpoint
PRAGMA foreign_keys=ON;