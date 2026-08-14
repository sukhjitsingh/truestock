#!/usr/bin/env node
/**
 * Generates prototypes/tokens.css FROM app/globals.css.
 *
 * Why this exists (docs/plans/phase-2-ui-redesign/ui-audit.md, P2.7):
 * the eleven prototype HTML files each hand-carried their own copy of the
 * design tokens (colors, radius, spacing, type scale, font stack) and all
 * eleven had independently drifted from app/globals.css and from each
 * other — different letter-spacing, different rounded-full radius (999px
 * vs 9999px), a font stack with "Inter" that appears nowhere else. Rather
 * than reconcile eleven copies by hand (which just recreates the same
 * failure mode next time a token changes), this script parses the one
 * real token file and regenerates a single shared stylesheet that every
 * prototype links to.
 *
 * Run: `node prototypes/generate-tokens.mjs` from the repo root (or from
 * prototypes/ — the script locates app/globals.css relative to itself).
 * No dependencies beyond Node's stdlib.
 *
 * This script is NOT part of the app build. It never runs in CI or at
 * request time; it is a one-off generator you re-run by hand after
 * touching app/globals.css, the same way you would after touching any
 * other source of truth. prototypes/tokens.css is the checked-in output —
 * the HTML files reference that file directly, not this script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, "..", "app", "globals.css");
const OUTPUT_PATH = join(__dirname, "tokens.css");

const source = readFileSync(SOURCE_PATH, "utf8");

/** Returns the text strictly inside the first `${selector} {` ... matching `}`. */
function extractBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Could not find selector "${selector}" in ${SOURCE_PATH}`);
  const braceOpen = css.indexOf("{", start);
  let depth = 1;
  let i = braceOpen + 1;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return css.slice(braceOpen + 1, i - 1);
}

/** Extracts `--name: value;` declarations from a block of CSS text.
 *  Skips declarations with an empty/owed value (e.g. `--chart-2: /* owed *\/ ;`). */
function extractDeclarations(blockText) {
  const withoutComments = blockText.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = new Map();
  const re = /--([\w-]+)\s*:\s*([^;]*);/g;
  let m;
  while ((m = re.exec(withoutComments))) {
    const name = m[1];
    const value = m[2].trim();
    if (value.length === 0) continue; // owed / not yet computed — never emit
    decls.set(name, value);
  }
  return decls;
}

const rootBlock = extractBlock(source, ":root");
const darkBlock = extractBlock(source, ".dark");
const themeBlock = extractBlock(source, "@theme inline");

const rootDecls = extractDeclarations(rootBlock);
const darkDecls = extractDeclarations(darkBlock);
const themeDecls = extractDeclarations(themeBlock);

// ---- Color tokens: every --name in :root that is a real hex/color value
// (i.e. not --radius, which lives in the "shape" section of :root but is
// a size, not a color). Emitted in source order for a stable diff.
const COLOR_NAMES = [
  "background", "foreground",
  "card", "card-foreground",
  "popover", "popover-foreground",
  "primary", "primary-foreground",
  "secondary", "secondary-foreground",
  "muted", "muted-foreground",
  "accent", "accent-foreground",
  "destructive", "destructive-foreground",
  "success", "success-bg",
  "warning", "warning-bg",
  "negative", "negative-bg",
  "border", "input", "ring",
  "header", "header-foreground",
];

function requireDecl(decls, name, where) {
  const v = decls.get(name);
  if (v === undefined) throw new Error(`Missing --${name} in ${where} block of ${SOURCE_PATH}`);
  return v;
}

const lightColors = COLOR_NAMES.map((n) => [n, requireDecl(rootDecls, n, ":root")]);
const darkColors = COLOR_NAMES.map((n) => [n, requireDecl(darkDecls, n, ".dark")]);

const radiusBase = requireDecl(rootDecls, "radius", ":root");

// ---- Spacing tokens: from the @theme inline block's --spacing-* keys.
// Re-exposed under the bare names the prototypes already use
// (--card-gap, not --spacing-card-gap) since these files predate Tailwind's
// @theme naming convention and there is no build step to translate one into
// the other for them.
const SPACING_MAP = [
  ["card-gap", "spacing-card-gap"],
  ["card-pad", "spacing-card-pad"],
  ["bar-pad", "spacing-bar-pad"],
  ["section-gap", "spacing-section-gap"],
  ["tap-min", "spacing-tap-min"],
  ["tap-primary", "spacing-tap-primary"],
  ["action-bar", "spacing-action-bar"],
  ["row-office", "spacing-row-office"],
];
const spacingTokens = SPACING_MAP.map(([shortName, themeName]) => [
  shortName,
  requireDecl(themeDecls, themeName, "@theme inline"),
]);

// Safe-area insets reference --bar-pad internally in app/globals.css via
// var(--spacing-bar-pad); rewrite that reference to the bare --bar-pad name
// used in this file so the value still tracks the real token.
const safeBottomRaw = requireDecl(themeDecls, "spacing-safe-bottom", "@theme inline");
const safeTopRaw = requireDecl(themeDecls, "spacing-safe-top", "@theme inline");
const safeBottom = safeBottomRaw.replace(/var\(--spacing-bar-pad\)/g, "var(--bar-pad)");
const safeTop = safeTopRaw;

