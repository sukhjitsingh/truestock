/**
 * Custom font-size tokens vs tailwind-merge.
 *
 * tailwind-merge's default config files an unknown `text-<name>` under text
 * COLOUR, so `cn("text-primary-foreground", "text-label")` kept only
 * `text-label` and dropped the colour. On the count screen that made the
 * primary buttons' labels (Add bottle / Update bottle / Remove) render in
 * inherited dark text on a near-white button: present, enabled, unreadable.
 * Nothing threw, and every status-code check passed.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { Button } from "@/components/ui/button";
import { cn, cnSized, FONT_SIZE_TOKENS } from "@/lib/utils";

function tokensDeclaredInCss(): string[] {
  const css = readFileSync(join(import.meta.dir, "..", "app/globals.css"), "utf8");
  const names = [...css.matchAll(/--text-([a-z0-9-]+):/g)].map((m) => m[1]);
  // `--text-label--line-height` and friends ride along with a size token; they
  // are not themselves utilities.
  return [...new Set(names.filter((n) => !n.includes("--")))];
}

describe("FONT_SIZE_TOKENS", () => {
  test("lists exactly the --text-* size tokens declared in globals.css", () => {
    // Widened to string[]: FONT_SIZE_TOKENS is a literal-union tuple, and the CSS
    // side is plain strings, so toEqual's typing would otherwise reject the pair.
    const listed: string[] = [...FONT_SIZE_TOKENS];
    expect(listed.sort()).toEqual(tokensDeclaredInCss().sort());
  });
});

describe("cnSized", () => {
  test("keeps a text colour next to a custom font-size token", () => {
    const merged = cnSized("text-primary-foreground", "text-label");
    expect(merged.split(" ").sort()).toEqual(["text-label", "text-primary-foreground"]);
  });

  test("still lets a later font size replace an earlier one", () => {
    expect(cnSized("text-label", "text-caption")).toBe("text-caption");
  });

  test("still lets a later colour replace an earlier one", () => {
    expect(cnSized("text-primary-foreground", "text-foreground")).toBe("text-foreground");
  });

  test("the plain cn() still has the bug — this is why Button must not use it", () => {
    // If this ever starts passing the other way, cn() was fixed globally and
    // cnSized can be folded back into it.
    expect(cn("text-primary-foreground", "text-label")).toBe("text-label");
  });
});

describe("Button", () => {
  test("a call site's text-label does not drop the variant's text colour", () => {
    for (const [variant, colour] of [
      ["primary", "text-primary-foreground"],
      ["accent", "text-accent-foreground"],
      ["destructive", "text-destructive-foreground"],
    ] as const) {
      const html = renderToString(
        React.createElement(Button, { variant, className: "w-full text-label uppercase" }, "Go"),
      );
      expect(html).toContain(colour);
      expect(html).toContain("text-label");
    }
  });
});
