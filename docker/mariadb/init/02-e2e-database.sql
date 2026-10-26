-- A THIRD database on the same server, for the Playwright e2e suite only
-- (e2e/README.md). Same reasoning as 01-test-database.sql: the suite deletes
-- every count in the database it targets (`resetCounts()`), so it must never be
-- pointed at `truestock`. The suite also refuses any database whose name does
-- not end in `_e2e`, which is why the name is not configurable.
--
-- Runs once, on a fresh data volume. On an existing volume, run
-- `bash scripts/e2e-rig.sh db` instead - it executes this same statement.
CREATE DATABASE IF NOT EXISTS `truestock_e2e`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `truestock_e2e`.* TO 'truestock'@'%';
FLUSH PRIVILEGES;
