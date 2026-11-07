CREATE TABLE `extraction_job` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`invoice_id` int NOT NULL,
	`status` enum('awaiting_upload','queued','running','done','failed') NOT NULL DEFAULT 'awaiting_upload',
	`phase` enum('classify','text_extract','ocr','parse'),
	`pdf_type` enum('text','scanned','mixed','image'),
	`pages_needing_ocr` json,
	`error_message` text,
	`claimed_at` timestamp,
	`claimed_by` varchar(255),
	`started_at` timestamp,
	`completed_at` timestamp,
	`retry_count` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `extraction_job_id` PRIMARY KEY(`id`),
	CONSTRAINT `extraction_job_organization_id_id_unique` UNIQUE(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `invoice` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`vendor_id` int,
	`status` enum('uploaded','processing','needs_review','reviewed','approved','rejected') NOT NULL DEFAULT 'uploaded',
	`source` enum('photo','pdf','email_forward') NOT NULL,
	`file_path` varchar(1024),
	`file_sha256` varchar(64) NOT NULL,
	`file_size_bytes` int NOT NULL,
	`page_count` int,
	`invoice_date` date,
	`due_date` date,
	`invoice_number` varchar(100),
	`total_gross` decimal(10,4),
	`total_discount` decimal(10,4),
	`total_net` decimal(10,4),
	`currency` varchar(3),
	`retention_until` date,
	`approved_at` timestamp,
	`approved_by` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoice_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_organization_id_id_unique` UNIQUE(`organization_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `extraction_job` ADD CONSTRAINT `extraction_job_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `extraction_job` ADD CONSTRAINT `extraction_job_organization_invoice_fk` FOREIGN KEY (`organization_id`,`invoice_id`) REFERENCES `invoice`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice` ADD CONSTRAINT `invoice_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice` ADD CONSTRAINT `invoice_approved_by_user_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice` ADD CONSTRAINT `invoice_organization_vendor_fk` FOREIGN KEY (`organization_id`,`vendor_id`) REFERENCES `vendor`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `extraction_job_status_id_idx` ON `extraction_job` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `invoice_organization_status_invoice_date_idx` ON `invoice` (`organization_id`,`status`,`invoice_date`);--> statement-breakpoint
CREATE INDEX `invoice_organization_vendor_invoice_date_idx` ON `invoice` (`organization_id`,`vendor_id`,`invoice_date`);--> statement-breakpoint
CREATE INDEX `invoice_organization_retention_until_idx` ON `invoice` (`organization_id`,`retention_until`);