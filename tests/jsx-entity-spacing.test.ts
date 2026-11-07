/**
 * Guard against words glued together by the build (docs/open-items.md #44).
 *
 * Next.js's SWC compiler (16.2.x) drops the LEADING space of a JSX text run
 * when that run (a) follows a tag or `{expression}`, (b) spans more than one
 * source line, and (c) contains an HTML entity such as `&rsquo;` or `&middot;`.
 * Standard JSX semantics keep the space; SWC does not. Established 2026-11-06
 * by compiling controlled snippets with Next's own `transform`:
 *
 *   `<b>x</b> count, and there isn&rsquo;t\n one.`  →  "count, and there isn’t one."
 *
 * while the same text on one line, or without the entity, or with a literal ’
 * instead of `&rsquo;`, keeps " count…". Trailing spaces are not affected.
 * It shipped as "closedcount, and there isn't one" on /office/reorder, and as
 * "0082000000013isn't" and "750 mlis the one…" on the enroll screens.
 *
 * The fix is an explicit `{" "}` after the tag or expression. This test fails on
 * any source that has the dangerous shape without it.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");

/** Every JSX text run in `source` that the compiler would strip a leading space from. */
function findGluedText(source: string, fileName = "probe.tsx"): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getFullText();
      const firstLine = text.split("\n")[0]!;
      const siblings = (node.parent as ts.JsxElement | ts.JsxFragment).children;
      const prev = siblings ? siblings[siblings.indexOf(node) - 1] : undefined;
      if (
        prev !== undefined &&
        !ts.isJsxText(prev) &&
        text.includes("\n") && // spans more than one line
        /&[A-Za-z0-9#]+;/.test(text) && // contains an HTML entity
        /^[ \t]+\S/.test(firstLine) // starts with a space that JSX would keep
      ) {
        found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: firstLine.trim().slice(0, 50) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

describe("the detector matches what the compiler actually does", () => {
  // Each case was compiled with Next's SWC transform on 2026-11-06; `glued`
  // records whether the leading space survived.
  const cases: [string, string, boolean][] = [
    ["multi-line + entity after a tag", "<p><b>x</b> count, isn&rsquo;t\n  one.</p>", true],
    ["entity on the second line", "<p><b>x</b> count, is\n  one, isn&rsquo;t it.</p>", true],
    ["&middot; counts too", "<p><b>x</b> count &middot; there\n  one.</p>", true],
    ["after an {expression}", "<p>{a} is the one you said it isn&rsquo;t.\n</p>", true],
    ["single line keeps it", "<p><b>x</b> count, isn&rsquo;t one.</p>", false],
    ["no entity keeps it", "<p><b>x</b> count, is\n  one.</p>", false],
    ["a literal ’ keeps it", "<p><b>x</b> count, isn’t\n  one.</p>", false],
    ['the {" "} fix', '<p><b>x</b>{" "}count, isn&rsquo;t\n  one.</p>', false],
    ["text that starts on the next line has no space to lose", "<p><b>x</b>\n  count, isn&rsquo;t\n  one.</p>", false],
  ];
  for (const [name, jsx, glued] of cases) {
    test(name, () => {
      expect(findGluedText(`export const C = () => ${jsx};`).length > 0).toBe(glued);
    });
  }
});

describe("no component renders glued words", () => {
  test("no JSX text run in app/ or components/ has the shape the compiler mangles", () => {
    const offenders = [...tsxFiles(join(ROOT, "app")), ...tsxFiles(join(ROOT, "components"))].flatMap((file) =>
      findGluedText(readFileSync(file, "utf8"), file).map(
        (f) => `${relative(ROOT, file)}:${f.line} — "${f.text}" (add {" "} before this text)`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
