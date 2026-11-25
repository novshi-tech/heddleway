-- 0039: 個人のメモ（データソースの kind = notes）と本人が付ける属性をなくす。スキーマは変えず、データだけ消す。
-- 消すもの: 個人のメモのデータソース・そのリスト・読者、属性の定義、個人のメモのシグナルとスレッドに関わるイベント、属性のイベント。
-- 投影は作り直す（fold は 0039 より前の投影を古い形とみなす。ここでも消しておく）
CREATE TABLE `_drop_notes_ds` (`id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO `_drop_notes_ds` SELECT json_extract(`data`, '$.id') FROM `master` WHERE `kind` = 'dataSources' AND json_extract(`data`, '$.kind') = 'notes';
--> statement-breakpoint
CREATE TABLE `_drop_notes_signals` (`id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `_drop_notes_signals` SELECT json_extract(`payload`, '$.signalId') FROM `events` WHERE `type` = 'SignalObserved' AND (json_extract(`payload`, '$.channel') = 'note' OR json_extract(`payload`, '$.dataSourceId') IN (SELECT `id` FROM `_drop_notes_ds`));
--> statement-breakpoint
CREATE TABLE `_drop_notes_threads` (`id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `_drop_notes_threads` SELECT json_extract(`payload`, '$.thread.threadId') FROM `events` WHERE `type` = 'SignalThreaded' AND json_extract(`payload`, '$.signalId') IN (SELECT `id` FROM `_drop_notes_signals`);
--> statement-breakpoint
DELETE FROM `events` WHERE `type` = 'ThreadAttributeSet';
--> statement-breakpoint
DELETE FROM `events` WHERE `type` IN ('SignalObserved', 'SignalThreaded') AND json_extract(`payload`, '$.signalId') IN (SELECT `id` FROM `_drop_notes_signals`);
--> statement-breakpoint
DELETE FROM `events` WHERE `type` = 'ThreadLinked' AND (json_extract(`payload`, '$.a') IN (SELECT `id` FROM `_drop_notes_threads`) OR json_extract(`payload`, '$.b') IN (SELECT `id` FROM `_drop_notes_threads`));
--> statement-breakpoint
DELETE FROM `events` WHERE `type` IN ('ThreadDismissed', 'ThreadReopened', 'ThreadClaimed', 'AttentionAcknowledged', 'ReplyOverdue', 'ThreadMirrored') AND json_extract(`payload`, '$.threadId') IN (SELECT `id` FROM `_drop_notes_threads`);
--> statement-breakpoint
UPDATE `events` SET `payload` = json_set(`payload`, '$.sourceThreadId', json('null')) WHERE `type` = 'OutboundRecorded' AND json_extract(`payload`, '$.sourceThreadId') IN (SELECT `id` FROM `_drop_notes_threads`);
--> statement-breakpoint
DELETE FROM `master` WHERE `kind` = 'listMembers' AND json_extract(`data`, '$.listId') IN (SELECT json_extract(`data`, '$.id') FROM `master` WHERE `kind` = 'lists' AND json_extract(`data`, '$.dataSourceId') IN (SELECT `id` FROM `_drop_notes_ds`));
--> statement-breakpoint
DELETE FROM `master` WHERE `kind` = 'lists' AND json_extract(`data`, '$.dataSourceId') IN (SELECT `id` FROM `_drop_notes_ds`);
--> statement-breakpoint
DELETE FROM `master` WHERE `kind` = 'dataSources' AND `key` IN (SELECT `id` FROM `_drop_notes_ds`);
--> statement-breakpoint
DELETE FROM `master` WHERE `kind` = 'attributeDefs';
--> statement-breakpoint
DELETE FROM `threads`;
--> statement-breakpoint
DELETE FROM `signals`;
--> statement-breakpoint
DELETE FROM `projection_meta`;
--> statement-breakpoint
DROP TABLE `_drop_notes_threads`;
--> statement-breakpoint
DROP TABLE `_drop_notes_signals`;
--> statement-breakpoint
DROP TABLE `_drop_notes_ds`;
