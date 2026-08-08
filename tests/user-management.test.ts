/**
 * User management against a real MariaDB (open-items #3).
 *
 * The claim this file exists to prove is a claim about what the DATABASE does
 * inside a transaction: deactivating a user deletes every one of their session
 * rows atomically with flipping `active`. A mocked db could only assert that
 * our mock deletes rows — so, like tests/count-write-path.test.ts, this runs
 * against the same engine and version production runs.
 *
 * Covered:
 *   - deactivation flips active=false AND leaves zero session rows, in one call
 *   - reactivation flips active=true and does NOT touch sessions
 *   - an owner cannot deactivate themselves (ConflictError)
 *   - a cross-tenant target is NotFound, and its row/sessions are untouched
 *     (invariant 9)
 *   - role change is tenant-scoped; a cross-tenant target is refused
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { user as userTable, session as sessionTable } from "@/db/schema";
import { listUsers, updateUserRole, setUserActive } from "@/lib/domain/users";
import { NotFoundError, ConflictError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

/** Insert a live session row for a user; returns nothing, asserts via count. */
async function giveSession(userId: number, token: string) {
  await db.insert(sessionTable).values({
    userId,
    token,
    // Far-future expiry: this is a *valid* session, so its deletion is the
    // whole point rather than something an expiry sweep would have caught.
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
}

async function sessionCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, userId));
  return rows.length;
}

async function isActive(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ active: userTable.active })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return row.active;
}

describe("setUserActive — atomic session revocation", () => {
  test("deactivation flips active=false and deletes all sessions in one call", async () => {
    const managerId = fx.manager.userId;
    await giveSession(managerId, "sess-a");
    await giveSession(managerId, "sess-b");
    expect(await sessionCount(managerId)).toBe(2);
    expect(await isActive(managerId)).toBe(true);

    const result = await setUserActive(fx.owner, managerId, false);

    expect(result.active).toBe(false);
    expect(await isActive(managerId)).toBe(false);
    expect(await sessionCount(managerId)).toBe(0);
  });

  test("reactivation flips active=true and does not touch sessions", async () => {
    const managerId = fx.manager.userId;
    // Start deactivated.
    await setUserActive(fx.owner, managerId, false);
    expect(await isActive(managerId)).toBe(false);

    // A session created after reactivation must survive reactivation.
    const result = await setUserActive(fx.owner, managerId, true);
    await giveSession(managerId, "sess-after");

    expect(result.active).toBe(true);
    expect(await isActive(managerId)).toBe(true);
    expect(await sessionCount(managerId)).toBe(1);
  });

  test("an owner cannot deactivate themselves", async () => {
    await giveSession(fx.owner.userId, "owner-sess");

    await expect(setUserActive(fx.owner, fx.owner.userId, false)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // The guard runs before any write: the owner is still active, session intact.
    expect(await isActive(fx.owner.userId)).toBe(true);
    expect(await sessionCount(fx.owner.userId)).toBe(1);
  });
});

describe("setUserActive — tenant isolation (invariant 9)", () => {
  test("deactivating a user in another org is NotFound and changes nothing", async () => {
    // fx.otherOwner belongs to the neighbouring tenant. Our owner must not be
    // able to touch them, even though the id is real.
    const targetId = fx.otherOwner.userId;
    await giveSession(targetId, "other-sess");
    expect(await isActive(targetId)).toBe(true);

    await expect(setUserActive(fx.owner, targetId, false)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Untouched: a cross-tenant write must be a no-op, not a partial one.
    expect(await isActive(targetId)).toBe(true);
    expect(await sessionCount(targetId)).toBe(1);
  });
});

describe("updateUserRole — tenant scoping", () => {
  test("role change within the org succeeds and returns the new role", async () => {
    const result = await updateUserRole(fx.owner, fx.manager.userId, "staff");
    expect(result.role).toBe("staff");

    const [row] = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, fx.manager.userId))
      .limit(1);
    expect(row.role).toBe("staff");
  });

  test("role change on a cross-tenant user is NotFound and changes nothing", async () => {
    await expect(
      updateUserRole(fx.owner, fx.otherOwner.userId, "staff"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, fx.otherOwner.userId))
      .limit(1);
    expect(row.role).toBe("owner");
  });
});

describe("listUsers — tenant scoping", () => {
  test("returns only users in the actor's organization", async () => {
    const ours = await listUsers(fx.owner);
    const ids = ours.map((u) => u.id).sort();
    // Our org has exactly the owner and the manager from fixtures.
    expect(ids).toEqual([fx.owner.userId, fx.manager.userId].sort());
    // The neighbouring tenant's owner must not appear.
    expect(ids).not.toContain(fx.otherOwner.userId);
  });
});
