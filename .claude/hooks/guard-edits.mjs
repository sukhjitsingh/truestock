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
import { readFileSync } from "node:fs";
import path from "node:path";

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

function projectRelative(input, filePath) {
  const root = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  const rel = path.relative(root, path.resolve(root, filePath));
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
  if (rel === "next.config.ts" && /content-security-policy/i.test(text)) {
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
 * are kept so reported line numbers stay true. A `//` right after `:` or a quote
 * is left alone (URLs in strings).
 */
export function stripComments(source) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (m, lead) => lead + blank(m.slice(lead.length)));
}

/** Opening tag bodies: everything up to the first `>` that is not part of `=>`. */
function openingTags(source, tagPattern) {
  source = stripComments(source);
  // `=>` MUST come first in the alternation: with `[^>]` first, the `=` of an
  // arrow function is consumed alone and its `>` then ends the tag early.
  const re = new RegExp(`<(?:${tagPattern})\\b((?:=>|[^>])*)>`, "g");
  const found = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    found.push({ attrs: m[1], line: source.slice(0, m.index).split("\n").length });
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

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  try {
    main();
  } catch {
    // fail open
  }
}
