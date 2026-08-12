ALTER TABLE `location` ADD `active` boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `location_organization_active_idx` ON `location` (`organization_id`,`active`);