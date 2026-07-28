CREATE TABLE `account` (
	`id` int AUTO_INCREMENT NOT NULL,
	`account_id` varchar(255) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`user_id` int NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` datetime,
	`refresh_token_expires_at` datetime,
	`scope` text,
	`password` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `count` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`type` enum('full','spot','monthly_close') NOT NULL,
	`status` enum('draft','in_progress','submitted','reviewed','closed') NOT NULL DEFAULT 'draft',
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`closed_at` timestamp,
	`opened_by` int NOT NULL,
	`closed_by` int,
	`total_value` decimal(12,2),
	`notes` text,
	CONSTRAINT `count_id` PRIMARY KEY(`id`),
	CONSTRAINT `count_organization_id_id_unique` UNIQUE(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `count_line` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`count_id` int NOT NULL,
	`product_id` int NOT NULL,
	`location_id` int NOT NULL,
	`sealed_case_qty` int NOT NULL DEFAULT 0,
	`sealed_each_qty` int NOT NULL DEFAULT 0,
	`partial_fills` json NOT NULL DEFAULT ('[]'),
	`unit_cost_at_count` decimal(10,4),
	`case_size_at_count` int,
	`counted_by` int NOT NULL,
	`counted_at` timestamp NOT NULL DEFAULT (now()),
	`opened_at` date,
	CONSTRAINT `count_line_id` PRIMARY KEY(`id`),
	CONSTRAINT `count_line_count_product_location_unique` UNIQUE(`count_id`,`product_id`,`location_id`),
	CONSTRAINT `count_line_organization_id_id_unique` UNIQUE(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `count_line_write` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`count_line_id` int NOT NULL,
	`count_id` int NOT NULL,
	`written_by` int NOT NULL,
	`applied_at` timestamp NOT NULL DEFAULT (now()),
	`sealed_case_delta` int NOT NULL DEFAULT 0,
	`sealed_each_delta` int NOT NULL DEFAULT 0,
	`partial_fills_delta` json NOT NULL DEFAULT ('[]'),
	`client_line_id` varchar(36) NOT NULL,
	CONSTRAINT `count_line_write_id` PRIMARY KEY(`id`),
	CONSTRAINT `count_line_write_client_line_id_unique` UNIQUE(`client_line_id`)
);
--> statement-breakpoint
CREATE TABLE `location` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`count_mode` enum('tenths','quantity') NOT NULL DEFAULT 'tenths',
	`notes` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `location_id` PRIMARY KEY(`id`),
	CONSTRAINT `location_organization_name_unique` UNIQUE(`organization_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organization_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `product` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`brand` varchar(255),
	`category` varchar(100) NOT NULL,
	`subcategory` varchar(100),
	`unit_type` enum('bottle','can','keg') NOT NULL,
	`size_ml` int NOT NULL,
	`case_size` int,
	`vendor_id` int,
	`current_unit_cost` decimal(10,4),
	`empty_weight_g` decimal(8,2),
	`full_weight_g` decimal(8,2),
	`waste_factor` decimal(4,3) NOT NULL DEFAULT '0.000',
	`shelf_life_days` int,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_organization_name_size_ml_unique` UNIQUE(`organization_id`,`name`,`size_ml`)
);
--> statement-breakpoint
CREATE TABLE `product_barcode` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`product_id` int NOT NULL,
	`barcode` varchar(64) NOT NULL,
	`format` varchar(20),
	`pack_level` enum('each','case') NOT NULL,
	`is_primary` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `product_barcode_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_barcode_organization_barcode_unique` UNIQUE(`organization_id`,`barcode`)
);
--> statement-breakpoint
CREATE TABLE `product_par` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`product_id` int NOT NULL,
	`location_id` int,
	`par_level` decimal(10,2) NOT NULL,
	`reorder_point` decimal(10,2),
	`location_scope` int GENERATED ALWAYS AS (ifnull(`product_par`.`location_id`, 0)) STORED,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_par_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_par_product_location_scope_unique` UNIQUE(`product_id`,`location_scope`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` int AUTO_INCREMENT NOT NULL,
	`expires_at` datetime NOT NULL,
	`token` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`ip_address` varchar(45),
	`user_agent` text,
	`user_id` int NOT NULL,
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` varchar(2048),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`role` enum('owner','manager','staff') NOT NULL DEFAULT 'staff',
	`active` boolean NOT NULL DEFAULT true,
	`organization_id` int NOT NULL,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `vendor` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`contact` varchar(255),
	`order_method` varchar(255),
	`lead_time_days` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `vendor_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` int AUTO_INCREMENT NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`expires_at` datetime NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `account` ADD CONSTRAINT `account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count` ADD CONSTRAINT `count_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count` ADD CONSTRAINT `count_opened_by_user_id_fk` FOREIGN KEY (`opened_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count` ADD CONSTRAINT `count_closed_by_user_id_fk` FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line` ADD CONSTRAINT `count_line_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line` ADD CONSTRAINT `count_line_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line` ADD CONSTRAINT `count_line_location_id_location_id_fk` FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line` ADD CONSTRAINT `count_line_counted_by_user_id_fk` FOREIGN KEY (`counted_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line` ADD CONSTRAINT `count_line_organization_count_fk` FOREIGN KEY (`organization_id`,`count_id`) REFERENCES `count`(`organization_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line_write` ADD CONSTRAINT `count_line_write_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line_write` ADD CONSTRAINT `count_line_write_count_id_count_id_fk` FOREIGN KEY (`count_id`) REFERENCES `count`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line_write` ADD CONSTRAINT `count_line_write_written_by_user_id_fk` FOREIGN KEY (`written_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `count_line_write` ADD CONSTRAINT `count_line_write_organization_line_fk` FOREIGN KEY (`organization_id`,`count_line_id`) REFERENCES `count_line`(`organization_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `location` ADD CONSTRAINT `location_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product` ADD CONSTRAINT `product_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product` ADD CONSTRAINT `product_vendor_id_vendor_id_fk` FOREIGN KEY (`vendor_id`) REFERENCES `vendor`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_barcode` ADD CONSTRAINT `product_barcode_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_barcode` ADD CONSTRAINT `product_barcode_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_par` ADD CONSTRAINT `product_par_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_par` ADD CONSTRAINT `product_par_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_par` ADD CONSTRAINT `product_par_location_id_location_id_fk` FOREIGN KEY (`location_id`) REFERENCES `location`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user` ADD CONSTRAINT `user_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vendor` ADD CONSTRAINT `vendor_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `count_status_idx` ON `count` (`status`);--> statement-breakpoint
CREATE INDEX `count_opened_by_idx` ON `count` (`opened_by`);--> statement-breakpoint
CREATE INDEX `count_closed_by_idx` ON `count` (`closed_by`);--> statement-breakpoint
CREATE INDEX `count_organization_started_at_idx` ON `count` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `count_line_product_id_idx` ON `count_line` (`product_id`);--> statement-breakpoint
CREATE INDEX `count_line_location_id_idx` ON `count_line` (`location_id`);--> statement-breakpoint
CREATE INDEX `count_line_counted_by_idx` ON `count_line` (`counted_by`);--> statement-breakpoint
CREATE INDEX `count_line_write_count_line_id_idx` ON `count_line_write` (`count_line_id`);--> statement-breakpoint
CREATE INDEX `count_line_write_count_id_idx` ON `count_line_write` (`count_id`);--> statement-breakpoint
CREATE INDEX `count_line_write_written_by_idx` ON `count_line_write` (`written_by`);--> statement-breakpoint
CREATE INDEX `product_vendor_id_idx` ON `product` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `product_active_idx` ON `product` (`active`);--> statement-breakpoint
CREATE INDEX `product_category_idx` ON `product` (`category`);--> statement-breakpoint
CREATE INDEX `product_barcode_product_id_idx` ON `product_barcode` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_par_location_id_idx` ON `product_par` (`location_id`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_active_idx` ON `user` (`active`);--> statement-breakpoint
CREATE INDEX `user_organization_id_idx` ON `user` (`organization_id`);--> statement-breakpoint
CREATE INDEX `vendor_organization_id_idx` ON `vendor` (`organization_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);