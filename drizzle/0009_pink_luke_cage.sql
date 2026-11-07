CREATE TABLE `audit_packet` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`status` enum('building','ready','expired','failed') NOT NULL DEFAULT 'building',
	`date_from` date NOT NULL,
	`date_to` date NOT NULL,
	`file_path` varchar(1024),
	`file_sha256` varchar(64),
	`manifest_json` json,
	`expires_at` timestamp,
	`completed_at` timestamp,
	`created_by` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `audit_packet_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_packet_organization_id_id_unique` UNIQUE(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_packet_file` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organization_id` int NOT NULL,
	`audit_packet_id` int NOT NULL,
	`source_table` enum('invoice','count') NOT NULL,
	`source_id` int NOT NULL,
	`file_path` varchar(1024) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_packet_file_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `audit_packet` ADD CONSTRAINT `audit_packet_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_packet` ADD CONSTRAINT `audit_packet_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_packet_file` ADD CONSTRAINT `audit_packet_file_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_packet_file` ADD CONSTRAINT `audit_packet_file_organization_packet_fk` FOREIGN KEY (`organization_id`,`audit_packet_id`) REFERENCES `audit_packet`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_packet_organization_status_idx` ON `audit_packet` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `audit_packet_file_organization_packet_idx` ON `audit_packet_file` (`organization_id`,`audit_packet_id`);