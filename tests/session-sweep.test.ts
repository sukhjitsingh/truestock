/**
 * Session sweep (#1b, docs/open-items.md) — `sweepExpiredSessions`.
 *
 * `session` is one of exactly two tables AGENTS.md's invariant 9 excepts
 * from per-organization scoping (`user.email` is the other). These tests
 * prove both halves of that: expired rows are deleted regardless of which
 * organization their user belongs to, and the batch-limit guard actually
 * bounds a single call rather than being decorative.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { db, closePool } from "@/db";
import { session } from "@/db/schema";
import { sweepExpiredSessions } from "@/lib/domain/sessions";
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

/** Inserts a session row for `userId`, `minutesFromNow` in the future (negative = already expired). */
async function insertSession(userId: number, minutesFromNow: number): Promise<void> {
  await db.insert(session).values({
    token: crypto.randomUUID(),
    userId,
    expiresAt: new Date(Date.now() + minutesFromNow * 60_000),
  });
}

async function countSessions(): Promise<number> {
  const rows = await db.select({ id: session.id }).from(session);
  return rows.length;
}

describe("sweepExpiredSessions", () => {
  test("deletes only rows whose expires_at is in the past, leaving a future-expiring session untouched", async () => {
    await insertSession(fx.owner.userId, -60); // expired an hour ago
    await insertSession(fx.owner.userId, 60); // expires an hour from now

    const result = await sweepExpiredSessions(new Date());

    expect(result.deletedCount).toBe(1);
    const remaining = await db.select({ userId: session.userId }).from(session);
    expect(remaining).toHaveLength(1);
  });

  test("respects its batch size — batchSize: 2 against 5 expired rows deletes exactly 2", async () => {
    for (let i = 0; i < 5; i++) {
      await insertSession(fx.owner.userId, -10);
    }

    const result = await sweepExpiredSessions(new Date(), 2);

    expect(result.deletedCount).toBe(2);
    expect(await countSessions()).toBe(3);
  });

  test("is not scoped to organization — a second tenant's expired session is deleted too", async () => {
    await insertSession(fx.owner.userId, -10); // org A
    await insertSession(fx.otherOwner.userId, -10); // org B — the deliberate exception (invariant 9)

    const result = await sweepExpiredSessions(new Date());

    expect(result.deletedCount).toBe(2);
    expect(await countSessions()).toBe(0);
  });
});
