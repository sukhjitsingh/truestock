/**
 * Pins .claude/hooks/guard-edits.mjs — the Claude Code edit guards wired in
 * .claude/settings.json. Each rule is a lesson this project paid for once
 * (see the header of the hook file). Two kinds of test, for every rule:
 * the violation is caught, and the nearest legitimate code is NOT — a guard
 * that cries wolf gets disabled, which is worse than no guard.
 *
 * The end-to-end tests at the bottom run the hook as Claude Code does (JSON on
 * stdin, decision JSON on stdout), so the wiring is covered, not only the
 * helpers.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { postWarnings, preViolation, stripComments } from "../.claude/hooks/guard-edits.mjs";

const HOOK = path.resolve(import.meta.dir, "../.claude/hooks/guard-edits.mjs");

describe("pre: migrations are append-only", () => {
  test("editing a migration that has landed on main is refused", () => {
    const reason = preViolation("drizzle/0003_location_active.sql", "ALTER TABLE x;", true);
    expect(reason).toContain("append-only");
    expect(reason).toContain("db:generate");
  });

  test("a migration that is new on this branch can still be edited", () => {
    expect(preViolation("drizzle/0012_new.sql", "CREATE TABLE y;", false)).toBeNull();
  });

  test("drizzle-kit's own bookkeeping under drizzle/meta/ is not guarded (CI doesn't either)", () => {
    expect(preViolation("drizzle/meta/_journal.json", "{}", true)).toBeNull();
  });
});

describe("pre: the CSP stays in middleware", () => {
  test("adding a Content-Security-Policy to next.config.ts is refused, any casing", () => {
    expect(preViolation("next.config.ts", "{ key: 'content-security-policy' }", false)).toContain(
      "middleware.ts",
    );
    expect(preViolation("next.config.ts", 'key: "Content-Security-Policy"', false)).not.toBeNull();
  });

  test("the .js / .mjs / .cjs spellings of next.config are guarded too", () => {
    for (const f of ["next.config.js", "next.config.mjs", "next.config.cjs"]) {
      expect(preViolation(f, "Content-Security-Policy", false)).not.toBeNull();
    }
  });

  test("other next.config.ts edits, and CSP work in middleware.ts, are allowed", () => {
    expect(preViolation("next.config.ts", "output: 'standalone'", false)).toBeNull();
    expect(preViolation("middleware.ts", "Content-Security-Policy", false)).toBeNull();
  });
});

describe("post: <form> carries a method", () => {
  test("a JS-submitted form with no method is flagged, with its line", () => {
    const src = "export function F() {\n  return (\n    <form onSubmit={(e) => e.preventDefault()}>\n";
    const w = postWarnings("components/x.tsx", src);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("components/x.tsx:3");
  });

  test("method after an arrow-function onSubmit is still seen (the `=>` regression)", () => {
    const src = `<form\n  onSubmit={(e) => {\n    run();\n  }}\n  method="get"\n>`;
    expect(postWarnings("components/x.tsx", src)).toEqual([]);
  });

  test('method="post" passes; a <form> named only in a comment is ignored', () => {
    expect(postWarnings("a.tsx", '<form method="post" onSubmit={s}>')).toEqual([]);
    expect(postWarnings("a.tsx", "// a nested `<form>` here would be invalid\n")).toEqual([]);
    expect(postWarnings("a.tsx", "{/* <form onSubmit={x}> */}\n")).toEqual([]);
  });

  test("a `>` inside an attribute expression does not end the tag (review 2026-11-08)", () => {
    // Was a false positive: the tag ended at `a >`, so method= was never seen.
    expect(postWarnings("a.tsx", '<form onSubmit={s} hidden={a > b} method="post">')).toEqual([]);
    // And `>=` before a missing method is still caught.
    expect(postWarnings("a.tsx", "<form hidden={n >= 2} onSubmit={s}>")).toHaveLength(1);
  });

  test("a comment marker inside a string cannot hide a real form (review 2026-11-08)", () => {
    // Was a false negative: "components/*" opened a block comment that ran to
    // the next */ and blanked the form between them.
    const src = 'const g = "components/*";\nexport const F = () => <form onSubmit={s}></form>;\n/* note */';
    const w = postWarnings("a.tsx", src);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("a.tsx:2");
  });

  test("an apostrophe in JSX text does not swallow the rest of the file", () => {
    const src = "<p>Don't panic</p>\n<form onSubmit={s}>\n";
    expect(postWarnings("a.tsx", src)).toHaveLength(1);
  });

  test("non-JSX files are not checked", () => {
    expect(postWarnings("lib/x.ts", "<form onSubmit={s}>")).toEqual([]);
  });
});

