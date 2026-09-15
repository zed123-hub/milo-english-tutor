CREATE TABLE `tutor_events` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text,
	`kind` text NOT NULL,
	`source_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_tutor_events_user_session` ON `tutor_events` (`user_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `tutor_students` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL
);
