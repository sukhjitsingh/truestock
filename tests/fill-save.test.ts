/**
 * `planFillSave` classifies a FillEntry save so the whole-list editor can never
 * re-send bottles already on the line through the additive, ledgered path.
 *
 * The regression this guards: FillEntry is seeded with `existingFills` and hands
 * back the full array. Sending that through `increment` appended it onto itself,
 * so a line holding [0.3] that gained one bottle became [0.3, 0.3, 0.8].
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { planFillSave, fillsEqual } from "@/lib/fill-save";
import { FillEntry } from "@/components/count/fill-entry";

describe("planFillSave", () => {
  test("no change sends nothing", () => {
    expect(planFillSave([0.3, 0.8], [0.3, 0.8])).toEqual({ kind: "none" });
    expect(planFillSave([], [])).toEqual({ kind: "none" });
  });

  test("an added bottle appends ONLY the added fills", () => {
    expect(planFillSave([0.3], [0.3, 0.8])).toEqual({ kind: "append", added: [0.8] });
    expect(planFillSave([0.3, 0.8], [0.3, 0.8, 0.5, 1])).toEqual({
      kind: "append",
      added: [0.5, 1],
    });
  });

  test("a first bottle on an empty line is an append of exactly that bottle", () => {
    expect(planFillSave([], [0.6])).toEqual({ kind: "append", added: [0.6] });
  });

  test("never re-sends fills already on the line (the double-count)", () => {
    const existing = [0.3, 0.8];
    const plan = planFillSave(existing, [...existing, 0.5]);
    expect(plan.kind).toBe("append");
    if (plan.kind === "append") {
      for (const v of existing) expect(plan.added).not.toContain(v);
    }
  });

  test("offline-then-reopen: optimistic fills already in `existing` are not re-sent", () => {
    // A first scan saved [0.4] while offline; it is queued, the line has no
    // server id yet, and reopening shows [0.4] from the optimistic state. Adding
    // another bottle must send only the new one.
    expect(planFillSave([0.4], [0.4, 0.9])).toEqual({ kind: "append", added: [0.9] });
  });

  test("changing a bottle is a replace", () => {
    expect(planFillSave([0.3, 0.8], [0.3, 0.7])).toEqual({ kind: "replace", fills: [0.3, 0.7] });
  });

  test("removing a bottle is a replace", () => {
    expect(planFillSave([0.3, 0.8], [0.3])).toEqual({ kind: "replace", fills: [0.3] });
    expect(planFillSave([0.3], [])).toEqual({ kind: "replace", fills: [] });
  });

  test("changing an early bottle while adding one is a replace, not an append", () => {
    expect(planFillSave([0.3], [0.4, 0.8])).toEqual({ kind: "replace", fills: [0.4, 0.8] });
  });

  test("reordering is a change", () => {
    expect(planFillSave([0.3, 0.8], [0.8, 0.3]).kind).toBe("replace");
  });

  test("float noise from the decimal column is not an edit", () => {
    expect(planFillSave([0.30000000004, 0.7999999999], [0.3, 0.8])).toEqual({ kind: "none" });
    expect(planFillSave([0.30000000004], [0.3, 0.8])).toEqual({ kind: "append", added: [0.8] });
  });

  test("does not mutate its inputs", () => {
    const existing = [0.3];
    const next = [0.3, 0.8];
    planFillSave(existing, next);
    expect(existing).toEqual([0.3]);
    expect(next).toEqual([0.3, 0.8]);
  });
});

describe("fillsEqual", () => {
  test("length and values must both match", () => {
    expect(fillsEqual([0.1], [0.1])).toBe(true);
    expect(fillsEqual([0.1], [0.1, 0.2])).toBe(false);
    expect(fillsEqual([0.1, 0.2], [0.2, 0.1])).toBe(false);
  });
});

describe("FillEntry initial render", () => {
  const render = (existingFills: number[]) =>
    renderToString(
      React.createElement(FillEntry, {
        productName: "Tito's",
        existingFills,
        onCancel: () => {},
      }),
    );

  test("has no preselected level: placeholder numeral and a disabled add button", () => {
    const html = render([]);
    expect(html).toContain("Tap a level below");
    expect(html).not.toContain("50%");
    // The add button exists but is disabled until a level is chosen.
    const add = html.match(/<button[^>]*>\s*\+ Add bottle to line\s*<\/button>/);
    expect(add).not.toBeNull();
    expect(add![0]).toContain("disabled");
  });

  test("Save is disabled until the list differs from the line's existing fills", () => {
    const html = render([0.3]);
    const save = html.match(/<button[^>]*>\s*<span[^>]*>Save fill levels<\/span>[\s\S]*?<\/button>/);
    expect(save).not.toBeNull();
    expect(save![0]).toContain("disabled");
  });
});