// ---- Type scale: --text-NAME plus its --text-NAME--line-height /
// --font-weight / --letter-spacing companions, re-exposed as the
// .text-NAME utility classes every prototype hand-rolls today.
const TYPE_SCALE_ORDER = [
  "numeral-lg", "header-title", "numeral-md", "row-title", "numeral-sm",
  "row-subtitle", "body", "screen-title", "caption", "label",
];
function typeScaleRule(name) {
  const size = requireDecl(themeDecls, `text-${name}`, "@theme inline");
  const lineHeight = themeDecls.get(`text-${name}--line-height`);
  const weight = themeDecls.get(`text-${name}--font-weight`);
  const tracking = themeDecls.get(`text-${name}--letter-spacing`);
  const props = [`font-size: ${size};`];
  if (lineHeight) props.push(`line-height: ${lineHeight};`);
  if (weight) props.push(`font-weight: ${weight};`);
  if (tracking) props.push(`letter-spacing: ${tracking};`);
  return `.text-${name} { ${props.join(" ")} }`;
}

const generatedAt = new Date().toISOString().slice(0, 10);

const css = `/*
 * prototypes/tokens.css — GENERATED FILE. Do not hand-edit.
 *
 * Produced by \`node prototypes/generate-tokens.mjs\` from app/globals.css.
 * Every prototype HTML file links this stylesheet instead of carrying its
 * own copy of the token set, so a future token change in app/globals.css
 * propagates here by re-running the generator instead of by re-drifting
 * eleven files one at a time (docs/plans/phase-2-ui-redesign/ui-audit.md,
 * P2.7). See docs/design-system.md for what each token means.
 *
 * Regenerate after touching app/globals.css:
 *   node prototypes/generate-tokens.mjs
 *
 * Generated ${generatedAt}.
 */

:root {
  --radius: ${radiusBase};
${lightColors.map(([n, v]) => `  --${n}: ${v};`).join("\n")}

  /* radius scale — shadcn calc-from-base convention, mirrors app/globals.css
     @theme inline. --radius-full is NOT in app/globals.css (Tailwind's own
     \`rounded-full\` utility needs no token) but the prototypes have no
     Tailwind, so it is named here to stop the 999px/9999px split the audit
     found between the counting app and everything else. */
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-full: 9999px;

  /* spacing — bare names, re-exposed from app/globals.css's --spacing-* keys */
${spacingTokens.map(([n, v]) => `  --${n}: ${v};`).join("\n")}
  --safe-top: ${safeTop};
  --safe-bottom: ${safeBottom};

  /* font stack — app/globals.css uses next/font CSS vars (--font-geist-sans)
     that only exist inside the Next.js app; these prototypes are static
     files opened with no build step and no network fetch, so they fall
     back to the OS system-UI stack instead. This is the one token in this
     file that is not literally copied from app/globals.css for that reason —
     every prototype used to invent its own slightly different fallback
     stack (one included "Inter", which ships nowhere else); this is the
     single agreed value. */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

.dark {
${darkColors.map(([n, v]) => `  --${n}: ${v};`).join("\n")}
}

/* ===================================================================
   RESET + BASE — identical across all eleven files before this existed;
   now declared once.
   =================================================================== */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p, ol, ul { margin: 0; padding: 0; list-style: none; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: none; }
a { color: inherit; text-decoration: none; }
svg { display: block; }
table { border-collapse: collapse; width: 100%; }

a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible,
textarea:focus-visible, [role="button"]:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

/* Numeric column alignment — mirrors app/globals.css's \`.num\` utility.
   Right-align only; tabular-nums is already global on body above. */
.num { text-align: right; }

/* Screen-reader-only content — a real clip-based implementation, not the
   \`position:absolute; width:1px; height:1px; overflow:hidden\` hack a few
   prototypes hand-rolled inline, which stays in normal document flow and
   can be focused into view (ui-audit.md P1.4). */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ===================================================================
   TYPE SCALE — mirrors the --text-* theme keys in app/globals.css.
   Sentence case in source, this class only adds size/weight/leading —
   pair with the .uppercase utility for label/screen-title copy
   (docs/design-system.md §4, ui-spec-mobile.md §12: never hardcode
   literal caps in HTML).
   =================================================================== */
${TYPE_SCALE_ORDER.map(typeScaleRule).join("\n")}
.uppercase { text-transform: uppercase; }
.tabular-nums { font-variant-numeric: tabular-nums; }

/* ===================================================================
   COLOR TEXT UTILITIES — the type-scale classes above never bake in a
   color (matching app/globals.css: size/weight/leading only); several
   prototypes previously baked --muted-foreground straight into
   .text-row-subtitle / .text-caption instead of pairing a color utility
   in markup, which is how six of the eleven files ended up with a type
   scale that silently disagreed with the other five. These are the
   color utilities every file already needs somewhere.
   =================================================================== */
.text-foreground { color: var(--foreground); }
.text-card-foreground { color: var(--card-foreground); }
.text-muted-foreground { color: var(--muted-foreground); }
.text-accent { color: var(--accent); }
.text-success { color: var(--success); }
.text-warning { color: var(--warning); }
.text-negative { color: var(--negative); }
`;

writeFileSync(OUTPUT_PATH, css, "utf8");
console.log(`Wrote ${OUTPUT_PATH}`);
