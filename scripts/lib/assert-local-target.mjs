/**
 * Target guard for the Playwright verification harnesses
 * (`scripts/verify-browser.mjs`, `scripts/verify-ui-redesign.mjs`).
 *
 * Those scripts sign in, mutate rows and then DELETE their own fixtures, all
 * through whatever `DATABASE_URL` the shell happens to hold. A stale export, or
 * an `--env-file` pointed at the production credentials, would aim the cleanup
 * at the real database — and the failure is silent, because every assertion
 * still passes against it. So the target has to be named on purpose, every run.
 *
 * Pure: no I/O, no side effects, no logging. It throws or it returns. Kept in a
 * module with no top-level `main()` so a test can import it — the harnesses
 * themselves run on import and must never be imported from a test.
 *
 * Three independent conditions, ALL required:
 *   1. `databaseUrl` is a `mysql://` URL on a loopback host. A docker service
 *      name (`db`) is deliberately not loopback: the harness runs on the host,
 *      so a service name would not resolve anyway, and "it resolved" must never
 *      be what makes a target look safe.
 *   2. `baseUrl` (the app under test) is on a loopback host too — the harness
 *      signs in there, which writes a session row to whatever database THAT
 *      server uses.
 *   3. `VERIFY_ALLOW_DB` is set to exactly `<host>:<port>/<database>` of the
 *      DATABASE_URL. Naming the exact target per run means a leftover
 *      `DATABASE_URL` in the shell can never be hit by accident: the operator
 *      has to type the database they mean.
 *
 * Credentials never appear in an error message. Messages carry host, port and
 * database name only, and malformed input is never echoed back (a pasted
 * `user:password@host` string would otherwise end up in a log).
 */

// `URL#hostname` keeps the brackets on an IPv6 literal, so both spellings count.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function tryParse(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function refuse(reason, remedy) {
  return new Error(`verification harness refused to run: ${reason}\n${remedy}`);
}

/**
 * @param {string | undefined} databaseUrl  usually `process.env.DATABASE_URL`
 * @param {string | undefined} baseUrl      the app under test, e.g. `http://localhost:3011`
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ host: string, port: string, database: string }}
 */
export function assertLocalTarget(databaseUrl, baseUrl, env = process.env) {
  const db = tryParse(databaseUrl);
  if (!db) {
    throw refuse(
      "DATABASE_URL is missing or is not a parseable URL.",
      "Expected mysql://<user>:<password>@127.0.0.1:<published-port>/<database> for the local docker database.",
    );
  }
  if (db.protocol !== "mysql:") {
    throw refuse(
      "DATABASE_URL must use the mysql:// scheme.",
      "The driver and the drizzle dialect both speak mysql:// against MariaDB; any other scheme is not this app's database.",
    );
  }
  if (db.search !== "") {
    throw refuse(
      "DATABASE_URL carries a query string.",
      "Query parameters (socketPath, for one) are handed to the driver as connection options and can redirect the " +
        "connection away from the host this check just read. Remove everything after the database name.",
    );
  }

  const host = db.hostname.toLowerCase();
  const port = db.port || "3306";
  let database;
  try {
    database = decodeURIComponent(db.pathname.slice(1));
  } catch {
    database = "";
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    throw refuse(
      `DATABASE_URL points at "${host}" (port ${port}, database "${database}"), which is not a loopback address.`,
      "These scripts create and delete rows. Run them only against a local database reached as 127.0.0.1, localhost " +
        'or ::1. A docker service name such as "db" does not count: publish the container port and use ' +
        "127.0.0.1:<published-port> instead. Never point them at a remote or production host.",
    );
  }
  if (database === "") {
    throw refuse(
      "DATABASE_URL names no database.",
      "Add the database name: mysql://<user>:<password>@127.0.0.1:<port>/<database>.",
    );
  }

  const base = tryParse(baseUrl);
  if (!base || (base.protocol !== "http:" && base.protocol !== "https:")) {
    throw refuse(
      "BASE_URL is missing or is not a parseable http(s) URL.",
      "Expected something like http://localhost:3011 — the scheme is required.",
    );
  }
  if (!LOOPBACK_HOSTS.has(base.hostname.toLowerCase())) {
    throw refuse(
      `BASE_URL points at "${base.hostname.toLowerCase()}", which is not a loopback address.`,
      "The harness signs in to the app under test, and the app writes to its own database. Point BASE_URL at the " +
        "local instance (localhost, 127.0.0.1 or ::1) that uses the database named in DATABASE_URL.",
    );
  }

  const target = `${host}:${port}/${database}`;
  const allowed = env.VERIFY_ALLOW_DB;
  if (allowed !== target) {
    // The supplied value is not echoed: someone pasting the whole DATABASE_URL
    // into it would otherwise have their password printed.
    throw refuse(
      allowed === undefined || allowed === ""
        ? "VERIFY_ALLOW_DB is not set."
        : "VERIFY_ALLOW_DB does not match the database DATABASE_URL points at.",
      "This is an explicit per-run opt-in naming the exact target, so a stale DATABASE_URL in the shell cannot be " +
        `hit by accident. To run against this one, export:\n  VERIFY_ALLOW_DB=${target}`,
    );
  }

  return { host, port, database };
}
