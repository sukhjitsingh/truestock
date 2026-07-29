-- Runs once, on an empty data volume, after the entrypoint has created
-- `truestock` and granted the app user.
--
-- The server flags in docker-compose.yml already make this the default, so
-- this is belt-and-braces: it makes the database's own charset explicit rather
-- than dependent on the server having been started with the right flags.
--
-- Requirement source: db/README.md "Set up a database"; schema audit F3 —
-- nothing in db/schema.ts or drizzle/*.sql declares a charset, so every table
-- inherits whatever the database was created with.
--
-- A note on the collation name, because it looks wrong and is not:
-- `utf8mb4_0900_ai_ci` is a MySQL 8 name, and this container runs MariaDB 11.8
-- to match Hostinger. MariaDB 11.x accepts it as an alias for
-- `utf8mb4_uca1400_ai_ci` for MySQL compatibility — verified on 11.8.8, this
-- statement succeeds. Keeping the MySQL spelling means one collation name
-- across db/README.md, the schema audit and this file, instead of two names
-- for the same ordering.
--
-- (An earlier version of this file claimed the opposite — that the statement
-- would fail on MariaDB and so served as an engine tripwire. That was wrong,
-- and the tripwire never existed. Hostinger's engine was established by
-- probing the host directly instead.)
ALTER DATABASE `truestock`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
