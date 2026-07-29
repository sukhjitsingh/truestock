-- A SECOND database on the same server, for the automated test suite only.
--
-- Tests must never run against `truestock`. The reset-to-zero a suite needs
-- (truncate, or drop-and-remigrate) would wipe the costs, pars, and enrolled
-- barcodes entered by hand through the back office — the exact data
-- db/README.md's seeding section goes out of its way to protect from a
-- re-seed. Separate database, same container, same charset, same server
-- flags, so the only thing that differs is what gets destroyed.
CREATE DATABASE IF NOT EXISTS `truestock_test`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `truestock_test`.* TO 'truestock'@'%';
FLUSH PRIVILEGES;
