CREATE TABLE `signal_keys` (
	`data_source_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`signal_id` text NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`data_source_id`, `kind`, `value`)
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `source_key` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `last_signal_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `named_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `threads_source_key_idx` ON `threads` (`data_source_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `threads_last_signal_idx` ON `threads` (`data_source_id`,`last_signal_at`);--> statement-breakpoint
CREATE INDEX `threads_named_pending_idx` ON `threads` (`data_source_id`,`named_pending`);--> statement-breakpoint
CREATE INDEX `signals_thread_idx` ON `signals` (`thread_id`);--> statement-breakpoint
-- 0046: 既存の投影の行から、足した列と索引を埋める（投影の JSON から決まる。作り直しと同じ結果）
UPDATE `threads` SET
  `source_key` = json_extract(`data`, '$.sourceKey'),
  `named_pending` = CASE WHEN coalesce(json_array_length(`data`, '$.attention.named'), 0) > 0 THEN 1 ELSE 0 END,
  `last_signal_at` = (SELECT max(json_extract(l.value, '$.at')) FROM json_each(`threads`.`data`, '$.log') AS l WHERE json_extract(l.value, '$.kind') = 'signal');
--> statement-breakpoint
INSERT INTO `signal_keys` (`data_source_id`, `kind`, `value`, `signal_id`, `seq`)
  SELECT `data_source_id`, 'sourceRef', json_extract(`data`, '$.sourceRef'), `id`, json_extract(`data`, '$.seq') FROM `signals`
  WHERE json_extract(`data`, '$.sourceRef') IS NOT NULL ORDER BY json_extract(`data`, '$.seq')
  ON CONFLICT (`data_source_id`, `kind`, `value`) DO UPDATE SET `signal_id` = excluded.`signal_id`, `seq` = excluded.`seq` WHERE excluded.`seq` > `signal_keys`.`seq`;
--> statement-breakpoint
INSERT INTO `signal_keys` (`data_source_id`, `kind`, `value`, `signal_id`, `seq`)
  SELECT `data_source_id`, 'messageId', json_extract(`data`, '$.anchors.messageId'), `id`, json_extract(`data`, '$.seq') FROM `signals`
  WHERE json_extract(`data`, '$.anchors.messageId') IS NOT NULL ORDER BY json_extract(`data`, '$.seq')
  ON CONFLICT (`data_source_id`, `kind`, `value`) DO UPDATE SET `signal_id` = excluded.`signal_id`, `seq` = excluded.`seq` WHERE excluded.`seq` > `signal_keys`.`seq`;
--> statement-breakpoint
INSERT INTO `signal_keys` (`data_source_id`, `kind`, `value`, `signal_id`, `seq`)
  SELECT `data_source_id`, 'threadKey', json_extract(`data`, '$.anchors.threadKey'), `id`, json_extract(`data`, '$.seq') FROM `signals`
  WHERE json_extract(`data`, '$.anchors.threadKey') IS NOT NULL ORDER BY json_extract(`data`, '$.seq')
  ON CONFLICT (`data_source_id`, `kind`, `value`) DO UPDATE SET `signal_id` = excluded.`signal_id`, `seq` = excluded.`seq` WHERE excluded.`seq` > `signal_keys`.`seq`;
--> statement-breakpoint
INSERT INTO `signal_keys` (`data_source_id`, `kind`, `value`, `signal_id`, `seq`)
  SELECT `data_source_id`, 'threadTs', json_extract(`data`, '$.anchors.threadTs'), `id`, json_extract(`data`, '$.seq') FROM `signals`
  WHERE json_extract(`data`, '$.anchors.threadTs') IS NOT NULL ORDER BY json_extract(`data`, '$.seq')
  ON CONFLICT (`data_source_id`, `kind`, `value`) DO UPDATE SET `signal_id` = excluded.`signal_id`, `seq` = excluded.`seq` WHERE excluded.`seq` > `signal_keys`.`seq`;
