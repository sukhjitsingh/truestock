/**
 * `scripts/lib/assert-local-target.mjs` — pure, no database, no browser.
 *
 * The Playwright harnesses (`verify-browser.mjs`, `verify-ui-redesign.mjs`)
 * insert rows, edit product costs and DELETE their own fixtures through
 * whatever `DATABASE_URL` the shell holds. This guard is the only thing between
 * a stale export and that cleanup running against a remote or production
 * database, and a regression in it is silent: every harness assertion still
 * passes against the wrong target. So each way of being wrong gets its own
 * refusal here.
 *
 * Only the guard is imported. The harnesses call `main()` at module scope and
 * would launch a browser and connect to a database on import.
 */
import { describe, expect, test } from "bun:test";
import { assertLocalTarget } from "@/scripts/lib/assert-local-target.mjs";

const PASSWORD = "s3cret-pw-do-not-log";
const DB = `mysql://truestock:${PASSWORD}@127.0.0.1:3310/truestock`;
const BASE = "http://localhost:3011";
const ALLOW = { VERIFY_ALLOW_DB: "127.0.0.1:3310/truestock" };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the guard to throw, but it returned");
}

describe("assertLocalTarget: accepts", () => {
  test("a loopback database + loopback base URL with the matching VERIFY_ALLOW_DB", () => {
    expect(assertLocalTarget(DB, BASE, ALLOW)).toEqual({ host: "127.0.0.1", port: "3310", database: "truestock" });
  });

  test("every loopback spelling is accepted, for the database and the app alike", () => {
    expect(assertLocalTarget("mysql://u:p@localhost:3307/truestock", "http://127.0.0.1:3000", {
      VERIFY_ALLOW_DB: "localhost:3307/truestock",
    })).toEqual({ host: "localhost", port: "3307", database: "truestock" });

    expect(assertLocalTarget("mysql://u:p@[::1]:3307/truestock", "http://[::1]:3000", {
      VERIFY_ALLOW_DB: "[::1]:3307/truestock",
    }).database).toBe("truestock");
  });

  test("a URL with no port defaults to 3306, and VERIFY_ALLOW_DB must say so", () => {
    expect(assertLocalTarget("mysql://u:p@localhost/truestock", BASE, { VERIFY_ALLOW_DB: "localhost:3306/truestock" }))
      .toEqual({ host: "localhost", port: "3306", database: "truestock" });
    // Naming the port-less target without the default port is not a match.
    expect(() => assertLocalTarget("mysql://u:p@localhost/truestock", BASE, { VERIFY_ALLOW_DB: "localhost/truestock" }))
      .toThrow(/VERIFY_ALLOW_DB/);
  });

  test("a host is matched case-insensitively and reported in lower case", () => {
    expect(assertLocalTarget("mysql://u:p@LOCALHOST:3310/truestock", BASE, { VERIFY_ALLOW_DB: "localhost:3310/truestock" }).host)
      .toBe("localhost");
  });

  test("does not read process.env when an env is passed", () => {
    const before = process.env.VERIFY_ALLOW_DB;
    process.env.VERIFY_ALLOW_DB = "127.0.0.1:3310/truestock";
    try {
      expect(() => assertLocalTarget(DB, BASE, {})).toThrow(/VERIFY_ALLOW_DB is not set/);
    } finally {
      if (before === undefined) delete process.env.VERIFY_ALLOW_DB;
      else process.env.VERIFY_ALLOW_DB = before;
    }
  });
});

describe("assertLocalTarget: VERIFY_ALLOW_DB is the per-run opt-in", () => {
  test("refuses when it is missing, and tells the operator the exact value to export", () => {
    const msg = messageOf(() => assertLocalTarget(DB, BASE, {}));
    expect(msg).toContain("VERIFY_ALLOW_DB is not set");
    expect(msg).toContain("VERIFY_ALLOW_DB=127.0.0.1:3310/truestock");
  });

  test("an empty string counts as missing", () => {
    expect(() => assertLocalTarget(DB, BASE, { VERIFY_ALLOW_DB: "" })).toThrow(/VERIFY_ALLOW_DB is not set/);
  });

  test("refuses a mismatching value (wrong port, wrong database, wrong host, stray whitespace)", () => {
    for (const wrong of [
      "127.0.0.1:3307/truestock", // a different published port: the stale-shell case
      "127.0.0.1:3310/truestock_test", // a different database on the same server
      "localhost:3310/truestock", // same machine, different spelling: exact means exact
      " 127.0.0.1:3310/truestock",
      "127.0.0.1:3310/truestock ",
      "127.0.0.1:3310/truestock/",
      "1",
      "true",
    ]) {
      const msg = messageOf(() => assertLocalTarget(DB, BASE, { VERIFY_ALLOW_DB: wrong }));
      expect(msg).toContain("does not match");
      expect(msg).toContain("VERIFY_ALLOW_DB=127.0.0.1:3310/truestock");
    }
  });
});

