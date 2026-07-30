/**
 * `newWriteId` — the generator behind `clientLineId`.
 *
 * This is a pure-function test and needs no database, but it earns its place:
 * the function is the idempotency mechanism's entire source of uniqueness, and
 * it had a latent dependency on a secure context that made the counting app
 * unusable on the only device it can actually be tested on. A LAN origin is
 * plain http, `crypto.randomUUID` is secure-context only, and the first real
 * count on a phone died at the first save.
 *
 * The insecure-context branch is therefore not a curiosity — it is the branch
 * that runs during every phone test this project will ever do, and it is the
 * one no browser on this machine exercises by default.
 *
 * Validated with the SAME `z.uuid()` the server gates on rather than a regex
 * invented here. A hand-assembled UUID that this file's own regex likes and
 * Zod rejects would pass a green test and fail every write.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import { newWriteId } from "@/lib/count-queue";

const uuid = z.uuid();

/**
 * `randomUUID` lives on `Crypto.prototype`, so it cannot be deleted off the
 * instance. Shadowing it with an own property of `undefined` is what an
 * insecure context actually looks like to the `typeof` check; deleting the own
 * property afterwards lets the prototype's implementation show through again.
 */
function withoutRandomUUID<T>(fn: () => T): T {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  }
}

afterEach(() => {
  delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
});

describe("newWriteId", () => {
  test("native path returns an id the server's z.uuid() accepts", () => {
    expect(typeof crypto.randomUUID).toBe("function");
    expect(uuid.safeParse(newWriteId()).success).toBe(true);
  });

  test("insecure context (no crypto.randomUUID) still returns a valid UUID", () => {
    const id = withoutRandomUUID(() => {
      // The precondition this whole branch exists for. If this ever fails the
      // test is no longer testing the phone's environment.
      expect(typeof crypto.randomUUID).not.toBe("function");
      return newWriteId();
    });
    expect(uuid.safeParse(id).success).toBe(true);
  });

  test("the fallback sets the v4 version and variant bits", () => {
    const id = withoutRandomUUID(newWriteId);
    // xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    expect(id[14]).toBe("4");
    expect("89ab").toContain(id[19]);
  });

  test("the fallback does not collide across a count's worth of writes", () => {
    // A busy count is ~150 writes; 20k is three orders of magnitude of margin.
    // A collision here would not throw — the ledger's unique index would treat
    // the second write as a replay and silently drop a real scan.
    const ids = withoutRandomUUID(() => new Set(Array.from({ length: 20_000 }, newWriteId)));
    expect(ids.size).toBe(20_000);
  });

  test("the fallback is not a fixed-length-hex bug: no id is malformed", () => {
    // Guards the padStart. Without it a byte < 0x10 renders as one nibble and
    // roughly 1 in 16 ids comes out a character short — which z.uuid() catches,
    // but only on the unlucky ones, so a single-sample test would pass ~94% of
    // the time and fail in the bar.
    const bad = withoutRandomUUID(() =>
      Array.from({ length: 5_000 }, newWriteId).filter((id) => !uuid.safeParse(id).success),
    );
    expect(bad).toEqual([]);
  });
});
