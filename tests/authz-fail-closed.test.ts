/**
 * `lib/authz.ts` is the only place a request becomes an actor. This file proves
 * it fails CLOSED, that the role is re-read from the database on every call,
 * and — structurally — that every server action and route handler actually
 * calls it. Today only the happy paths and a handful of role gates are tested.
 *
 * Guards AGENTS.md invariant 7 (authorization is checked in every server action
 * and route handler, not only in middleware), invariant 8 (cost and invoice
 * money are owner-only; the owner-only action set is pinned by name) and
 * invariant 9 (`Actor.organizationId` comes from the database, never from the
 * session payload the client influenced).
 *
 * Mutations that must turn this file red:
 *   - lib/authz.ts requireSession: delete the `if (!row.active)` check
 *     (inactive-user tests) or the `if (!row.organizationActive)` check
 *     (inactive-org test) or the `isKnownRole` check (unrecognised-role test).
 *   - lib/authz.ts requireSession: return `sessionData.user.role` instead of the
 *     row's role (forged-claim and demotion tests).
 *   - lib/authz.ts requireRole: replace `!allowed.includes(actor.role)` with
 *     `false` (every staff-refused test).
 *   - app/actions/<any>.ts: delete the `await requireRole(...)` line from one
 *     exported action (the structural test names it), or move it after
 *     `.parse(` (the ordering test).
 *   - app/actions/catalog.ts: add "staff" to updateProductAction's requireRole
 *     (staff-refused test AND the pinned staff-reachable list).
 *   - app/actions/invoices.ts: widen approveInvoiceAction to ("owner",
 *     "manager") (the owner-only pin).
 *   - app/api/**: delete the `requireRole` call from a route handler.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { user, organization, product } from "@/db/schema";
import { openCount } from "@/lib/domain/counts";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  type Fixtures,
} from "./helpers/test-db";

// ---------------------------------------------------------------------------
// Session harness. `next/headers` and `@/lib/auth` are mocked at module scope
// (same pattern as tests/vendor-write-path.test.ts and
// tests/location-write-path.test.ts) so `requireSession`'s own database lookup
// — the part under test — still runs for real. `@/lib/authz` and the action
// modules are imported dynamically, inside tests, so the mocks are in place
// before anything that imports them resolves.
// ---------------------------------------------------------------------------

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

/** What Better Auth's getSession returns for the current test. */
let sessionFactory: () => unknown = () => null;

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => sessionFactory(),
    },
  },
}));

function signedInAs(userId: number | string, extraUserClaims: Record<string, unknown> = {}) {
  sessionFactory = () => ({
    session: { id: "mock-session" },
    user: { id: String(userId), ...extraUserClaims },
  });
}

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  sessionFactory = () => null;
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

