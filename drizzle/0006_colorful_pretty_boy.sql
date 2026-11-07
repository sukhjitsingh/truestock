CREATE TABLE `vendor_alias` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`vendor_id` int NOT NULL,
	`vendor_item_code` varchar(64) NOT NULL,
	`product_id` int NOT NULL,
	`match_confidence` decimal(4,3) NOT NULL DEFAULT '0.500',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `vendor_alias_id` PRIMARY KEY(`id`),
	CONSTRAINT `vendor_alias_organization_vendor_item_code_unique` UNIQUE(`organization_id`,`vendor_id`,`vendor_item_code`)
);
--> statement-breakpoint
ALTER TABLE `invoice_line` ADD `matched_vendor_alias_id` int;--> statement-breakpoint
ALTER TABLE `vendor_alias` ADD CONSTRAINT `vendor_alias_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_alias` ADD CONSTRAINT `vendor_alias_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor_alias` ADD CONSTRAINT `vendor_alias_organization_vendor_fk` FOREIGN KEY (`organization_id`,`vendor_id`) REFERENCES `vendor`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vendor_alias_organization_product_idx` ON `vendor_alias` (`organization_id`,`product_id`);--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_matched_vendor_alias_id_vendor_alias_id_fk` FOREIGN KEY (`matched_vendor_alias_id`) REFERENCES `vendor_alias`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `invoice_line_organization_matched_vendor_alias_idx` ON `invoice_line` (`organization_id`,`matched_vendor_alias_id`);