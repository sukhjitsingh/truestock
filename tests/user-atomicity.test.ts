/**
 * Deactivating a user must flip `user.active` AND delete that user's `session`
 * rows as ONE unit (lib/domain/users.ts `setUserActive`). tests/user-write-path
 * proves the happy path; this file proves the "one unit" part by making each
 * half fail in turn with a real database trigger, and proves the blast radius
 * stops at the target user.
 *
 * Guards AGENTS.md invariant 11 (deactivation revokes sessions in the SAME
 * transaction), invariant 6's mirror for users (deactivate, never delete) and
 * invariant 9 (a cross-tenant target is NotFound and leaves everything alone).
 *
 * Mutations that must turn this file red:
 *   - lib/domain/users.ts setUserActive: run the `update(user)` and the
 *     `delete(session)` on `db` instead of `tx` (or drop the transaction) —
 *     the "session delete fails" test then finds `active = false`, and the
 *     "user update fails" test finds the sessions gone.
 *   - lib/domain/users.ts setUserActive: delete the `if (!input.active)` branch
 *     (sessions survive deactivation) or widen the delete to all sessions in
 *     the organization / drop its `where` (the survivors tests).
 *   - lib/domain/users.ts setUserActive: delete sessions on ACTIVATION too.
 *
 * The trigger tests need the TRIGGER privilege on the test database. The
 * docker `truestock` user has ALL PRIVILEGES on truestock_test; if the grant is
 * ever narrowed those two tests are skipped with an explicit NOT VERIFIED label
 * (see `triggerTest`) rather than silently passing.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { db, closePool } from "@/db";
import { user, session } from "@/db/schema";
import { setUserActive } from "@/lib/domain/users";
import { DomainError, NotFoundError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
  // A run killed mid-test (Ctrl-C, a timeout, a Docker stall) skips the afterEach
  // below and leaves the triggers installed. TRUNCATE does not remove a trigger,
  // so the next run's session deletes — in this file and in every file after it
  // that deactivates a user — would fail with SQLSTATE 45000 and look like a
  // regression. Clear them before anything runs.
  await dropTriggers();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

async function addSession(userId: number, label = crypto.randomUUID()): Promise<void> {
  await db.insert(session).values({
    token: `atomicity-${label}`,
    userId,
    // Relative to now, never a calendar literal.
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

async function sessionCount(userId: number): Promise<number> {
  return (await db.select({ id: session.id }).from(session).where(eq(session.userId, userId))).length;
}

async function isActive(userId: number): Promise<boolean> {
  const [row] = await db.select({ active: user.active }).from(user).where(eq(user.id, userId));
  return row.active;
}

// ---------------------------------------------------------------------------
// Blast radius: only the target's sessions, only on deactivation
// ---------------------------------------------------------------------------

describe("setUserActive — what deactivation does and does not touch", () => {
  test("deactivating staff deletes ALL of staff's sessions and no one else's", async () => {
    await addSession(fx.staff.userId, "staff-phone");
    await addSession(fx.staff.userId, "staff-laptop");
    await addSession(fx.staff.userId, "staff-tablet");
    await addSession(fx.manager.userId); //     same org, different user
    await addSession(fx.owner.userId); //       the acting owner
    await addSession(fx.otherOwner.userId); //  a different tenant

    await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });

    expect(await isActive(fx.staff.userId)).toBe(false);
    expect(await sessionCount(fx.staff.userId)).toBe(0); // positive control: the revocation happened
    expect(await sessionCount(fx.manager.userId)).toBe(1);
    expect(await sessionCount(fx.owner.userId)).toBe(1);
    expect(await sessionCount(fx.otherOwner.userId)).toBe(1);
    // ...and nobody else was deactivated.
    expect(await isActive(fx.manager.userId)).toBe(true);
    expect(await isActive(fx.owner.userId)).toBe(true);
  });

  test("the row is kept: deactivation never deletes the user (history references them)", async () => {
    await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });
    const rows = await db.select().from(user).where(eq(user.id, fx.staff.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
  });

  test("re-activating an already-active user is a harmless no-op that leaves their sessions alone", async () => {
    await addSession(fx.manager.userId, "m1");
    await addSession(fx.manager.userId, "m2");
    expect(await isActive(fx.manager.userId)).toBe(true);

    await expect(setUserActive(fx.owner, { userId: fx.manager.userId, active: true })).resolves.toBeUndefined();

    expect(await isActive(fx.manager.userId)).toBe(true);
    expect(await sessionCount(fx.manager.userId)).toBe(2);
  });

  test("deactivating an already-inactive user is harmless too, and sweeps any session minted after the fact", async () => {
    await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });
    await addSession(fx.staff.userId, "stray"); // a session row that appeared after deactivation

    await expect(setUserActive(fx.owner, { userId: fx.staff.userId, active: false })).resolves.toBeUndefined();

    expect(await isActive(fx.staff.userId)).toBe(false);
    expect(await sessionCount(fx.staff.userId)).toBe(0);
  });

  test("reactivation does not resurrect revoked sessions — the user must sign in again", async () => {
    await addSession(fx.staff.userId);
    await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });
    await setUserActive(fx.owner, { userId: fx.staff.userId, active: true });

    expect(await isActive(fx.staff.userId)).toBe(true);
    expect(await sessionCount(fx.staff.userId)).toBe(0);
  });

  test("refused deactivations change nothing: self, cross-tenant and last-owner all leave sessions intact", async () => {
    await addSession(fx.owner.userId);
    await addSession(fx.staff.userId);

    // Self.
    await expect(setUserActive(fx.owner, { userId: fx.owner.userId, active: false })).rejects.toThrow(DomainError);
    // Cross-tenant: the other owner cannot even learn that staff exists.
    await expect(setUserActive(fx.otherOwner, { userId: fx.staff.userId, active: false })).rejects.toThrow(
      NotFoundError,
    );
    // Last owner: with no OTHER active owner left, the owner may not be deactivated.
    await db.update(user).set({ role: "owner" }).where(eq(user.id, fx.manager.userId));
    await db.update(user).set({ active: false }).where(eq(user.id, fx.owner.userId));
    await expect(setUserActive(fx.owner, { userId: fx.manager.userId, active: false })).rejects.toMatchObject({
      code: "LAST_OWNER",
    });

    expect(await isActive(fx.staff.userId)).toBe(true);
    expect(await sessionCount(fx.staff.userId)).toBe(1);
    expect(await isActive(fx.manager.userId)).toBe(true);
    expect(await sessionCount(fx.owner.userId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: break each half with a real trigger and watch the other half roll back
// ---------------------------------------------------------------------------

/** Does the connecting user hold TRIGGER on the test database? Decided once, at load. */
async function canCreateTriggers(): Promise<boolean> {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) return false;
    const dbName = new URL(url).pathname.replace(/^\//, "").split("?")[0];
    const conn = await mysql.createConnection({ uri: url });
    try {
      const [rows] = await conn.query("SHOW GRANTS FOR CURRENT_USER()");
      const grants = (rows as Record<string, string>[]).map((r) => Object.values(r)[0]);
      return grants.some(
        (g) =>
          /ALL PRIVILEGES|\bTRIGGER\b/i.test(g) && (/ ON \*\.\* /.test(g) || g.includes(`\`${dbName}\`.*`)),
      );
    } finally {
      await conn.end();
    }
  } catch {
    return false;
  }
}

