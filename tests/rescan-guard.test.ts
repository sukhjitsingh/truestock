import { describe, it, expect } from "bun:test";
import {
  createRescanGuard,
  offerFrame,
  RESCAN_COOLDOWN_MS,
} from "@/lib/rescan-guard";

/**
 * The guard decides whether a detected frame counts as a scan. Getting it
 * wrong in either direction corrupts a count silently, so this covers both
 * directions rather than just the happy path:
 *
 *   too permissive -> one bottle held in frame becomes twenty units
 *   too strict     -> three identical bottles in a row count once
 *
 * No camera, no DOM, no detector: the guard is pure, which is why it was
 * pulled out of the scanner's effect in the first place.
 */

/** Feed a sequence of frames and return how many were accepted. */
function run(
  frames: Array<{ barcode: string | null; at: number }>,
  cooldown = RESCAN_COOLDOWN_MS,
): number {
  const guard = createRescanGuard();
  let accepted = 0;
  for (const f of frames) {
    if (offerFrame(guard, f.barcode, f.at, cooldown)) accepted++;
  }
  return accepted;
}

describe("rescan guard", () => {
  it("accepts the very first barcode it sees", () => {
    // Starting disarmed would swallow the first scan of every session.
    expect(run([{ barcode: "A", at: 1000 }])).toBe(1);
  });

  it("accepts a first barcode at t=0, where a zero sentinel would refuse it", () => {
    // Regression: `lastHitAt` was initialised to 0, which is a real point on
    // the caller's clock rather than "no hit yet". With a timeline starting
    // at 0 the cooldown measured 0 - 0 and silently ate the session's first
    // bottle. `performance.now()` and a test fixture both start at 0.
    expect(run([{ barcode: "A", at: 0 }])).toBe(1);
  });

  it("counts a bottle held in frame once, not once per frame", () => {
    // 60 frames of the same barcode, a second's worth at 60fps, with no
    // clear frame between them: the bottle never moved.
    const frames = Array.from({ length: 60 }, (_, i) => ({
      barcode: "A",
      at: 1000 + i * 16,
    }));
    expect(run(frames)).toBe(1);
  });

  it("counts three identical bottles as three when each leaves the frame", () => {
    // The case a naive "ignore duplicate values" guard gets wrong: three
    // sealed bottles of the same product is an ordinary shelf.
    const frames = [
      { barcode: "A", at: 1000 },
      { barcode: null, at: 1200 },
      { barcode: "A", at: 2000 },
      { barcode: null, at: 2200 },
      { barcode: "A", at: 3000 },
    ];
    expect(run(frames)).toBe(3);
  });

  it("does not re-arm on a dropped frame while the bottle sits still", () => {
    // The detector blinks for one frame. The bottle has not moved, so this
    // must not count twice — this is exactly what the cooldown is for, and
    // the gap here (32ms) is the realistic size of that blink.
    const frames = [
      { barcode: "A", at: 1000 },
      { barcode: null, at: 1016 }, // dropped frame, re-arms
      { barcode: "A", at: 1032 }, // still the same bottle
    ];
    expect(run(frames)).toBe(1);
  });

  it("requires BOTH a clear frame and the cooldown, not either one", () => {
    // Clear frame present, but well inside the cooldown: refused.
    expect(
      run([
        { barcode: "A", at: 1000 },
        { barcode: null, at: 1050 },
        { barcode: "A", at: 1100 },
      ]),
    ).toBe(1);

    // Cooldown satisfied, but the barcode never left the frame: refused.
    expect(
      run([
        { barcode: "A", at: 1000 },
        { barcode: "A", at: 5000 },
      ]),
    ).toBe(1);

    // Both satisfied: accepted.
    expect(
      run([
        { barcode: "A", at: 1000 },
        { barcode: null, at: 1100 },
        { barcode: "A", at: 5000 },
      ]),
    ).toBe(2);
  });

  it("treats a different barcode the same way — continuity, not value", () => {
    // Two different bottles swept past without a clear frame between them.
    // Refusing the second is the deliberate bias: a missed scan is visible
    // to the counter, an invented one is not.
    expect(
      run([
        { barcode: "A", at: 1000 },
        { barcode: "B", at: 1016 },
      ]),
    ).toBe(1);

    // With a clear frame and the cooldown, both count.
    expect(
      run([
        { barcode: "A", at: 1000 },
        { barcode: null, at: 1100 },
        { barcode: "B", at: 2000 },
      ]),
    ).toBe(2);
  });

  it("never accepts a frame that contained no barcode", () => {
    expect(run([{ barcode: null, at: 1000 }, { barcode: null, at: 9000 }])).toBe(0);
  });

  it("a realistic shelf sweep counts exactly one per bottle", () => {
    // Twelve bottles, each lingering in frame for a few frames, with a gap
    // between them. This is the shape of an actual Storeroom leg, and it is
    // the case that caught a cooldown sized for the wrong problem: at 45
    // frames per bottle the sweep presents one every 720ms, so a 900ms floor
    // silently dropped every scan after the first.
    const frames: Array<{ barcode: string | null; at: number }> = [];
    let t = 0;
    for (let bottle = 0; bottle < 12; bottle++) {
      // Bottle enters and is detected across several frames.
      for (let f = 0; f < 5; f++) {
        frames.push({ barcode: `BC-${bottle}`, at: t });
        t += 16;
      }
      // Bottle leaves; empty frames while the next is brought up.
      for (let f = 0; f < 40; f++) {
        frames.push({ barcode: null, at: t });
        t += 16;
      }
    }
    expect(run(frames)).toBe(12);
  });

  it("a fast sweep still counts every bottle", () => {
    // Tighter than the sweep above: a new bottle every ~400ms. The guard
    // must not start eating scans as the counter speeds up, which is the
    // failure a too-large cooldown produces and the reason the constant is
    // sized to detector flicker rather than to bottle spacing.
    const frames: Array<{ barcode: string | null; at: number }> = [];
    let t = 0;
    for (let bottle = 0; bottle < 20; bottle++) {
      for (let f = 0; f < 3; f++) {
        frames.push({ barcode: `FAST-${bottle}`, at: t });
        t += 16;
      }
      for (let f = 0; f < 22; f++) {
        frames.push({ barcode: null, at: t });
        t += 16;
      }
    }
    expect(run(frames)).toBe(20);
  });

  it("is monotonic in time: a hit never moves lastHitAt backwards", () => {
    // Guards against a regression where an accepted hit forgets to stamp the
    // clock, which would make the cooldown a no-op from then on.
    const guard = createRescanGuard();
    expect(guard.lastHitAt).toBeNull(); // "no hit yet", distinct from t=0

    expect(offerFrame(guard, "A", 1000)).toBe(true);
    expect(guard.lastHitAt).toBe(1000);
    expect(guard.armed).toBe(false);

    offerFrame(guard, null, 1100);
    expect(guard.armed).toBe(true);
    expect(guard.lastHitAt).toBe(1000); // unchanged by a clear frame
  });
});
