CREATE TABLE `thread_keys` (
	`thread_id` text NOT NULL,
	`key` text NOT NULL,
	`data_source_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `thread_keys_key_idx` ON `thread_keys` (`key`);--> statement-breakpoint
ALTER TABLE `threads` ADD `is_open` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `threads_open_idx` ON `threads` (`data_source_id`,`is_open`);--> statement-breakpoint
-- 0047: 既存の行から、開いているかの列とキーの索引を埋める（crossKeysOfSignals と同じ規則）。
-- キーの索引は結び候補そのものなので、消してから入れ直す（何度流しても同じ結果。余分な行を残さない）
UPDATE `threads` SET `is_open` = CASE WHEN coalesce(json_extract(`data`, '$.dismissed'), 0) = 0 AND coalesce(json_extract(`data`, '$.closedAtSource'), 0) = 0 THEN 1 ELSE 0 END;
--> statement-breakpoint
DELETE FROM `thread_keys`;
--> statement-breakpoint
INSERT OR IGNORE INTO `thread_keys` (`thread_id`, `key`, `data_source_id`)
  SELECT `thread_id`, json_extract(`data`, '$.anchors.threadKey'), `data_source_id` FROM `signals` WHERE `thread_id` IS NOT NULL AND json_extract(`data`, '$.anchors.threadKey') IS NOT NULL
  UNION ALL SELECT `thread_id`, 'msg:' || json_extract(`data`, '$.anchors.messageId'), `data_source_id` FROM `signals` WHERE `thread_id` IS NOT NULL AND json_extract(`data`, '$.anchors.messageId') IS NOT NULL
  UNION ALL SELECT s.`thread_id`, j.value, s.`data_source_id` FROM `signals` AS s, json_each(s.`data`, '$.anchors.jiraKeys') AS j WHERE s.`thread_id` IS NOT NULL
  UNION ALL SELECT s.`thread_id`, j.value, s.`data_source_id` FROM `signals` AS s, json_each(s.`data`, '$.anchors.prRefs') AS j WHERE s.`thread_id` IS NOT NULL;
