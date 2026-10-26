/**
 * Filled-button label colours must be readable on their fill, in both themes.
 *
 * The count app is always dark, and its destructive button shipped as white on
 * `#f87171` — 2.77:1, below the 4.5:1 AA floor — which no test, build step or
 * status code notices: the page renders, the button works, the label is just
 * hard to read in a dim bar. This reads the real tokens out of `globals.css`
 * instead of restating them, so changing a colour re-runs the check.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "app/globals.css"), "utf8");

/** The `--name: #hex` declarations in the first top-level block for `selector`. */
function tokens(selector: ":root" | ".dark"): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in globals.css`);
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const FILLED = [
  ["destructive", "destructive-foreground"],
  ["primary", "primary-foreground"],
  ["accent", "accent-foreground"],
] as const;

describe("filled-button label contrast", () => {
  for (const selector of [":root", ".dark"] as const) {
    const t = tokens(selector);
    for (const [fill, ink] of FILLED) {
      test(`${selector}: ${ink} on ${fill} is at least 4.5:1`, () => {
        expect(t[fill]).toBeDefined();
        expect(t[ink]).toBeDefined();
        expect(contrast(t[fill], t[ink])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("the helper reproduces the measured failure: white on #f87171 is 2.77:1", () => {
    // Control for the assertions above — if this drifts, the maths is wrong,
    // not the palette.
    expect(contrast("#f87171", "#ffffff")).toBeCloseTo(2.77, 1);
  });
});
