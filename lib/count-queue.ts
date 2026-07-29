"use client";

import { openDB, type IDBPDatabase } from "idb";

/**
 * The pending-write queue for count lines (spec §11 "Connectivity — light
 * insurance, not an architecture").
 *
 * This is a BUFFER, never a source of truth. The server stays authoritative:
 * the queue exists so a dropped access point in the walk-in doesn't lose the
 * last four bottles someone counted, not so the app can run offline.
 *
 * ---------------------------------------------------------------------------
 * The idempotency rule this file exists to enforce
 * ---------------------------------------------------------------------------
 * `clientLineId` is minted ONCE PER WRITE ATTEMPT — here, at enqueue time,
 * the moment the human does something — and is then reused for every retry of
 * *that same* write. That is the whole contract:
 *
 *   - Fresh id per action  → scanning the same bottle twice is two writes with
 *                            two ids, and both increments land.
 *   - Same id on retry     → a resend after a timeout hits the unique index on
 *                            `count_line_write.client_line_id`, rolls back, and
 *                            returns success instead of double-counting.
 *
 * The failure mode of getting this wrong is silent in both directions, which
 * is why the id lives on the queue record rather than being generated at call
 * time. One id per count *line* (the tempting simplification) would make every
 * legitimate second scan of a bottle look like a retry of the first and be
 * swallowed as a no-op — the count comes out short, with no error anywhere.
 * See CLAUDE.md's working agreement on this.
 */

const DB_NAME = "truestock";
const DB_VERSION = 1;
const STORE = "pending_writes";

export type QueuedWriteKind = "scan" | "increment" | "set";

export interface QueuedWrite {
  /** IS the `clientLineId` sent to the server. Minted once, reused on retry. */
  id: string;
  kind: QueuedWriteKind;
  countId: number;
  /** The action payload, already shaped for its server action. */
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("countId", "countId");
          store.createIndex("createdAt", "createdAt");
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Generate a write id — the `clientLineId` that makes a write idempotent.
 *
 * `crypto.randomUUID` is SECURE-CONTEXT ONLY. That reads as a non-issue
 * because production is HTTPS, and it was written off as one here. It is not:
 * the counting screens cannot be exercised anywhere except a phone on the
 * LAN, and a LAN origin is plain http, so `crypto.randomUUID` is undefined
 * exactly where this app most needs testing. The first real count on a phone
 * died on `crypto.randomUUID is not a function` at the first save
 * (2026-07-28) — the whole write path was unreachable.
 *
 * `crypto.getRandomValues` is NOT secure-context gated, so the fallback is a
 * hand-assembled RFC 4122 v4 from the same CSPRNG. That distinction is
 * load-bearing and `Math.random()` would be a real bug, not a shortcut: this
 * id is the idempotency key, and the append-only ledger's unique index treats
 * a collision as a REPLAY — it rolls the write back and returns success. A
 * weak generator would therefore drop legitimate scans silently and the count
 * would just come out short, with no error anywhere. Predictability is not
 * the risk here; collision is.
 */
export function newWriteId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export async function enqueue(write: QueuedWrite): Promise<void> {
  const db = await getDb();
  await db.put(STORE, write);
}

export async function markAttempt(id: string, error?: string): Promise<void> {
  const db = await getDb();
  const existing = (await db.get(STORE, id)) as QueuedWrite | undefined;
  if (!existing) return;
  await db.put(STORE, {
    ...existing,
    attempts: existing.attempts + 1,
    lastError: error,
  });
}

export async function dequeue(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function pendingFor(countId: number): Promise<QueuedWrite[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(STORE, "countId", countId)) as QueuedWrite[];
  // Oldest first: writes to the same line must replay in the order they were
  // made, or a SET followed by an ADD replays as an ADD followed by a SET and
  // silently lands on a different number.
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function pendingCount(countId: number): Promise<number> {
  return (await pendingFor(countId)).length;
}