/** Runs `fn`, requires it to throw an AuthzError, and returns its status + message. */
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  const { AuthzError } = await import("@/lib/authz");
  try {
    await fn();
  } catch (err) {
    if (err instanceof AuthzError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error("expected an AuthzError, but the call resolved");
}

// ---------------------------------------------------------------------------
// requireSession fails closed
// ---------------------------------------------------------------------------

describe("requireSession — fails closed", () => {
  test("positive control: each role resolves to an actor built from the DATABASE row", async () => {
    // Without this, every refusal below could be passing because the mocked
    // session harness refuses everyone.
    const { requireSession } = await import("@/lib/authz");

    for (const [who, actor] of [
      ["owner", fx.owner],
      ["manager", fx.manager],
      ["staff", fx.staff],
    ] as const) {
      signedInAs(actor.userId);
      expect(await requireSession()).toEqual({
        userId: actor.userId,
        role: who,
        organizationId: fx.organizationId,
      });
    }
  });

  test("no session at all is 401", async () => {
    const { requireSession } = await import("@/lib/authz");
    sessionFactory = () => null;
    expect(await refusal(() => requireSession())).toEqual({ status: 401, message: "Sign in required." });
  });

  test("a half-formed session (session without user, user without session) is also 401", async () => {
    const { requireSession } = await import("@/lib/authz");

    sessionFactory = () => ({ session: { id: "s" }, user: null });
    expect((await refusal(() => requireSession())).status).toBe(401);

    sessionFactory = () => ({ session: null, user: { id: String(fx.owner.userId) } });
    expect((await refusal(() => requireSession())).status).toBe(401);
  });

  test("an inactive user is 403, and re-activating them restores access (the 403 is not sticky or cached)", async () => {
    const { requireSession } = await import("@/lib/authz");
    signedInAs(fx.staff.userId);
    expect((await requireSession()).role).toBe("staff");

    await db.update(user).set({ active: false }).where(eq(user.id, fx.staff.userId));
    expect(await refusal(() => requireSession())).toEqual({ status: 403, message: "Account is inactive." });

    await db.update(user).set({ active: true }).where(eq(user.id, fx.staff.userId));
    expect((await requireSession()).role).toBe("staff");
  });

  test("an inactive organization is 403 for EVERY role in it — and not for the other tenant", async () => {
    const { requireSession } = await import("@/lib/authz");
    await db.update(organization).set({ active: false }).where(eq(organization.id, fx.organizationId));

    for (const actor of [fx.owner, fx.manager, fx.staff]) {
      signedInAs(actor.userId);
      const r = await refusal(() => requireSession());
      expect(r.status).toBe(403);
      expect(r.message).toBe("This account is not currently active.");
    }

    signedInAs(fx.otherOwner.userId);
    expect((await requireSession()).organizationId).toBe(fx.otherOrganizationId);
  });

  test("a session whose user row no longer exists is 403, not a crash and not a default actor", async () => {
    const { requireSession } = await import("@/lib/authz");
    signedInAs(fx.staff.userId);
    expect((await requireSession()).role).toBe("staff");

    await db.delete(user).where(eq(user.id, fx.staff.userId));

    expect(await refusal(() => requireSession())).toEqual({ status: 403, message: "Account not found." });
  });

  test("an unrecognised role is 403 (the enum column cannot hold 'janitor', so the nearest storable value is used)", async () => {
    const { requireSession } = await import("@/lib/authz");
    // `user.role` is a MySQL ENUM, so 'janitor' is rejected in strict mode. A
    // dedicated connection with a non-strict session sql_mode stores the enum's
    // error value ('') instead — a value outside the three known roles, which is
    // all `isKnownRole` has to reject. The pooled `db` can't be used: SET
    // SESSION would land on an arbitrary pooled connection.
    const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL! });
    try {
      await conn.query("SET SESSION sql_mode = ''");
      await conn.query("UPDATE `user` SET `role` = 'janitor' WHERE `id` = ?", [fx.manager.userId]);
    } finally {
      await conn.end();
    }
    const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, fx.manager.userId));
    // Proves the setup reached the branch it claims to test.
    expect(["owner", "manager", "staff"]).not.toContain(row.role);

    signedInAs(fx.manager.userId);
    expect(await refusal(() => requireSession())).toEqual({
      status: 403,
      message: "Account has an unrecognized role.",
    });
  });

  test("a session user id that is not a number is refused, never resolved to some actor", async () => {
    const { requireSession } = await import("@/lib/authz");
    // Observed: this surfaces as a DrizzleQueryError (Number("not-a-number") is
    // NaN and reaches the query), NOT an AuthzError 401/403. Still fail-closed —
    // it throws and no actor comes back — and runAction collapses it to the
    // generic message. Better Auth only ever issues numeric ids, so this is
    // unreachable in practice; asserted loosely on purpose so tightening it to
    // a clean 403 later does not break this test.
    signedInAs("not-a-number");
    await expect(requireSession()).rejects.toThrow();
  });

  test("role and organization claims carried in the SESSION payload are ignored (invariant 9)", async () => {
    const { requireSession } = await import("@/lib/authz");
    // A staff user whose session blob claims to be an owner of someone else's org.
    signedInAs(fx.staff.userId, { role: "owner", organizationId: fx.otherOrganizationId, active: true });

    const actor = await requireSession();

    expect(actor.role).toBe("staff");
    expect(actor.organizationId).toBe(fx.organizationId);
  });
});

