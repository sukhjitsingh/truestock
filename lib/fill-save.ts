/**
 * What a "Save fill levels" tap should actually send to the server.
 *
 * `FillEntry` edits the WHOLE open-bottle list for a line: it is seeded with the
 * line's existing fills and hands back the full array. The server has two write
 * shapes for fills and they mean different things:
 *
 *   - `increment` with `newPartialFills` APPENDS those fills, and is recorded
 *     in the `count_line_write` ledger under a fresh `client_line_id`. Safe to
 *     retry, safe to replay.
 *   - `editCountLineFillsAction` REPLACES the list, is NOT ledgered, and needs a
 *     server-side `countLineId`.
 *
 * Sending the whole array through the append shape therefore double-counts every
 * bottle already on the line (`[0.3]` + save `[0.3, 0.8]` becomes `[0.3, 0.3,
 * 0.8]`), and nothing on screen looks wrong afterward. So the caller classifies
 * the edit first:
 *
 *   - `none`    — nothing changed; send nothing.
 *   - `append`  — the existing fills are an unchanged prefix and bottles were
 *                 added; send ONLY the added ones through the ledgered path.
 *   - `replace` — a bottle was changed or removed; that cannot be expressed as an
 *                 append and needs the REPLACE write.
 *
 * Levels are compared with a tolerance. They are tenths that pass through
 * `Math.round(v * 10) / 10` and through the server's decimal column, so strict
 * `===` on floats would misread an untouched bottle as an edit.
 */
const EPSILON = 1e-6;

const same = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON;

export type FillSavePlan =
  | { kind: "none" }
  | { kind: "append"; added: number[] }
  | { kind: "replace"; fills: number[] };

export function fillsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => same(v, b[i]));
}

export function planFillSave(
  existing: readonly number[],
  next: readonly number[],
): FillSavePlan {
  if (fillsEqual(existing, next)) return { kind: "none" };
  if (next.length > existing.length && existing.every((v, i) => same(v, next[i]))) {
    return { kind: "append", added: next.slice(existing.length) };
  }
  return { kind: "replace", fills: [...next] };
}
