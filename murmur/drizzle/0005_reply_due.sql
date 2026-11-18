ALTER TABLE `threads` ADD `reply_due` text;--> statement-breakpoint
CREATE INDEX `threads_reply_due_idx` ON `threads` (`reply_due`);--> statement-breakpoint
-- 0046 の未決 3: 既存の行から期限の見回りの候補を埋める（replyDue と同じ規則。何度流しても同じ）
UPDATE `threads` SET `reply_due` = CASE
  WHEN coalesce(json_extract(`data`, '$.dismissed'), 0) = 0 AND coalesce(json_extract(`data`, '$.closedAtSource'), 0) = 0 AND coalesce(json_extract(`data`, '$.overdue'), 0) = 0 AND json_extract(`data`, '$.replyExpectedSignalId') IS NOT NULL
  THEN json_extract(`data`, '$.replyExpectedBy') ELSE NULL END;