// ---------------------------------------------------------------------------
// The role is re-read from the database on every call
// ---------------------------------------------------------------------------

describe("requireRole — the role is re-read on every call", () => {
  test("demoting a manager takes effect on the very next call, on the same live session", async () => {
    const { requireRole } = await import("@/lib/authz");
    signedInAs(fx.manager.userId);
    expect((await requireRole("owner", "manager")).role).toBe("manager"); // before

    await db.update(user).set({ role: "staff" }).where(eq(user.id, fx.manager.userId));

    const r = await refusal(() => requireRole("owner", "manager"));
    expect(r).toEqual({ status: 403, message: "You do not have permission to perform this action." });
  });

  test("promoting staff takes effect on the next call too (so the gate is reading, not caching a denial)", async () => {
    const { requireRole } = await import("@/lib/authz");
    signedInAs(fx.staff.userId);
    expect((await refusal(() => requireRole("owner", "manager"))).status).toBe(403);

    await db.update(user).set({ role: "manager" }).where(eq(user.id, fx.staff.userId));

    expect((await requireRole("owner", "manager")).role).toBe("manager");
  });

  test("requireRole refuses a role outside the allow-list and admits one inside it", async () => {
    const { requireRole } = await import("@/lib/authz");
    signedInAs(fx.manager.userId);
    expect((await refusal(() => requireRole("owner"))).status).toBe(403);
    expect((await requireRole("owner", "manager")).userId).toBe(fx.manager.userId);
    expect((await requireRole("manager")).role).toBe("manager");
  });
});

// ---------------------------------------------------------------------------
// The action layer: nothing happens for a refused caller
// ---------------------------------------------------------------------------

