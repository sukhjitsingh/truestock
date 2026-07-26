/**
 * Shared MySQL error discrimination. Used everywhere this codebase needs to
 * tell "a unique constraint collided" apart from "something else went
 * wrong" — a real error must never be silently reinterpreted as a benign
 * race/replay. Keep this the single place that decision is made so every
 * caller (lib/domain/counts.ts, lib/domain/catalog.ts) applies the same
 * discipline: only mysql2 error code 1062 (`ER_DUP_ENTRY`) counts.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}