describe("assertLocalTarget: refuses a non-local target even when VERIFY_ALLOW_DB names it", () => {
  test("a remote database host (the Hostinger shape)", () => {
    const url = `mysql://u123_app:${PASSWORD}@srv123.hstgr.io:3306/u123_truestock`;
    const msg = messageOf(() => assertLocalTarget(url, BASE, { VERIFY_ALLOW_DB: "srv123.hstgr.io:3306/u123_truestock" }));
    expect(msg).toContain("srv123.hstgr.io");
    expect(msg).toContain("not a loopback address");
  });

  test("a docker service name is not loopback", () => {
    const url = `mysql://truestock:${PASSWORD}@db:3306/truestock`;
    const msg = messageOf(() => assertLocalTarget(url, BASE, { VERIFY_ALLOW_DB: "db:3306/truestock" }));
    expect(msg).toContain("not a loopback address");
    expect(msg).toContain("docker service name");
  });

  test("a LAN address and a loopback lookalike are not loopback", () => {
    for (const host of ["192.168.12.33", "127.0.0.2", "localhost.example.com", "127.0.0.1.nip.io", "0.0.0.0"]) {
      expect(() =>
        assertLocalTarget(`mysql://u:p@${host}:3310/truestock`, BASE, { VERIFY_ALLOW_DB: `${host}:3310/truestock` }),
      ).toThrow(/not a loopback address/);
    }
  });

  test("a remote base URL, even with a loopback database", () => {
    for (const remote of ["https://truestock.example.com", "http://192.168.12.33:3000", "https://app.truestock.io/login"]) {
      const msg = messageOf(() => assertLocalTarget(DB, remote, ALLOW));
      expect(msg).toContain("BASE_URL");
      expect(msg).toContain("not a loopback address");
    }
  });

  test("a non-mysql scheme", () => {
    for (const scheme of ["postgres", "postgresql", "mariadb", "http"]) {
      expect(() => assertLocalTarget(`${scheme}://u:p@127.0.0.1:3310/truestock`, BASE, ALLOW)).toThrow(/mysql:\/\/ scheme/);
    }
    // `file:` URLs cannot carry credentials or a port, so they fail to parse at all: refused either way.
    expect(() => assertLocalTarget("file://u:p@127.0.0.1:3310/truestock", BASE, ALLOW)).toThrow();
  });

  test("a query string, which the driver would treat as connection options", () => {
    expect(() => assertLocalTarget(`${DB}?socketPath=/tmp/prod.sock`, BASE, ALLOW)).toThrow(/query string/);
    expect(() => assertLocalTarget(`${DB}?host=srv123.hstgr.io`, BASE, ALLOW)).toThrow(/query string/);
  });

  test("a URL with no database name", () => {
    expect(() => assertLocalTarget("mysql://u:p@127.0.0.1:3310", BASE, { VERIFY_ALLOW_DB: "127.0.0.1:3310/" })).toThrow(
      /names no database/,
    );
    expect(() => assertLocalTarget("mysql://u:p@127.0.0.1:3310/", BASE, { VERIFY_ALLOW_DB: "127.0.0.1:3310/" })).toThrow(
      /names no database/,
    );
  });
});

describe("assertLocalTarget: malformed input", () => {
  test("a missing or malformed DATABASE_URL", () => {
    for (const bad of [undefined, "", "   ", "not a url", "127.0.0.1:3310/truestock", "mysql://", "mysql://u:p@:3310/truestock"]) {
      expect(() => assertLocalTarget(bad, BASE, ALLOW)).toThrow();
    }
    expect(() => assertLocalTarget(undefined, BASE, ALLOW)).toThrow(/DATABASE_URL is missing/);
  });

  test("a missing or malformed BASE_URL", () => {
    for (const bad of [undefined, "", "   ", "not a url", "localhost:3011", "//localhost:3011", "ftp://localhost:3011"]) {
      expect(() => assertLocalTarget(DB, bad, ALLOW)).toThrow(/BASE_URL/);
    }
  });

  test("a non-string DATABASE_URL does not throw a TypeError past the guard", () => {
    for (const bad of [null, 3310, {}, []]) {
      expect(() => assertLocalTarget(bad as unknown as string, BASE, ALLOW)).toThrow(/DATABASE_URL is missing/);
    }
  });
});

describe("assertLocalTarget: never leaks the password", () => {
  const cases: Array<[string, () => unknown]> = [
    ["missing VERIFY_ALLOW_DB", () => assertLocalTarget(DB, BASE, {})],
    ["mismatching VERIFY_ALLOW_DB", () => assertLocalTarget(DB, BASE, { VERIFY_ALLOW_DB: "127.0.0.1:1/x" })],
    [
      "the whole URL pasted into VERIFY_ALLOW_DB",
      () => assertLocalTarget(DB, BASE, { VERIFY_ALLOW_DB: DB }),
    ],
    [
      "remote host",
      () => assertLocalTarget(`mysql://u:${PASSWORD}@srv123.hstgr.io:3306/prod`, BASE, ALLOW),
    ],
    ["docker service host", () => assertLocalTarget(`mysql://u:${PASSWORD}@db:3306/truestock`, BASE, ALLOW)],
    ["non-mysql scheme", () => assertLocalTarget(`postgres://u:${PASSWORD}@127.0.0.1:3310/truestock`, BASE, ALLOW)],
    ["query string", () => assertLocalTarget(`${DB}?socketPath=/x`, BASE, ALLOW)],
    ["no database name", () => assertLocalTarget(`mysql://u:${PASSWORD}@127.0.0.1:3310`, BASE, ALLOW)],
    ["remote base URL", () => assertLocalTarget(DB, `https://u:${PASSWORD}@truestock.example.com`, ALLOW)],
    ["malformed database URL", () => assertLocalTarget(`u:${PASSWORD}@127.0.0.1/truestock`, BASE, ALLOW)],
    ["malformed base URL", () => assertLocalTarget(DB, `u:${PASSWORD}@localhost`, ALLOW)],
    ["unparseable database URL", () => assertLocalTarget(`mysql://u:${PASSWORD}@[nope/truestock`, BASE, ALLOW)],
  ];

  for (const [name, run] of cases) {
    test(name, () => {
      const msg = messageOf(run);
      expect(msg).not.toContain(PASSWORD);
      expect(msg).not.toContain("s3cret");
    });
  }
});
