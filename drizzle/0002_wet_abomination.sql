-- Schema audit 2026-07-27, findings F1/F2/F4.
--
-- HAND-EDITED, deliberately. `drizzle-kit generate` emitted the six
-- `MODIFY COLUMN ... bigint` statements below without first dropping the
-- foreign keys that span those columns, which MySQL rejects outright:
--
--   ERROR 3780 (HY000): Referencing column 'count_id' and referenced column
--   'id' in foreign key constraint 'count_line_organization_count_fk' are
--   incompatible.
--
-- (Verified by applying the generated file to MySQL 8.0; it failed on the
-- first MODIFY.) drizzle-kit has no notion of the drop/modify/re-add dance a
-- width change under a foreign key requires, so the ordering is written by
-- hand here. db/schema.ts remains the source of truth, and
-- drizzle/meta/0002_snapshot.json describes exactly the end state this file
-- produces -- the invariant that matters ("no hand-edited schema drift") is
-- intact; only the statement ordering is ours.
--
-- F1: widen the count / count_line / count_line_write id chain to BIGINT.
-- Step 1 -- drop every foreign key that spans a column about to change width.
ALTER TABLE `count_line` DROP FOREIGN KEY `count_line_organization_count_fk`;
--> statement-breakpoint
ALTER TABLE `count_line_write` DROP FOREIGN KEY `count_line_write_organization_line_fk`;
--> statement-breakpoint
ALTER TABLE `count_line_write` DROP FOREIGN KEY `count_line_write_count_id_count_id_fk`;
--> statement-breakpoint
-- Step 2 -- widen. Referenced columns first, then referencing ones: not
-- required once the constraints are gone, but it keeps the intent readable.
ALTER TABLE `count` MODIFY COLUMN `id` bigint AUTO_INCREMENT NOT NULL;
--> statement-breakpoint
ALTER TABLE `count_line` MODIFY COLUMN `id` bigint AUTO_INCREMENT NOT NULL;
--> statement-breakpoint
ALTER TABLE `count_line` MODIFY COLUMN `count_id` bigint NOT NULL;
--> statement-breakpoint
ALTER TABLE `count_line_write` MODIFY COLUMN `id` bigint AUTO_INCREMENT NOT NULL;
--> statement-breakpoint
ALTER TABLE `count_line_write` MODIFY COLUMN `count_line_id` bigint NOT NULL;
--> statement-breakpoint
ALTER TABLE `count_line_write` MODIFY COLUMN `count_id` bigint NOT NULL;
--> statement-breakpoint
-- Step 3 -- restore the foreign keys with the ON DELETE behaviour they had.
ALTER TABLE `count_line` ADD CONSTRAINT `count_line_organization_count_fk` FOREIGN KEY (`organization_id`,`count_id`) REFERENCES `count`(`organization_id`,`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `count_line_write` ADD CONSTRAINT `count_line_write_organization_line_fk` FOREIGN KEY (`organization_id`,`count_line_id`) REFERENCES `count_line`(`organization_id`,`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `count_line_write` ADD CONSTRAINT `count_line_write_count_id_count_id_fk` FOREIGN KEY (`count_id`) REFERENCES `count`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- F2: re-key three single-column indexes as organization-first composites.
DROP INDEX `count_status_idx` ON `count`;
--> statement-breakpoint
DROP INDEX `product_active_idx` ON `product`;
--> statement-breakpoint
DROP INDEX `product_category_idx` ON `product`;
--> statement-breakpoint
CREATE INDEX `count_organization_status_idx` ON `count` (`organization_id`,`status`);
--> statement-breakpoint
CREATE INDEX `product_organization_active_idx` ON `product` (`organization_id`,`active`);
--> statement-breakpoint
CREATE INDEX `product_organization_category_idx` ON `product` (`organization_id`,`category`);
--> statement-breakpoint
-- F4: index the session expiry sweep.
CREATE INDEX `session_expires_at_idx` ON `session` (`expires_at`);
