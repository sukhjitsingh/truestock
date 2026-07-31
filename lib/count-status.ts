/**
 * The one definition of "can this count still be counted into?".
 *
 * This exists because the disagreement between layers *was* the bug. The
 * write path refused only `closed`; `SessionActions` removed "Keep counting"
 * once a count was submitted; the scan page redirected only on `closed`; and
 * the dashboard went on offering a submitted count a **Resume** button. Four
 * places, three different answers, and the one that decided what actually
 * happened to the data was the most permissive.
 *
 * Dependency-free on purpose: the domain layer, the server components and the
 * client components all import it, so no layer has to re-state the rule and
 * none of them can drift.
 *
 * Note what this is NOT. Invariant 1 is about `closed` and is absolute —
 * closed counts are immutable forever, corrections are new adjustment
 * records. This is the softer rule laid on top: a submitted or reviewed count
 * is not being counted right now, and reopening it is a deliberate act rather
 * than a side effect of someone reaching a URL.
 */

/** Statuses that still accept count-line writes. */
const WRITABLE = new Set(["draft", "in_progress"]);

export function isCountWritable(status: string): boolean {
  return WRITABLE.has(status);
}

/**
 * True when a count is finished being counted but not yet closed — i.e. it is
 * waiting on review or closing rather than on more scanning. Distinguished
 * from "not writable" because `closed` is also not writable and needs a
 * different thing said about it.
 */
export function isCountAwaitingClose(status: string): boolean {
  return status === "submitted" || status === "reviewed";
}