const hasTriggerPrivilege = await canCreateTriggers();
const triggerTest = hasTriggerPrivilege ? test : test.skip;
const TRIGGER_SKIP_NOTE = hasTriggerPrivilege
  ? ""
  : "NOT VERIFIED: needs TRIGGER privilege on the test database; this DB user lacks it. ";

const SESSION_TRIGGER = "zz_test_block_session_delete";
const USER_TRIGGER = "zz_test_block_user_deactivate";
const BLOCK_MESSAGE = "test: blocked by trigger";

/** DDL goes through its own connection so nothing lands on a random pooled one. */
async function withDdl<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL! });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

async function dropTriggers(): Promise<void> {
  if (!hasTriggerPrivilege) return;
  await withDdl(async (conn) => {
    await conn.query(`DROP TRIGGER IF EXISTS \`${SESSION_TRIGGER}\``);
    await conn.query(`DROP TRIGGER IF EXISTS \`${USER_TRIGGER}\``);
  });
}

async function leftoverTriggers(): Promise<string[]> {
  return withDdl(async (conn) => {
    const [rows] = await conn.query(
      "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'zz\\_test\\_%'",
    );
    return (rows as { name: string }[]).map((r) => r.name);
  });
}

/** The thrown error wraps the driver's; walk the cause chain looking for the trigger's own text. */
function causeChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

