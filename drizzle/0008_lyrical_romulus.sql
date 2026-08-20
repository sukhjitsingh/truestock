ALTER TABLE `count_line_write` ADD `write_type` enum('scan','fill_correction') DEFAULT 'scan' NOT NULL;--> statement-breakpoint
ALTER TABLE `count_line_write` ADD `partial_fills_before` json;--> statement-breakpoint
ALTER TABLE `count_line_write` ADD `partial_fills_after` json;