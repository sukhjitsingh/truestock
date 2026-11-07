/**
 * Target guard for the e2e suite. Pure: it throws or it returns.
 *
 * Why this exists. The suite signs in, mutates rows and DELETES count rows, all
 * through whatever `DATABASE_URL` the shell holds and whatever app
 * `E2E_BASE_URL` names. A stale export, or an env file pointed at the real
 * database, would aim `resetCounts()` at production data — and the failure is
 * silent, because every assertion still passes. So the target is checked on
 * every run, in global setup AND again each time the DB pool is built (a worker
 * can be started by something other than `playwright test`'s main process).
 *
 * Same three rules as `scripts/lib/assert-local-target.mjs`, re-implemented
 * rather than imported: that module is ESM and Playwright loads this tree as
 * CommonJS, and its `VERIFY_ALLOW_DB` per-run opt-in is replaced here by a
 * stronger, structural rule — the database must be NAMED for this purpose:
 *
 *   1. the DB host is loopback (the suite runs on the host, so a docker
 *      service name like `db` is not it, and "it resolved" must never be what
 *      makes a target look safe);
 *   2. the app under test is loopback too (signing in writes a session row to
 *      whatever database THAT server uses);
 *   3. the database name ends in `_e2e`, mirroring `tests/helpers/test-db.ts`'s
 *      `_test` rule. A database that was not created to be wiped cannot pass.
 *
 * Credentials never appear in an error: messages carry host, port and database
 * name only, and malformed input is never echoed (a pasted `user:pw@host`
 * string would otherwise end up in a log).
 */

// `URL#hostname` keeps the brackets on an IPv6 literal, so both spellings count.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface E2eTarget {
  dbHost: string;
  dbPort: string;
  database: string;
  appHost: string;
}

function refuse(reason: string, remedy: string): Error {
  return new Error(`e2e refused to run: ${reason}\n${remedy}`);
}

function tryParse(value: string | undefined): URL | null {
  if (!value || value.trim() === "") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function assertE2eTarget(databaseUrl: string | undefined, appUrl: string): E2eTarget {
  const db = tryParse(databaseUrl);
  if (!db) {
    throw refuse(
      "no usable database URL (E2E_DATABASE_URL / DATABASE_URL is missing or unparseable).",
      "Expected mysql://<user>:<password>@127.0.0.1:<published-port>/<name>_e2e.",
    );
  }
  if (db.protocol !== "mysql:") {
    throw refuse("the database URL must use the mysql:// scheme.", "MariaDB speaks the MySQL wire protocol; any other scheme is not this app's database.");
  }
  if (db.search !== "") {
    throw refuse(
      "the database URL carries a query string.",
      "Query parameters (socketPath, for one) become driver options and can redirect the connection away from the host this check just read.",
    );
  }

  const dbHost = db.hostname.toLowerCase();
  const dbPort = db.port || "3306";
  let database: string;
  try {
    database = decodeURIComponent(db.pathname.slice(1));
  } catch {
    database = "";
  }

  if (!LOOPBACK_HOSTS.has(dbHost)) {
    throw refuse(
      `the database host "${dbHost}" (port ${dbPort}, database "${database}") is not a loopback address.`,
      "These tests delete rows. Use a local database reached as 127.0.0.1, localhost or ::1 — publish the container port; a docker service name does not count.",
    );
  }
  if (!database.endsWith("_e2e")) {
    throw refuse(
      `the database name "${database}" does not end in "_e2e".`,
      "resetCounts() deletes every count in the organization. Point E2E_DATABASE_URL at a throwaway database created for this suite.",
    );
  }

  const app = tryParse(appUrl);
  if (!app || (app.protocol !== "http:" && app.protocol !== "https:")) {
    throw refuse("E2E_BASE_URL is missing or is not an http(s) URL.", "Expected something like http://localhost:3101.");
  }
  const appHost = app.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(appHost)) {
    throw refuse(
      `E2E_BASE_URL points at "${appHost}", which is not a loopback address.`,
      "The suite signs in to the app under test and that app writes to its own database. Point it at the local instance that uses the _e2e database.",
    );
  }

  return { dbHost, dbPort, database, appHost };
}
