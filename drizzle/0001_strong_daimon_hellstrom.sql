ALTER TABLE `product` DROP FOREIGN KEY `product_vendor_id_vendor_id_fk`;
--> statement-breakpoint
ALTER TABLE `product_barcode` DROP FOREIGN KEY `product_barcode_product_id_product_id_fk`;
--> statement-breakpoint
ALTER TABLE `product_par` DROP FOREIGN KEY `product_par_product_id_product_id_fk`;
--> statement-breakpoint
ALTER TABLE `product_par` DROP FOREIGN KEY `product_par_location_id_location_id_fk`;
--> statement-breakpoint
ALTER TABLE `location` ADD CONSTRAINT `location_organization_id_id_unique` UNIQUE(`organization_id`,`id`);--> statement-breakpoint
ALTER TABLE `product` ADD CONSTRAINT `product_organization_id_id_unique` UNIQUE(`organization_id`,`id`);--> statement-breakpoint
ALTER TABLE `vendor` ADD CONSTRAINT `vendor_organization_id_id_unique` UNIQUE(`organization_id`,`id`);--> statement-breakpoint
ALTER TABLE `product` ADD CONSTRAINT `product_organization_vendor_fk` FOREIGN KEY (`organization_id`,`vendor_id`) REFERENCES `vendor`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_barcode` ADD CONSTRAINT `product_barcode_organization_product_fk` FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_par` ADD CONSTRAINT `product_par_organization_product_fk` FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_par` ADD CONSTRAINT `product_par_organization_location_fk` FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `location`(`organization_id`,`id`) ON DELETE restrict ON UPDATE no action;