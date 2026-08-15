CREATE TABLE `invoice_line` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`invoice_id` int NOT NULL,
	`line_number` int NOT NULL,
	`raw_text` text,
	`line_type` enum('product','deposit','deposit_return','freight','tax','fee','discount','unknown') NOT NULL DEFAULT 'unknown',
	`vendor_item_code` varchar(64),
	`description` varchar(512),
	`pack_description` varchar(64),
	`quantity` decimal(12,3),
	`uom` enum('each','case','keg','other'),
	`pack_size` int,
	`unit_cost` decimal(10,4),
	`extended_cost` decimal(12,2),
	`raw_gross` decimal(12,2),
	`raw_discount` decimal(12,2),
	`raw_net` decimal(12,2),
	`exception_flags` json,
	`matched_product_id` int,
	`match_method` enum('vendor_alias_code','vendor_alias_desc','barcode','fuzzy','manual','created_draft','unmatched') NOT NULL DEFAULT 'unmatched',
	`match_confidence` decimal(4,3),
	`extraction_confidence` decimal(4,3),
	`reviewed_by` int,
	`reviewed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoice_line_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_line_invoice_lineno_unique` UNIQUE(`invoice_id`,`line_number`)
);
--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `provider` varchar(32);--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `model_id` varchar(64);--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `prompt_version` varchar(32);--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `raw_response` json;--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `input_tokens` int;--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `output_tokens` int;--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `cost_usd` decimal(10,6);--> statement-breakpoint
ALTER TABLE `extraction_job` ADD `error_code` varchar(64);--> statement-breakpoint
ALTER TABLE `invoice` ADD `rejection_reason` text;--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_invoice_id_invoice_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_matched_product_id_product_id_fk` FOREIGN KEY (`matched_product_id`) REFERENCES `product`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_reviewed_by_user_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_organization_invoice_fk` FOREIGN KEY (`organization_id`,`invoice_id`) REFERENCES `invoice`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `invoice_line_organization_matched_product_idx` ON `invoice_line` (`organization_id`,`matched_product_id`);--> statement-breakpoint
CREATE INDEX `invoice_line_organization_vendor_item_code_idx` ON `invoice_line` (`organization_id`,`vendor_item_code`);