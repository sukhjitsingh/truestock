CREATE TABLE `product_cost_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`product_id` int NOT NULL,
	`source_invoice_id` int NOT NULL,
	`source_invoice_line_id` int NOT NULL,
	`unit_cost` decimal(10,4) NOT NULL,
	`previous_unit_cost` decimal(10,4),
	`effective_at` timestamp NOT NULL DEFAULT (now()),
	`created_by` int NOT NULL,
	CONSTRAINT `product_cost_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_cost_history_source_invoice_line_id_unique` UNIQUE(`source_invoice_line_id`)
);
--> statement-breakpoint
ALTER TABLE `invoice_line` ADD CONSTRAINT `invoice_line_organization_id_id_unique` UNIQUE(`organization_id`,`id`);--> statement-breakpoint
ALTER TABLE `product_cost_history` ADD CONSTRAINT `product_cost_history_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_cost_history` ADD CONSTRAINT `product_cost_history_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_cost_history` ADD CONSTRAINT `product_cost_history_organization_product_fk` FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_cost_history` ADD CONSTRAINT `product_cost_history_organization_invoice_fk` FOREIGN KEY (`organization_id`,`source_invoice_id`) REFERENCES `invoice`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_cost_history` ADD CONSTRAINT `product_cost_history_organization_invoice_line_fk` FOREIGN KEY (`organization_id`,`source_invoice_line_id`) REFERENCES `invoice_line`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `product_cost_history_organization_product_idx` ON `product_cost_history` (`organization_id`,`product_id`);