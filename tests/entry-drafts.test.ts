/**
 * The pure decisions behind the counting screens' "don't silently lose input"
 * guards (lib/entry-drafts.ts). Component behaviour is covered by the browser
 * harnesses; what is pinned here is every branch of the rules they rely on.
 */
import { describe, test, expect } from "bun:test";
import {
  hasUnsavedFillDraft,
  hasUnsavedQuantity,
  pendingDraftValue,
  afterSave,
  canSubmitCount,
  saveStillApplies,
} from "@/lib/entry-drafts";

describe("hasUnsavedFillDraft", () => {
  test("no level picked and nothing staged is clean", () => {
    expect(hasUnsavedFillDraft(null, false)).toBe(false);
  });

  test("a picked level that was not added is unsaved", () => {
    expect(hasUnsavedFillDraft(0.5, false)).toBe(true);
    expect(hasUnsavedFillDraft(1, false)).toBe(true);
  });

  test("Empty (0) is a real level, not 'nothing' — it must not read as clean", () => {
    // `if (draftValue)` would treat 0 as absent and let an Empty bottle vanish.
    expect(hasUnsavedFillDraft(0, false)).toBe(true);
  });

  test("bottles staged but not saved are unsaved even with no level picked", () => {
    // Half -> "+ Add bottle to line" clears the draft and leaves only this.
    expect(hasUnsavedFillDraft(null, true)).toBe(true);
  });

  test("both at once is unsaved", () => {
    expect(hasUnsavedFillDraft(0.3, true)).toBe(true);
  });
});

describe("pendingDraftValue", () => {
  test("nothing picked is no draft", () => {
    expect(pendingDraftValue(null, null, [0.5])).toBeNull();
    expect(pendingDraftValue(null, 0, [0.5])).toBeNull();
  });

  test("a level picked for a NEW bottle is a draft", () => {
    expect(pendingDraftValue(0.5, null, [])).toBe(0.5);
    expect(pendingDraftValue(0, null, [0.5])).toBe(0); // Empty is a real level
  });

  test("tapping an existing bottle's chip loads its own level — not a draft", () => {
    expect(pendingDraftValue(0.3, 1, [0.8, 0.3])).toBeNull();
  });

  test("moving the loaded level away from the staged one is a draft", () => {
    expect(pendingDraftValue(0.6, 1, [0.8, 0.3])).toBe(0.6);
  });

  test("an index past the list does not read as 'equal'", () => {
    expect(pendingDraftValue(0.4, 5, [0.8])).toBe(0.4);
  });
});

describe("hasUnsavedQuantity", () => {
  const base = { initialCases: 2, initialEaches: 5 };

  describe("add mode (inputs start from zero)", () => {
    test("all zero is clean, whatever the line already holds", () => {
      expect(hasUnsavedQuantity({ mode: "add", cases: 0, eaches: 0, ...base })).toBe(false);
    });

    test("eaches only is unsaved", () => {
      expect(hasUnsavedQuantity({ mode: "add", cases: 0, eaches: 3, ...base })).toBe(true);
    });

    test("cases only is unsaved", () => {
      expect(hasUnsavedQuantity({ mode: "add", cases: 1, eaches: 0, ...base })).toBe(true);
    });

    test("both is unsaved", () => {
      expect(hasUnsavedQuantity({ mode: "add", cases: 1, eaches: 1, ...base })).toBe(true);
    });

    test("typing the line's own numbers in ADD is still a change (it adds them)", () => {
      expect(hasUnsavedQuantity({ mode: "add", cases: 2, eaches: 5, ...base })).toBe(true);
    });
  });

  describe("set mode (inputs start from the recorded numbers)", () => {
    test("equal to the recorded numbers is clean — an untouched editor is not a draft", () => {
      expect(hasUnsavedQuantity({ mode: "set", cases: 2, eaches: 5, ...base })).toBe(false);
    });

    test("zeroes are NOT clean in set mode when the line holds something", () => {
      expect(hasUnsavedQuantity({ mode: "set", cases: 0, eaches: 0, ...base })).toBe(true);
    });

    test("a changed eaches value is unsaved", () => {
      expect(hasUnsavedQuantity({ mode: "set", cases: 2, eaches: 6, ...base })).toBe(true);
    });

    test("a changed cases value is unsaved", () => {
      expect(hasUnsavedQuantity({ mode: "set", cases: 3, eaches: 5, ...base })).toBe(true);
    });

    test("an empty line: zeroes equal the recorded numbers and are clean", () => {
      expect(
        hasUnsavedQuantity({
          mode: "set",
          cases: 0,
          eaches: 0,
          initialCases: 0,
          initialEaches: 0,
        }),
      ).toBe(false);
    });
  });
});

describe("afterSave", () => {
  test("leaves when the other editor is clean", () => {
    expect(afterSave({ otherDirty: false })).toBe("leave");
  });

  test("stays when the other editor holds unsaved input", () => {
    expect(afterSave({ otherDirty: true })).toBe("stay");
  });
});

describe("saveStillApplies", () => {
  test("applies while the entry screen the save started on is still current", () => {
    expect(saveStillApplies(4, 4)).toBe(true);
  });

  test("does not apply once the counter moved to another phase", () => {
    // Back -> Discard bumps the session; scanning another product bumps it again.
    expect(saveStillApplies(4, 5)).toBe(false);
    expect(saveStillApplies(4, 6)).toBe(false);
  });
});

describe("canSubmitCount", () => {
  test("nothing queued -> ok", () => {
    expect(canSubmitCount(0)).toEqual({ ok: true });
  });

  test("a negative count (should be impossible) fails open rather than blocking", () => {
    expect(canSubmitCount(-1)).toEqual({ ok: true });
  });

  test("one queued save refuses, in the singular, naming the count", () => {
    const r = canSubmitCount(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("1 save hasn't synced yet");
      expect(r.message).not.toContain("saves");
    }
  });

  test("many queued saves refuse, naming the count", () => {
    const r = canSubmitCount(12);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("12 saves haven't synced yet");
  });

  test("the message tells the counter what to do next", () => {
    const r = canSubmitCount(3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Keep counting");
      expect(r.message).toContain("sync indicator");
    }
  });
});