describe("post: row-level edit is a button", () => {
  test("onClick on a <tr> or <TableRow> is flagged", () => {
    expect(postWarnings("a.tsx", "<tr onClick={() => edit(row)}>")).toHaveLength(1);
    // Was a false negative: the tag ended at `a >` before onClick was reached.
    expect(postWarnings("a.tsx", "<tr data-x={a > b} onClick={e}>")).toHaveLength(1);
    expect(postWarnings("a.tsx", '<TableRow key={r.id} onClick={() => edit(r)} className="x">')).toHaveLength(1);
  });

  test("an onClick on a button inside the row is fine", () => {
    const src = '<tr key={r.id}>\n  <td><button onClick={() => edit(r)}>Edit</button></td>\n</tr>';
    expect(postWarnings("a.tsx", src)).toEqual([]);
  });
});

describe("stripComments", () => {
  test("keeps line numbers and leaves URLs in strings alone", () => {
    const src = 'const a = "https://x.test/y"; // note\n/* two\nlines */ const b = 1;';
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain('"https://x.test/y"');
    expect(out).not.toContain("note");
    expect(out).toContain("const b = 1;");
  });
});

describe("the hook as Claude Code runs it", () => {
  function run(mode: "pre" | "post", payload: unknown, projectDir: string) {
    const r = spawnSync("node", [HOOK, mode], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout };
  }

  test("pre: a CSP Write to next.config.ts comes back as a deny decision", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
    const res = run(
      "pre",
      { tool_name: "Write", tool_input: { file_path: path.join(dir, "next.config.ts"), content: "Content-Security-Policy" } },
      dir,
    );
    expect(res.code).toBe(0);
    const decision = JSON.parse(res.out).hookSpecificOutput;
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
  });

  test("post: a written file with a method-less form comes back as context, not a block", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
    const file = path.join(dir, "f.tsx");
    writeFileSync(file, "<form onSubmit={s}>\n</form>\n");
    const res = run("post", { tool_name: "Edit", tool_input: { file_path: file } }, dir);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.out);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("f.tsx:1");
    expect(out.decision).toBeUndefined();
  });

  test("still denies when the checkout path has a space or goes through a symlink (review 2026-11-08)", () => {
    // The entry-point check used to compare import.meta.url (percent-encoded,
    // symlink-resolved) with a raw path, so in such a checkout the hook ran,
    // printed nothing, and every guard was silently off.
    const base = mkdtempSync(path.join(tmpdir(), "guard space-"));
    const hookDir = path.join(base, "with space", ".claude", "hooks");
    mkdirSync(hookDir, { recursive: true });
    copyFileSync(HOOK, path.join(hookDir, "guard-edits.mjs"));
    const link = path.join(base, "linked");
    symlinkSync(path.join(base, "with space"), link);

    for (const projectDir of [path.join(base, "with space"), link]) {
      const hook = path.join(projectDir, ".claude", "hooks", "guard-edits.mjs");
      const r = spawnSync("node", [hook, "pre"], {
        input: JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: path.join(projectDir, "next.config.ts"), content: "Content-Security-Policy" },
        }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        encoding: "utf8",
      });
      expect(r.stdout).not.toBe("");
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  test("clean edits and unparseable input produce no output (fail open)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
    expect(run("pre", { tool_name: "Edit", tool_input: { file_path: path.join(dir, "a.ts"), new_string: "x" } }, dir).out).toBe("");
    const garbage = spawnSync("node", [HOOK, "pre"], { input: "not json", encoding: "utf8" });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");
  });
});
