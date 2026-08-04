/**
 * The re-scan guard for continuous (rapid) barcode scanning.
 *
 * Extracted from the scanner's detection loop for the same reason `db/csv.ts`
 * was extracted from the seed: the logic that decides whether a frame counts
 * is the part that can silently miscount an inventory, and it should be
 * testable without a camera, a WASM detector, or a DOM.
 *
 * The problem it solves: a detector reports a barcode on EVERY frame the
 * barcode is visible, roughly 60 times a second. Counting each report would
 * turn one bottle into dozens. But the naive fix — "ignore a repeat of the
 * same value" — is wrong in the other direction, because scanning three
 * identical bottles of Tito's in a row is a completely legitimate sequence
 * that must count three times.
 *
 * So the guard is about frame CONTINUITY, not about the value:
 *
 *   armed     a clear frame (no barcode at all) means the label left the
 *             view, so the next detection is a new presentation. This is the
 *             primary guard and it is what makes three identical bottles
 *             count three times.
 *   cooldown  a floor on the gap between accepted hits, covering the case
 *             where the detector drops a frame or two while the bottle has
 *             NOT moved. Without it a flicker would re-arm a stationary
 *             bottle. This is a backstop, not the main mechanism.
 *
 * Both conditions must hold. The bias is deliberate and one-directional:
 * this errs toward missing a scan rather than inventing one. A missed scan
 * is self-correcting because the counter sees no confirmation and scans
 * again; a phantom scan is silent and inflates the count, which is the
 * failure mode CLAUDE.md's invariants exist to prevent.
 */

/**
 * Floor between two accepted hits, in milliseconds.
 *
 * Sized to cover detector *flicker* and nothing more. The detector drops the
 * occasional frame while a bottle sits still, and a dropped frame looks
 * exactly like "the bottle left the view" to the `armed` flag. That gap is
 * one to a few frames — roughly 16–50ms at 60fps — so 250ms clears it with a
 * wide margin.
 *
 * It is deliberately NOT sized to the interval between two bottles. An
 * earlier draft used 900ms, which sounds safer and is worse: a steady sweep
 * of a Storeroom shelf presents a new bottle roughly every 700ms, so a 900ms
 * floor would refuse legitimate scans during exactly the fast counting this
 * mode exists for — and refuse them silently, leaving the count short with
 * nothing on screen looking wrong. `tests/rescan-guard.test.ts` pins the
 * sweep case for that reason.
 *
 * The division of labour matters: `armed` is the guard, this is the backstop.
 * Growing this number to fix a double-count would be treating the symptom and
 * would start eating real scans.
 */
export const RESCAN_COOLDOWN_MS = 250;

export interface RescanGuardState {
  /** False while a barcode is still in frame from the last accepted hit. */
  armed: boolean;
  /**
   * Timestamp of the last accepted hit, or null if none has happened yet.
   *
   * Null rather than 0 on purpose. A numeric zero is a real point on the
   * clock the caller passes in, so it cannot be told apart from "a hit
   * happened at time 0" — and with a timeline that starts at 0, the cooldown
   * then measures 0 - 0 and refuses the very first bottle of the session.
   * That is a one-unit shortfall with nothing on screen looking wrong, which
   * is the quietest way this mode could be wrong. `tests/rescan-guard.test.ts`
   * pins it via the sweep cases, which start at t=0 for exactly that reason.
   */
  lastHitAt: number | null;
}

export function createRescanGuard(): RescanGuardState {
  // Starts armed: the first barcode seen must count, with no clear frame
  // before it. A guard that started disarmed would swallow the first scan of
  // every session, which is exactly the kind of quiet off-by-one that makes a
  // count short with nothing on screen looking wrong.
  return { armed: true, lastHitAt: null };
}

/**
 * Feed one frame's result to the guard and get back whether it counts.
 *
 * `barcode` is null when the frame contained no barcode at all. Mutates and
 * returns the state so the caller can keep one object per scanner session.
 */
export function offerFrame(
  state: RescanGuardState,
  barcode: string | null,
  now: number,
  cooldownMs: number = RESCAN_COOLDOWN_MS,
): boolean {
  if (barcode === null) {
    state.armed = true;
    return false;
  }
  if (!state.armed) return false;
  // The cooldown only applies once there is a previous hit to measure from.
  if (state.lastHitAt !== null && now - state.lastHitAt <= cooldownMs) return false;

  state.armed = false;
  state.lastHitAt = now;
  return true;
}
