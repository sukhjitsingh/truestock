#!/usr/bin/env node
/**
 * Edit guards for Claude Code sessions in this repo (.claude/settings.json).
 *
 * Each rule below is a lesson this project already paid for once. Prose in
 * AGENTS.md is advisory; these make the cheapest of them deterministic, at
 * the moment the edit is made rather than in CI or on a phone weeks later.
 *
 *   node guard-edits.mjs pre   — PreToolUse: BLOCK the edit
 *     1. Editing a drizzle/*.sql migration that has already landed on
 *        origin/main (same rule as scripts/check-migrations-immutable.sh).
 *     2. Putting a Content-Security-Policy into next.config.ts — the CSP is
 *        served from middleware.ts with a per-request nonce, and a static one
 *        silently stops every page hydrating (AGENTS.md, "Config that must
 *        not drift").
 *
 *   node guard-edits.mjs post  — PostToolUse: WARN (the edit stays; Claude is told)
 *     3. A <form> with no method= (the GET-password leak).
 *     4. onClick on a <tr>/<TableRow> (row-level edit is a <button>).
 *     Checked against the whole file as written, so a partial Edit snippet
 *     cannot hide a tag. Static checks, not proofs: they catch the
 *     regression as it is typed. Heuristic on purpose — a warning, not a block.
 *
 * Fails open: any internal error exits 0 with no output, so a broken guard
 * never stops work. tests/edit-guards.test.ts pins every rule.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** Text the tool is about to write (pre), across Write / Edit / MultiEdit. */
function incomingText(input) {
  const t = input?.tool_input ?? {};
  if (typeof t.content === "string") return t.content;
  if (typeof t.new_string === "string") return t.new_string;
  if (Array.isArray(t.edits)) return t.edits.map((e) => e?.new_string ?? "").join("\n");
  return "";
}

/** Resolve symlinks; for a file that does not exist yet (a Write), resolve its folder. */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

function projectRelative(input, filePath) {
  // Both sides resolved through symlinks, so a project reached through a
  // symlinked path does not produce a "../" relative path and get skipped.
  const root = real(process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd());
  const rel = path.relative(root, real(path.resolve(root, filePath)));
  return { root, rel: rel.split(path.sep).join("/") };
}

function onOriginMain(root, rel) {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "origin/main"], {
      stdio: "ignore",
    });
  } catch {
    return false; // no base to compare against — same as the CI check, skip
  }
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `origin/main:${rel}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function preViolation(rel, text, landedOnMain) {
  if (/^drizzle\/[^/]+\.sql$/.test(rel) && landedOnMain) {
    return (
      `${rel} has already landed on main, and migrations are append-only ` +
      "(open-items.md #6, db/README.md 'Migrations'; CI enforces it in " +
      "scripts/check-migrations-immutable.sh). Change the schema in db/schema.ts " +
      "and run `bun run db:generate` to add a NEW migration instead. If this " +
      "really is a deliberate pre-launch exception, ask the user first."
    );
  }
  if (/^next\.config\.(ts|js|mjs|cjs)$/.test(rel) && /content-security-policy/i.test(text)) {
    return (
      "The CSP must never be set in next.config.ts. It is served from " +
      "middleware.ts with a per-request nonce; a static header cannot carry " +
      "the nonce, so script-src blocks Next's inline bootstrap scripts and no " +
      "page hydrates, while every status check still returns 200 (AGENTS.md, " +
      "'Config that must not drift'). Change middleware.ts / lib/csp.ts instead."
    );
  }
  return null;
}

/**
 * Blank out comments (block, JSX `{/* *\/}`, and line) so a tag named in prose —
 * "a nested `<form>` here would be invalid" — is not mistaken for code. Newlines
 * are kept so reported line numbers stay true.
 *
 * A small scanner, not a regex, so a comment marker inside a string literal
 * (`"components/*"`, `"https://…"`) is left alone instead of blanking real code
 * up to the next `*\/`. `'` and `"` strings end at a newline, as in JS, so an
 * apostrophe in JSX text ("Don't") cannot swallow the rest of the file.
 * Known gap: a `//` in JSX *text* is treated as a comment to end of line.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  const blankUntil = (end) => {
    out += source.slice(i, end).replace(/[^\n]/g, " ");
    i = end;
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== c && !(c !== "`" && source[j] === "\n")) {
        j += source[j] === "\\" ? 2 : 1;
      }
      j = Math.min(j + 1, n);
      out += source.slice(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blankUntil(end === -1 ? n : end + 2);
    } else if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blankUntil(end === -1 ? n : end);
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Opening tags of the given names, with their attribute text. Scans to the `>`
 * that closes the TAG — outside every `{…}` expression and string — so neither
 * an arrow function's `=>` nor `hidden={a > b}` ends the tag early.
 */
function openingTags(source, tagPattern) {
  source = stripComments(source);
  const re = new RegExp(`<(?:${tagPattern})\\b`, "g");
  const found = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    let depth = 0;
    let quote = null;
    let j = re.lastIndex;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth <= 0) break;
    }
    found.push({ attrs: source.slice(re.lastIndex, j), line: source.slice(0, m.index).split("\n").length });
    re.lastIndex = j;
  }
  return found;
}

export function postWarnings(rel, source) {
  if (!/\.(tsx|jsx)$/.test(rel)) return [];
  const warnings = [];
  for (const tag of openingTags(source, "form")) {
    if (!/\bmethod\s*=/.test(tag.attrs)) {
      warnings.push(
        `${rel}:${tag.line} — <form> without method="post". Before hydration (or if it ` +
          "fails) the browser submits natively as GET and puts every field, passwords " +
          'included, in the URL. Add method="post" (AGENTS.md working agreements).',
      );
    }
  }
  for (const tag of openingTags(source, "tr|TableRow")) {
    if (/\bonClick\s*=/.test(tag.attrs)) {
      warnings.push(
        `${rel}:${tag.line} — onClick on a table row. Row-level edit is a real ` +
          "<button> in the row, with the row's onClick removed — not a role/tabIndex " +
          "on the row (AGENTS.md working agreements; it once put the wrong location " +
          "into the edit form).",
      );
    }
  }
  return warnings;
}

function main() {
  const input = readStdin();
  const filePath = input?.tool_input?.file_path;
  if (!filePath) return;
  const { root, rel } = projectRelative(input, filePath);
  if (rel.startsWith("..")) return; // outside the repo

  if (mode === "pre") {
    const landed = /^drizzle\/[^/]+\.sql$/.test(rel) ? onOriginMain(root, rel) : false;
    const reason = preViolation(rel, incomingText(input), landed);
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
    return;
  }

  if (mode === "post") {
    let source;
    try {
      source = readFileSync(path.resolve(root, rel), "utf8");
    } catch {
      return;
    }
    const warnings = postWarnings(rel, source);
    if (warnings.length > 0) {
      process.stdout.write(
        JSON.stringify({
          systemMessage: `Edit guard: ${warnings.length} warning(s) in ${rel}`,
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: "Edit guard warnings — fix before finishing:\n" + warnings.join("\n"),
          },
        }),
      );
    }
  }
}

// Run only when executed directly, not when the test imports it. Compared as
// real-path file URLs: `import.meta.url` is percent-encoded and symlink-resolved,
// so a naive `file://${argv[1]}` comparison silently disabled the guard in any
// checkout whose path had a space or a symlink (found in review, 2026-11-08).
let isEntry = false;
try {
  isEntry = !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
} catch {
  isEntry = false;
}
if (isEntry) {
  try {
    main();
  } catch {
    // fail open
  }
}
