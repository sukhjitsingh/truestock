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
-- The collation is `utf8mb4_uca1400_ai_ci`: MariaDB 11.8's default and PAD
-- SPACE, so a trailing space never makes a second "same" name in a unique
-- index — the same comparison CI's MariaDB uses. Owner decision 2026-11-12
-- (docs/open-items.md #51). This file used to say `utf8mb4_0900_ai_ci` and
-- call it an alias of the same thing; on 11.8.8 that MySQL name is the NO PAD
-- variant (`SELECT 'a' = 'a ' COLLATE utf8mb4_0900_ai_ci` is 0).
--
-- (An earlier version of this file claimed the opposite — that the statement
-- would fail on MariaDB and so served as an engine tripwire. That was wrong,
-- and the tripwire never existed. Hostinger's engine was established by
-- probing the host directly instead.)
ALTER DATABASE `truestock`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_uca1400_ai_ci;
