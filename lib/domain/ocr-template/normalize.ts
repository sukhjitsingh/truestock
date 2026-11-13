/**
 * Turns `@firecrawl/pdf-inspector`'s OCR markdown into one flat, whitespace-
 * normalised token stream. Pure and deterministic: the same markdown always
 * yields the same string, and the function never throws.
 *
 * Why a flat stream and not lines or table rows: the OCR output carries no
 * coordinates, and its LAYOUT is not stable — the same page came back as
 * 22, 19, 6 and 17 non-empty lines at 100/150/200/300 dpi, sometimes with
 * pipe tables, sometimes as headings. What IS stable across resolutions is
 * the content (the digits, the item codes, the `$` amounts). So templates
 * anchor on content in this stream and treat every line break, heading
 * marker and table pipe as the whitespace it is.
 *
 * What this deliberately does NOT do: it never "repairs" characters. No
 * O -> 0, l -> 1, S -> $, no dropping or inventing digits. A misread digit
 * must reach the arithmetic gate as the wrong number it is, not be quietly
 * corrected into a plausible one; the gate (`gate.ts`) exists to catch it.
 */

/** A row made only of table-rule characters, e.g. `|---|---|---|`. */
const TABLE_RULE_ROW = /^[\s|:-]*-[\s|:-]*$/;

export function normalizeOcrText(markdown: string): string {
  const withoutRules = markdown
    .split(/\r\n|\r|\n/)
    .filter((line) => !TABLE_RULE_ROW.test(line))
    .join(" ");

  return (
    withoutRules
      // Markdown structure: heading hashes, table pipes, emphasis stars.
      .replace(/[#|*]/g, " ")
      // Typographic quotes -> ASCII, so a template never needs both spellings.
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„]/g, '"')
      // Bullets are layout, not content.
      .replace(/[•‣●▪◦·]/g, " ")
      // Minus sign and en/em dash -> hyphen-minus.
      .replace(/[−–—]/g, "-")
      // Full-width / small dollar signs -> `$`.
      .replace(/[＄﹩]/g, "$")
      // Accounting negatives: "($25.00)" -> "-$25.00". Requires the `$` so a
      // parenthesised quantity such as "(1)" is never read as a negative.
      .replace(/\(\s*-?\s*\$\s*(\d[\d,]*\.\d{2})\s*\)/g, (_match, amount: string) => `-$${amount}`)
      // "$ 17.00" -> "$17.00".
      .replace(/\$\s+(?=\d)/g, "$")
      // A digit glued to a money token ("1$17.00", "$25.00$25.00") is two
      // tokens; the OCR drops the column gutter on some scans.
      .replace(/(?<=\d)(?=-?\$)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
