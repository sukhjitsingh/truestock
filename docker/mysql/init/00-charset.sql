-- Runs once, on an empty data volume, after the entrypoint has created
-- `truestock` and granted the app user.
--
-- The server flags in docker-compose.yml already make this the default, so on
-- the charset itself this is belt-and-braces. Its real job is to FAIL LOUDLY
-- on the wrong engine: `utf8mb4_0900_ai_ci` does not exist in MariaDB. If
-- Hostinger turns out to serve MariaDB rather than MySQL, this one line is the
-- difference between finding out here, on a throwaway volume, and finding out
-- part-way through a production migration.
--
-- Requirement source: db/README.md "Set up a database"; schema audit F3.
ALTER DATABASE `truestock`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