describe("server actions — a refused caller changes nothing", () => {
  async function productRow(id: number) {
    const [row] = await db.select().from(product).where(eq(product.id, id));
    return row;
  }

  test("no session: an action answers 'Sign in required.' and writes nothing", async () => {
    const { updateProductAction } = await import("@/app/actions/catalog");
    sessionFactory = () => null;

    const result = await updateProductAction({ productId: fx.pricedProductId, name: "Anonymous rename" });

    expect(result).toEqual({ ok: false, error: { message: "Sign in required.", fieldErrors: undefined } });
    expect((await productRow(fx.pricedProductId)).name).not.toBe("Anonymous rename");
  });

  test("updateProductAction: staff is refused with nothing written; owner and manager are admitted (positive controls)", async () => {
    const { updateProductAction } = await import("@/app/actions/catalog");
    const before = (await productRow(fx.pricedProductId)).name;

    signedInAs(fx.staff.userId);
    const refused = await updateProductAction({ productId: fx.pricedProductId, name: "Renamed by staff" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe("You do not have permission to perform this action.");
    expect((await productRow(fx.pricedProductId)).name).toBe(before);

    signedInAs(fx.manager.userId);
    expect((await updateProductAction({ productId: fx.pricedProductId, name: "Renamed by manager" })).ok).toBe(true);
    signedInAs(fx.owner.userId);
    expect((await updateProductAction({ productId: fx.pricedProductId, name: "Renamed by owner" })).ok).toBe(true);
    expect((await productRow(fx.pricedProductId)).name).toBe("Renamed by owner");
  });

  test("deactivateProductAction: staff is refused and the product stays active; owner is admitted", async () => {
    const { deactivateProductAction } = await import("@/app/actions/catalog");

    signedInAs(fx.staff.userId);
    const refused = await deactivateProductAction({ productId: fx.pricedProductId });
    expect(refused.ok).toBe(false);
    expect((await productRow(fx.pricedProductId)).active).toBe(true);

    signedInAs(fx.owner.userId);
    expect((await deactivateProductAction({ productId: fx.pricedProductId })).ok).toBe(true);
    // Soft delete only (invariant 6): the row is still there.
    expect((await productRow(fx.pricedProductId)).active).toBe(false);
  });

  test("countSummaryAction: staff gets no data; manager and owner do", async () => {
    const { countSummaryAction } = await import("@/app/actions/reports");
    const c = await openCount(fx.owner, { type: "full" });

    signedInAs(fx.staff.userId);
    const refused = await countSummaryAction({ countId: c.id });
    expect(refused.ok).toBe(false);
    expect("data" in refused).toBe(false);

    signedInAs(fx.manager.userId);
    const asManager = await countSummaryAction({ countId: c.id });
    expect(asManager.ok).toBe(true);
    signedInAs(fx.owner.userId);
    expect((await countSummaryAction({ countId: c.id })).ok).toBe(true);
  });

  test("actionSetUserActive: staff AND manager are refused and the target stays active; owner is admitted", async () => {
    const { actionSetUserActive } = await import("@/app/actions/users");
    const activeOf = async (id: number) =>
      (await db.select({ active: user.active }).from(user).where(eq(user.id, id)))[0].active;

    for (const actor of [fx.staff, fx.manager]) {
      signedInAs(actor.userId);
      const refused = await actionSetUserActive({ userId: fx.staff.userId, active: false });
      expect(refused.ok).toBe(false);
      expect(await activeOf(fx.staff.userId)).toBe(true);
    }

    signedInAs(fx.owner.userId);
    expect((await actionSetUserActive({ userId: fx.staff.userId, active: false })).ok).toBe(true);
    expect(await activeOf(fx.staff.userId)).toBe(false);
  });

  test("an account deactivated between two calls is refused on the second (the per-request `active` re-read invariant 11 leans on)", async () => {
    const { updateProductAction } = await import("@/app/actions/catalog");
    signedInAs(fx.manager.userId);
    expect((await updateProductAction({ productId: fx.pricedProductId, name: "While active" })).ok).toBe(true);

    await db.update(user).set({ active: false }).where(eq(user.id, fx.manager.userId));

    const after = await updateProductAction({ productId: fx.pricedProductId, name: "After deactivation" });
    expect(after.ok).toBe(false);
    expect((await productRow(fx.pricedProductId)).name).toBe("While active");
  });

  test("a manager demoted mid-session loses a manager-only action on the next call", async () => {
    const { deactivateProductAction } = await import("@/app/actions/catalog");
    signedInAs(fx.manager.userId);
    await db.update(user).set({ role: "staff" }).where(eq(user.id, fx.manager.userId));

    expect((await deactivateProductAction({ productId: fx.pricedProductId })).ok).toBe(false);
    expect((await productRow(fx.pricedProductId)).active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural: every action and every route handler authorizes itself
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Strings are preserved (so a `//` inside one isn't mistaken for a comment); comments are dropped. */
function stripComments(src: string): string {
  return src.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, str: string | undefined) => str ?? "",
  );
}

interface ExportedFunction {
  name: string;
  isAsync: boolean;
  /** Source from the `export` keyword to the next top-level export, comments removed. */
  body: string;
}
interface ParsedModule {
  functions: ExportedFunction[];
  /** `export const|let|var|class|default|enum|{|*` — value exports that are not plain functions. */
  valueExports: { names: string[]; line: string }[];
}

function parseModule(source: string): ParsedModule {
  const clean = stripComments(source);
  const starts = [...clean.matchAll(/^export\b[^\n]*/gm)].map((m) => ({
    index: m.index!,
    line: m[0],
  }));
  const functions: ExportedFunction[] = [];
  const valueExports: ParsedModule["valueExports"] = [];
  starts.forEach((s, i) => {
    const body = clean.slice(s.index, starts[i + 1]?.index ?? clean.length);
    const fn = /^export\s+(async\s+)?function\s+(\w+)/.exec(s.line);
    if (fn) {
      functions.push({ name: fn[2], isAsync: Boolean(fn[1]), body });
      return;
    }
    if (/^export\s+(interface|type)\b/.test(s.line)) return; // erased at compile time
    const destructured = /^export\s+(?:const|let|var)\s+\{([^}]*)\}/.exec(s.line);
    const simple = /^export\s+(?:const|let|var|class|enum)\s+(\w+)/.exec(s.line);
    const names = destructured
      ? destructured[1].split(",").map((n) => n.trim().split(":")[0].trim()).filter(Boolean)
      : simple
        ? [simple[1]]
        : [s.line.trim()];
    valueExports.push({ names, line: s.line.trim() });
  });
  return { functions, valueExports };
}

interface AuthCall {
  kind: "requireRole" | "requireSession";
  /** Empty for requireSession (any authenticated user). */
  roles: string[];
}

/** Why an exported function does NOT authorize properly; empty means it does. */
function authProblems(fn: ExportedFunction): string[] {
  const problems: string[] = [];
  const call = /\brequire(Role|Session)\s*\(([^)]*)\)/.exec(fn.body);
  if (!call) {
    return ["never calls requireRole( or requireSession("];
  }
  // The auth call has to be the FIRST thing awaited: authorize before any
  // input is parsed or any data is touched (lib/authz.ts's own contract).
  const firstAwait = fn.body.search(/\bawait\b/);
  if (!/^await\s+require(Role|Session)\s*\(/.test(fn.body.slice(firstAwait))) {
    problems.push("something is awaited before the auth call");
  }
  const parseAt = fn.body.search(/\.(safeParse|parse)\s*\(/);
  if (parseAt !== -1 && parseAt < call.index) {
    problems.push("input is parsed before the auth call");
  }
  return problems;
}

function authCallOf(fn: ExportedFunction): AuthCall | null {
  const call = /\brequire(Role|Session)\s*\(([^)]*)\)/.exec(fn.body);
  if (!call) return null;
  return {
    kind: call[1] === "Role" ? "requireRole" : "requireSession",
    roles: [...call[2].matchAll(/"(\w+)"/g)].map((m) => m[1]),
  };
}

const ACTIONS_DIR = path.join(REPO_ROOT, "app/actions");
const actionFiles = readdirSync(ACTIONS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

/**
 * Exported actions that are deliberately exempt from the auth-call rule.
 * EMPTY: there are no exceptions in app/actions/. Every action, including the
 * read-only ones, authorizes itself. An entry here needs a reason a reviewer
 * would accept, and goes stale (and fails) the moment the function is removed.
 */
const ACTION_ALLOWLIST: Record<string, string> = {};

/**
 * Route files exempt from the rule, by repo-relative path.
 *   - Better Auth's catch-all IS the authentication boundary. Sign-in has no
 *     session to check yet, and every other endpoint behind it (get-session,
 *     sign-out, ...) is gated by Better Auth itself. The file holds no logic of
 *     its own; the exemption cannot absorb a handler added later because the
 *     contents are pinned to the single delegating line below.
 */
const ROUTE_ALLOWLIST: Record<string, string> = {
  "app/api/auth/[...all]/route.ts":
    "Better Auth's own endpoint: the authentication boundary itself, no logic of its own.",
};
const ROUTE_ALLOWLIST_PINNED_BODY = "export const { GET, POST } = toNextJsHandler(auth);";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findRouteFiles(full));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out.sort();
}

describe("structural: every server action authorizes itself (invariant 7)", () => {
  const modules = actionFiles.map((file) => {
    const source = readFileSync(path.join(ACTIONS_DIR, file), "utf-8");
    return { file, source, parsed: parseModule(source) };
  });
  const allActions = modules.flatMap((m) => m.parsed.functions.map((fn) => ({ file: m.file, fn })));

  test("the scanner is not vacuous: it finds every exported async function, counted independently", () => {
    const independent = modules.reduce(
      (n, m) => n + (m.source.match(/^export async function \w+/gm)?.length ?? 0),
      0,
    );
    expect(allActions.length).toBe(independent);
    expect(independent).toBeGreaterThan(30);
    // And it reads real role sets: a known action resolves to a known answer.
    const summary = allActions.find((a) => a.fn.name === "countSummaryAction")!;
    expect(authCallOf(summary.fn)).toEqual({ kind: "requireRole", roles: ["owner", "manager"] });
  });

  test("the scanner catches a bad action (negative controls on the checker itself)", () => {
    const naked = parseModule(
      'export async function nakedAction(input: unknown) {\n  return runAction(async () => {\n    return db.select();\n  });\n}\n',
    ).functions[0];
    expect(authProblems(naked)).toEqual(["never calls requireRole( or requireSession("]);

    // A mention in a comment (here: the NEXT function's doc block) is not a call.
    const commentOnly = parseModule(
      "export async function a(input: unknown) {\n  return db.select();\n}\n/** Calls requireRole(\"owner\") first. */\nexport async function b() {\n  const actor = await requireRole(\"owner\");\n}\n",
    ).functions;
    expect(authProblems(commentOnly[0])).toEqual(["never calls requireRole( or requireSession("]);
    expect(authProblems(commentOnly[1])).toEqual([]);

    const lateAuth = parseModule(
      'export async function lateAction(input: unknown) {\n  const parsed = schema.parse(input);\n  const row = await load(parsed);\n  const actor = await requireRole("owner");\n}\n',
    ).functions[0];
    expect(authProblems(lateAuth).sort()).toEqual([
      "input is parsed before the auth call",
      "something is awaited before the auth call",
    ]);
  });

  test('every action file opens with "use server" and exports only async functions (and erased types)', () => {
    for (const m of modules) {
      expect(m.source.trimStart().startsWith('"use server"')).toBe(true);
      expect(m.parsed.valueExports).toEqual([]);
      for (const fn of m.parsed.functions) expect([m.file, fn.name, fn.isAsync]).toEqual([m.file, fn.name, true]);
    }
  });

  test("every exported async action calls requireRole( or requireSession( — first, before touching input", () => {
    const failures: string[] = [];
    for (const { file, fn } of allActions) {
      if (ACTION_ALLOWLIST[fn.name]) continue;
      for (const p of authProblems(fn)) failures.push(`${file} :: ${fn.name} — ${p}`);
    }
    // One readable list, not a first-failure-only assertion.
    expect(failures).toEqual([]);
  });

  test("the action allow-list holds no stale entries", () => {
    const names = new Set(allActions.map((a) => a.fn.name));
    for (const name of Object.keys(ACTION_ALLOWLIST)) expect(names.has(name)).toBe(true);
    expect(Object.keys(ACTION_ALLOWLIST)).toEqual([]); // currently: no exceptions at all
  });

  test("the set of actions staff can reach is pinned by name (widening it is a deliberate act)", () => {
    const staffReachable = allActions
      .filter(({ fn }) => {
        const call = authCallOf(fn);
        // requireSession() admits every authenticated role, staff included.
        return call !== null && (call.kind === "requireSession" || call.roles.includes("staff"));
      })
      .map(({ fn }) => fn.name)
      .sort();

    expect(staffReachable).toEqual(
      [
        "createProductAction",
        "editCountLineFillsAction",
        "getActiveCountAction",
        "getCountAction",
        "getCountTotalsAction",
        "getProductsByIdsAction",
        "incrementCountLineAction",
        "linkBarcodeToProductAction",
        "listLocationsAction",
        "openCountAction",
        "resolveBarcodeAction",
        "scanCountLineAction",
        "searchProductsAction",
        "setCountLineQuantitiesAction",
        "submitCountAction",
      ].sort(),
    );
  });

  test("every money-bearing and user-management action is owner-only, pinned by name (invariant 8)", () => {
    const ownerOnly = [
      // users.ts — all of it
      "actionListUsers",
      "actionSetUserActive",
      "actionSetUserRole",
      // invoices.ts — everything except upload/confirm and the redacted list
      "getInvoiceAction",
      "listInvoicesForOwnerAction",
      "getInvoiceLinesAction",
      "reviewInvoiceAction",
      "rejectInvoiceAction",
      "approveInvoiceAction",
      "resendToExtractionAction",
      "createAuditPacketAction",
      "getAuditPacketAction",
    ];
    const byName = new Map(allActions.map((a) => [a.fn.name, a.fn]));
    for (const name of ownerOnly) {
      const fn = byName.get(name);
      expect(fn, `${name} should exist`).toBeDefined();
      expect([name, authCallOf(fn!)]).toEqual([name, { kind: "requireRole", roles: ["owner"] }]);
    }
  });
});

describe("structural: every route handler authorizes itself (invariant 7)", () => {
  const routeFiles = findRouteFiles(path.join(REPO_ROOT, "app/api"));
  const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");

  test("the scanner finds the known route files", () => {
    expect(routeFiles.map(rel)).toEqual(
      expect.arrayContaining([
        "app/api/audit-packets/[id]/route.ts",
        "app/api/auth/[...all]/route.ts",
        "app/api/invoices/[id]/file/route.ts",
      ]),
    );
  });

  test("every HTTP handler outside the allow-list calls requireRole( or requireSession( first", () => {
    const failures: string[] = [];
    let handlersSeen = 0;
    for (const file of routeFiles) {
      if (ROUTE_ALLOWLIST[rel(file)]) continue;
      const parsed = parseModule(readFileSync(file, "utf-8"));
      for (const fn of parsed.functions.filter((f) => HTTP_METHODS.has(f.name))) {
        handlersSeen++;
        for (const p of authProblems(fn)) failures.push(`${rel(file)} :: ${fn.name} — ${p}`);
      }
      // A handler declared as `export const GET = ...` can't be analysed
      // here, so it must not slip past unnoticed.
      for (const v of parsed.valueExports) {
        if (v.names.some((n) => HTTP_METHODS.has(n))) {
          failures.push(`${rel(file)} :: ${v.line} — handler declared as a value; cannot be verified, allow-list it with a reason or use a function`);
        }
      }
    }
    expect(handlersSeen).toBeGreaterThanOrEqual(3); // invoice PUT + GET, audit-packet GET
    expect(failures).toEqual([]);
  });

  test("the route allow-list is exactly the Better Auth catch-all, and that file holds nothing but the delegation", () => {
    expect(Object.keys(ROUTE_ALLOWLIST)).toEqual(["app/api/auth/[...all]/route.ts"]);
    const file = path.join(REPO_ROOT, "app/api/auth/[...all]/route.ts");
    const code = stripComments(readFileSync(file, "utf-8"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("import "));
    expect(code).toEqual([ROUTE_ALLOWLIST_PINNED_BODY]);
  });

  test("the owner-only routes stay owner-only, and the invoice upload stays owner+manager", () => {
    const rolesOf = (file: string, method: string) => {
      const fn = parseModule(readFileSync(path.join(REPO_ROOT, file), "utf-8")).functions.find(
        (f) => f.name === method,
      )!;
      return authCallOf(fn)?.roles;
    };
    expect(rolesOf("app/api/invoices/[id]/file/route.ts", "GET")).toEqual(["owner"]);
    expect(rolesOf("app/api/audit-packets/[id]/route.ts", "GET")).toEqual(["owner"]);
    expect(rolesOf("app/api/invoices/[id]/file/route.ts", "PUT")).toEqual(["owner", "manager"]);
  });
});