describe("setUserActive — atomicity (invariant 11)", () => {
  afterEach(async () => {
    // Unconditional, so a failed assertion can never leave a trigger behind to
    // poison the next test or the next file.
    await dropTriggers();
  });

  test("control: with no trigger installed the same call commits BOTH halves", async () => {
    // Without this, the two rollback tests below could be passing because the
    // call fails for some unrelated reason.
    await addSession(fx.staff.userId);
    await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });
    expect(await isActive(fx.staff.userId)).toBe(false);
    expect(await sessionCount(fx.staff.userId)).toBe(0);
  });

  triggerTest(
    `${TRIGGER_SKIP_NOTE}session delete fails -> the user.active update rolls back with it`,
    async () => {
      await addSession(fx.staff.userId, "a");
      await addSession(fx.staff.userId, "b");
      await addSession(fx.manager.userId);
      await withDdl((conn) =>
        conn.query(
          `CREATE TRIGGER \`${SESSION_TRIGGER}\` BEFORE DELETE ON \`session\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${BLOCK_MESSAGE}'`,
        ),
      );

      let thrown: unknown;
      try {
        await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });
      } catch (err) {
        thrown = err;
      }

      // It failed, and it failed BECAUSE of the trigger (not some unrelated error).
      expect(thrown).toBeDefined();
      expect(causeChain(thrown)).toContain(BLOCK_MESSAGE);
      // Neither half took effect.
      expect(await isActive(fx.staff.userId)).toBe(true);
      expect(await sessionCount(fx.staff.userId)).toBe(2);
      expect(await sessionCount(fx.manager.userId)).toBe(1);

      // Clean-up is verified, not assumed.
      await dropTriggers();
      expect(await leftoverTriggers()).toEqual([]);
    },
  );

  triggerTest(
    `${TRIGGER_SKIP_NOTE}user update fails -> no session is deleted (the order does not matter, both-or-neither does)`,
    async () => {
      await addSession(fx.staff.userId, "a");
      await addSession(fx.staff.userId, "b");
      await withDdl((conn) =>
        conn.query(
          `CREATE TRIGGER \`${USER_TRIGGER}\` BEFORE UPDATE ON \`user\` FOR EACH ROW BEGIN IF NEW.active = 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${BLOCK_MESSAGE}'; END IF; END`,
        ),
      );

      let thrown: unknown;
      try {
        await setUserActive(fx.owner, { userId: fx.staff.userId, active: false });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(causeChain(thrown)).toContain(BLOCK_MESSAGE);
      expect(await isActive(fx.staff.userId)).toBe(true);
      expect(await sessionCount(fx.staff.userId)).toBe(2);

      await dropTriggers();
      expect(await leftoverTriggers()).toEqual([]);
    },
  );

  test("no zz_test_ trigger is left on the database after this file's tests", async () => {
    if (!hasTriggerPrivilege) return; // reported as NOT VERIFIED above; nothing could have been installed
    expect(await leftoverTriggers()).toEqual([]);
  });
});
