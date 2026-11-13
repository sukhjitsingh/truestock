/**
 * Tests for the OCR bench scorer. Pure: SYNTHETIC data only (the invoice, the engine outputs and the library-OCR
 * stand-ins are all invented by synth.ts), written under a temp dir. No real invoice content, no BENCH files, no
 * database, no network.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type GroundTruth,
  agreedMultiset,
  alignRows,
  deriveGroundTruth,
  deriveTolerated,
  engineStats,
  fmt,
  fmtRatio,
  intersectionSize,
  markdownRows,
  maskText,
  mergeLenient,
  moneyCentsOf,
  findMoneyTokens,
  padCell,
  quantityBeforeMoney,
  ratioOf,
  ratioValue,
  readLenient,
  reconstructMarkdown,
  renderTable,
  runTemplate,
  scoreMultiset,
  scoreQuantities,
  standaloneIntegers,
  summarizeQuantities,
  toMultiset,
  unionMultiset,
  wordsOf,
} from "./core";
import {
  DEFAULT_IDS,
  EXPLORATORY_PATTERN,
  type ScoreRun,
  type VariantScore,
  buildReports,
  compareRank,
  deepFind,
  deriveGtFromLibrary,
  errorText,
  familyOf,
  findLeaks,
  isExploratory,
  loadGroundTruth,
  loadLibrary,
  loadOutDir,
  main,
  parseArgs,
  pct1,
  readPage,
  renderDetail,
  renderSummary,
  runMergeSweeps,
  runScoring,
  runSynthetic,
  scoreRun,
} from "./score";
import { buildInvoice, grossOf, netOf, renderMarkdown, syntheticFleet, writeSyntheticFleet, writeSyntheticLibrary, writeSyntheticVariant } from "./synth";

const INV = buildInvoice(7);
const TOTAL = INV.totalCents;

const rows = (opts = {}) => renderMarkdown(INV, "rows", opts);
const pipe = (opts = {}) => renderMarkdown(INV, "pipe", opts);
const reflow = (opts = {}) => renderMarkdown(INV, "reflow", opts);

function deriveGt(): GroundTruth {
  const markdowns = [pipe(), reflow(), rows()];
  const derived = deriveGroundTruth(markdowns);
  if (!derived.ok) throw new Error("synthetic ground truth did not derive");
  return { ...derived.gt, tolerated: deriveTolerated(derived.gt, markdowns) };
}

const GT = deriveGt();
const EMPTY_LIBRARY = { scan: [], photo: [] };

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ocrb-${label}-`));
}

// ---------------------------------------------------------------------------------------------------------------

describe("synthetic invoice generator", () => {
  test("is deterministic and self-consistent", () => {
    expect(buildInvoice(7)).toEqual(buildInvoice(7));
    expect(buildInvoice(7)).not.toEqual(buildInvoice(8));
    expect(INV.rows).toHaveLength(8);
    expect(INV.rows[0].kind).toBe("deposit-return");
    expect(INV.rows.some((row) => row.qty >= 10)).toBe(true);
    expect(INV.totalCents).toBe(INV.rows.reduce((sum, row) => sum + grossOf(row), 0));
    expect(grossOf(INV.rows[0])).toBe(-netOf(INV.rows[0]));
  });

  test("renders contain no real-looking content: invented names only", () => {
    const text = rows() + pipe() + reflow();
    expect(text).toContain("Example Bar & Grill");
    expect(text).toContain("Sample");
  });
});

describe("text and money tokens", () => {
  test("maskText keeps shape only", () => {
    expect(maskText("Ab-12 x")).toBe("aa-99 a");
    expect(wordsOf("Foo, BAR-12")).toEqual(["foo", "bar", "12"]);
  });

  test("findMoneyTokens reads plain, dollar, comma, signed, parenthesised and glued amounts", () => {
    const tokens = findMoneyTokens("Total $1,234.56 and (12.00) and -3.50 and 1$140.00 and 12.345 and 1234567.89");
    expect(tokens.map((t) => t.cents)).toEqual([123456, -1200, -350, 14000, 123456789]);
    expect(tokens.map((t) => t.hasDollar)).toEqual([true, false, false, true, false]);
  });

  test("a fragment of a longer number is not a token, and zero is not negative", () => {
    expect(moneyCentsOf("12.345 9.999 1.2.34")).toEqual([]);
    expect(moneyCentsOf("(0.00)")).toEqual([0]);
  });
});

describe("multiset precision and recall", () => {
  test("counts true / false positives and negatives", () => {
    const prf = scoreMultiset(toMultiset([1, 2, 3]), toMultiset([1, 2, 4]));
    expect([prf.tp, prf.fp, prf.fn]).toEqual([2, 1, 1]);
    expect(prf.precision).toBeCloseTo(2 / 3, 9);
    expect(prf.recall).toBeCloseTo(2 / 3, 9);
    expect(prf.f1).toBeCloseTo(2 / 3, 9);
  });

  test("repeated values are counted by multiplicity", () => {
    const prf = scoreMultiset(toMultiset([5, 5, 5]), toMultiset([5, 5]));
    expect([prf.tp, prf.fp, prf.fn]).toEqual([2, 0, 1]);
  });

  test("tolerated extras are neither required nor penalised", () => {
    const expected = toMultiset([5]);
    const observed = toMultiset([5, 5]);
    expect(scoreMultiset(expected, observed).fp).toBe(1);
    const tolerated = scoreMultiset(expected, observed, toMultiset([5]));
    expect([tolerated.tp, tolerated.fp, tolerated.fn]).toEqual([1, 0, 0]);
    expect(tolerated.f1).toBe(1);
  });

  test("empty sides give null or zero, never NaN", () => {
    const nothingRead = scoreMultiset(toMultiset([1]), toMultiset([]));
    expect([nothingRead.precision, nothingRead.recall, nothingRead.f1]).toEqual([null, 0, 0]);
    const nothingExpected = scoreMultiset(toMultiset([]), toMultiset([1]));
    expect([nothingExpected.recall, nothingExpected.f1]).toEqual([null, null]);
  });

  test("agreed, union and intersection", () => {
    const sets = [toMultiset([1, 1, 2]), toMultiset([1, 2]), toMultiset([1, 1])];
    const agreed = agreedMultiset(sets, 2);
    expect(agreed.get(1)).toBe(2);
    expect(agreed.get(2)).toBe(1);
    expect(unionMultiset(sets).get(1)).toBe(2);
    expect(intersectionSize(toMultiset([1, 1, 2, 3]), toMultiset([1, 2, 2]))).toBe(2);
  });
});

describe("quantities", () => {
  test("standaloneIntegers: bare, parenthesised and glued-to-price; not codes or money", () => {
    expect(standaloneIntegers("1234 Foo 3 $5.00 (2) 1$140.00 12.50")).toEqual([3, 2, 1]);
    expect(standaloneIntegers("| 7 | $1.00 |")).toEqual([7]);
  });

  test("quantityBeforeMoney needs the integer directly in front of one of the line's amounts", () => {
    const row = "12345 Item 2 $5.00 $10.00 $10.00";
    expect(quantityBeforeMoney(row, 2, [500, 1000])).toBe(true);
    expect(quantityBeforeMoney(row, 3, [500, 1000])).toBe(false);
    expect(quantityBeforeMoney(row, 2, [999])).toBe(false);
  });

  test("a clean render finds every quantity; a render that dropped two does not", () => {
    const clean = summarizeQuantities(scoreQuantities(rows(), GT.lines));
    expect(clean.located).toEqual({ hit: 8, of: 8 });
    expect(clean.any).toEqual({ hit: 8, of: 8 });
    expect(clean.adjacent).toEqual({ hit: 8, of: 8 });
    const dropped = summarizeQuantities(scoreQuantities(rows({ dropQtyRows: [1, 3] }), GT.lines));
    expect(dropped.located.hit).toBe(8);
    expect(dropped.any.hit).toBe(6);
    expect(dropped.anyOneDigit.of).toBe(GT.lines.filter((l) => l.qty >= 1 && l.qty <= 9).length);
    expect(dropped.anyOneDigit.hit).toBeLessThan(dropped.anyOneDigit.of);
  });

  test("a row that carries none of the line's amounts is not located", () => {
    const summary = summarizeQuantities(scoreQuantities("nothing here", GT.lines));
    expect(summary.located.hit).toBe(0);
    expect(summary.any.hit).toBe(0);
  });

  test("ratio helpers", () => {
    expect(ratioOf([true, false, true])).toEqual({ hit: 2, of: 3 });
    expect(ratioValue({ hit: 0, of: 0 })).toBeNull();
    expect(ratioValue({ hit: 1, of: 4 })).toBe(0.25);
    expect(markdownRows("a\n\n  \nb\r\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("ground truth derivation", () => {
  test("the consensus of three layouts reproduces the invented invoice and passes the gate", () => {
    expect(GT.lines).toHaveLength(INV.rows.length);
    expect(GT.gate).toEqual({ pass: true, independentCheck: true, exactArithmetic: true, fieldConflicts: 0 });
    expect(GT.header.printedTotalCents).toBe(TOTAL);
    expect(GT.lines.map((l) => l.extCents)).toEqual(INV.rows.map(netOf));
    expect(GT.lines.map((l) => l.grossCents)).toEqual(INV.rows.map(grossOf));
    expect(GT.lines.map((l) => l.unitCents)).toEqual(INV.rows.map((r) => r.unitCents));
    expect(GT.lines.map((l) => l.qty)).toEqual(INV.rows.map((r) => r.qty));
    expect(GT.lines[0].depositFlag).toBe(true);
    expect(GT.lines.some((l) => !l.depositFlag)).toBe(true);
  });

  test("the layouts agree for several invented invoices", () => {
    for (const seed of [1, 7, 11, 23, 42]) {
      const inv = buildInvoice(seed);
      const derived = deriveGroundTruth([renderMarkdown(inv, "pipe"), renderMarkdown(inv, "reflow"), renderMarkdown(inv, "rows")]);
      expect(derived.ok).toBe(true);
      if (derived.ok) {
        expect(derived.gt.gate.exactArithmetic).toBe(true);
        expect(derived.gt.gate.fieldConflicts).toBe(0);
        expect(derived.gt.header.printedTotalCents).toBe(inv.totalCents);
      }
    }
  });

  test("renders of different shapes are refused", () => {
    const derived = deriveGroundTruth([rows(), rows({ dropRows: [3] }), pipe()]);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.sameShape).toBe(false);
  });

  test("a consensus that fails the gate is refused", () => {
    const wrong = { totalCents: TOTAL + 100 };
    const derived = deriveGroundTruth([pipe(wrong), reflow(wrong), rows(wrong)]);
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.sameShape).toBe(true);
      expect(derived.gateChecks.length).toBeGreaterThan(0);
    }
  });

  test("deriveTolerated finds the repeated footer total and the zero amount; one render tolerates nothing new", () => {
    const tolerated = deriveTolerated(GT, [pipe(), reflow(), rows()]);
    expect(tolerated.find((t) => t.cents === TOTAL)?.extra).toBe(1);
    expect(tolerated.find((t) => t.cents === 0)?.extra).toBe(1);
    expect(deriveTolerated(GT, [rows()])).toBe(GT.tolerated);
  });

  test("deriveGtFromLibrary writes the file with owner-only permissions and reports structure only", () => {
    const dir = tempDir("gt");
    try {
      const lib = path.join(dir, "lib");
      writeSyntheticLibrary(lib, INV, "fffd2e6c", "2be05f77");
      const summary = deriveGtFromLibrary(loadLibrary(lib, "fffd2e6c", "2be05f77", [100, 150, 200]), path.join(dir, "gt"));
      expect(summary).toMatchObject({ ok: true, renders: 3, lines: 8, gatePass: true, independentCheck: true, exactArithmetic: true, fieldConflicts: 0, why: null });
      const stored = loadGroundTruth(path.join(dir, "gt", "scan.json"));
      expect(stored?.lines).toHaveLength(8);
      expect(fs.statSync(path.join(dir, "gt", "scan.json")).mode & 0o077).toBe(0);
      const one = deriveGtFromLibrary({ scan: [{ dpi: 100, markdown: rows() }], photo: [] }, path.join(dir, "gt2"));
      expect(one).toMatchObject({ ok: false, why: "fewer-than-2-renders" });
      expect(fs.existsSync(path.join(dir, "gt2"))).toBe(false);
      const bad = deriveGtFromLibrary({ scan: [{ dpi: 100, markdown: rows() }, { dpi: 150, markdown: rows({ dropRows: [2] }) }], photo: [] }, path.join(dir, "gt3"));
      expect(bad).toMatchObject({ ok: false, why: "renders-differ-in-shape" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadGroundTruth rejects a missing, corrupt or malformed file", () => {
    const dir = tempDir("gtbad");
    try {
      expect(loadGroundTruth(path.join(dir, "none.json"))).toBeNull();
      fs.writeFileSync(path.join(dir, "bad.json"), "{ nope");
      expect(loadGroundTruth(path.join(dir, "bad.json"))).toBeNull();
      fs.writeFileSync(path.join(dir, "shape.json"), JSON.stringify({ version: 1, lines: [{ qty: "x" }], header: {}, gate: {} }));
      expect(loadGroundTruth(path.join(dir, "shape.json"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("template outcome classification", () => {
  test("a clean page: ok, every line equals the ground truth", () => {
    const outcome = runTemplate(rows(), GT);
    expect(outcome).toMatchObject({ status: "ok", lineCount: 8, gatePass: true, falseAccept: false, failureKind: null });
    expect(outcome.exactVsGt).toEqual({ hit: 8, of: 8 });
  });

  test("no ground truth: no comparison fields", () => {
    const outcome = runTemplate(rows());
    expect(outcome.status).toBe("ok");
    expect(outcome.exactVsGt).toBeNull();
    expect(outcome.falseAccept).toBeNull();
  });

  test("another vendor's page: no-template, with both detect patterns missed", () => {
    const outcome = runTemplate("hello world\nnothing to see");
    expect(outcome).toMatchObject({ status: "no-template", lineCount: null, gatePass: null, failureKind: "no-template-match" });
    expect(outcome.detectHits).toEqual([false, false]);
  });

  test("a dropped quantity fails closed as parse-failed, with a code and no text", () => {
    const outcome = runTemplate(rows({ dropQtyRows: [1] }), GT);
    expect(outcome.status).toBe("parse-failed");
    expect(outcome.lineCount).toBeNull();
    expect(typeof outcome.failureKind).toBe("string");
    expect(outcome.failureKind).toMatch(/^[a-z-]+$/);
  });

  test("a row with fewer amounts is parse-failed with the row number and amount count", () => {
    const outcome = runTemplate(rows({ dropAmountRows: [{ row: 2, keep: 1 }] }), GT);
    expect(outcome.status).toBe("parse-failed");
    expect(outcome.failureKind).toBe("amount-count");
    expect(outcome.failureAmounts).toBe(1);
    expect(outcome.failureRow).not.toBeNull();
  });

  test("a wrong printed total is gate-failed with the lines and the failed checks", () => {
    const outcome = runTemplate(rows({ totalCents: TOTAL + 100 }), GT);
    expect(outcome.status).toBe("gate-failed");
    expect(outcome.gatePass).toBe(false);
    expect(outcome.lineCount).toBe(8);
    expect(Object.keys(outcome.failedChecks).length).toBeGreaterThan(0);
    expect(outcome.falseAccept).toBeNull();
  });

  test("a gate pass whose lines are not the ground truth is flagged as a false accept", () => {
    const skewed: GroundTruth = { ...GT, lines: GT.lines.map((line, i) => (i === 2 ? { ...line, unitCents: line.unitCents + 1 } : line)) };
    const outcome = runTemplate(rows(), skewed);
    expect(outcome.status).toBe("ok");
    expect(outcome.exactVsGt).toEqual({ hit: 7, of: 8 });
    expect(outcome.falseAccept).toBe(true);
  });
});

describe("lenient reading and reconstruction", () => {
  test("reads every row's quantity, amounts and the footer total", () => {
    const doc = readLenient(rows());
    expect(doc).not.toBeNull();
    expect(doc?.rows).toHaveLength(8);
    expect(doc?.rows.every((row) => row.amounts.length === 3 && row.qty !== null)).toBe(true);
    expect(doc?.totalCents).toBe(TOTAL);
    expect(doc?.totalConflict).toBe(false);
  });

  test("keeps what it can read from a degraded page and marks the rest unread", () => {
    const doc = readLenient(rows({ dropQtyRows: [1], dropAmountRows: [{ row: 3, keep: 1 }], omitTotal: true }));
    expect(doc?.rows[1].qty).toBeNull();
    expect(doc?.rows[3].amounts).toHaveLength(1);
    expect(doc?.totalCents).toBeNull();
  });

  test("a page with no item rows reads as zero rows, not as a failure", () => {
    expect(readLenient("hello")?.rows).toEqual([]);
  });

  test("read -> reconstruct -> the real template + gate gives back the same lines (every layout)", () => {
    for (const layout of [rows, pipe, reflow]) {
      const doc = readLenient(layout());
      expect(doc).not.toBeNull();
      if (!doc) continue;
      const outcome = runTemplate(reconstructMarkdown(doc.rows, doc.totalCents), GT);
      expect(outcome.status).toBe("ok");
      expect(outcome.exactVsGt).toEqual({ hit: 8, of: 8 });
    }
  });
});

describe("cross-source merge", () => {
  const read = (markdown: string) => readLenient(markdown);

  test("same item rows align by anchor order", () => {
    const a = read(rows());
    const b = read(pipe());
    if (!a || !b) throw new Error("unreadable");
    const alignment = alignRows(a.rows, b.rows);
    expect(alignment.mode).toBe("anchor-order");
    expect(alignment.unpaired).toBe(0);
  });

  test("a row one source lacks falls back to aligning by shared amounts and is carried, not dropped", () => {
    const a = read(rows());
    const b = read(rows({ dropRows: [3] }));
    if (!a || !b) throw new Error("unreadable");
    const alignment = alignRows(a.rows, b.rows);
    expect(alignment.mode).toBe("amount-token");
    expect(alignment.unpaired).toBe(1);
    expect(alignment.pairs.filter(([i, j]) => i !== null && j !== null)).toHaveLength(7);
    expect(alignment.pairs).toHaveLength(8);
    const outcome = mergeLenient([a, b], GT);
    expect(outcome.align).toBe("amount-token");
    expect(outcome.rows).toBe(8);
    expect(outcome.template?.status).toBe("ok");
  });

  test("complementary gaps fill: unread quantities from one source, missing amounts from another, then the gate passes", () => {
    const noQty = read(rows({ dropQtyRows: [1, 3] }));
    const partial = read(rows({ dropAmountRows: [{ row: 2, keep: 2 }, { row: 4, keep: 1 }] }));
    expect(runTemplate(rows({ dropQtyRows: [1, 3] })).status).toBe("parse-failed");
    expect(runTemplate(rows({ dropAmountRows: [{ row: 2, keep: 2 }, { row: 4, keep: 1 }] })).status).toBe("parse-failed");
    const outcome = mergeLenient([noQty, partial], GT);
    expect(outcome.mergeable).toBe(true);
    expect(outcome.conflicts).toEqual({ qty: 0, amounts: 0, total: 0 });
    expect(outcome.filled).toEqual({ qty: 2, amounts: 2 });
    expect(outcome.template).toMatchObject({ status: "ok", gatePass: true, falseAccept: false });
    expect(outcome.template?.exactVsGt).toEqual({ hit: 8, of: 8 });
  });

  test("two differing quantities are a conflict, the field stays unread, and the page is refused", () => {
    const outcome = mergeLenient([read(rows()), read(rows({ wrongQty: [{ row: 1, qty: 7 }] }))], GT);
    expect(outcome.conflicts.qty).toBe(1);
    expect(outcome.template?.status).not.toBe("ok");
  });

  test("a conflict is sticky through later sources", () => {
    const good = read(rows());
    const bad = read(rows({ wrongQty: [{ row: 1, qty: 7 }] }));
    const outcome = mergeLenient([good, bad, good, good], GT);
    expect(outcome.conflicts.qty).toBe(1);
    expect(outcome.template?.status).not.toBe("ok");
  });

  test("differing amounts and differing totals are counted separately", () => {
    const amounts = mergeLenient([read(rows()), read(rows({ wrongAmount: [{ row: 2, which: 0, deltaCents: 100 }] }))], GT);
    expect(amounts.conflicts).toEqual({ qty: 0, amounts: 1, total: 0 });
    expect(amounts.template?.status).not.toBe("ok");
    const totals = mergeLenient([read(rows()), read(rows({ totalCents: TOTAL + 100 }))], GT);
    expect(totals.conflicts.total).toBe(1);
    expect(totals.template?.status).not.toBe("ok");
  });

  test("unusable inputs are reported with a code", () => {
    expect(mergeLenient([])).toMatchObject({ mergeable: false, why: "no-inputs" });
    expect(mergeLenient([read(rows()), null])).toMatchObject({ mergeable: false, why: "unreadable-input" });
    expect(mergeLenient([read("hello"), read("world")])).toMatchObject({ mergeable: false, why: "no-rows" });
  });
});

describe("engine statistics and formatting", () => {
  test("engineStats on a tiny page", () => {
    const stats = engineStats([{ text: "a", conf: 0.5 }, { conf: 1 }, { conf: "x" }], "a $1.00 2.00\nrow");
    expect(stats).toMatchObject({ words: 3, meanConf: 0.75, rows: 2, mdChars: 16, moneyTokens: 2, dollarFraction: 0.5 });
    expect(engineStats([], "").meanConf).toBeNull();
    expect(engineStats([], "").dollarFraction).toBeNull();
  });

  test("fmt and fmtRatio never print NaN, and print one decimal by default", () => {
    expect(fmt(1.234)).toBe("1.2");
    expect(fmt(1.236, 2)).toBe("1.24");
    expect(fmt(null)).toBe("n/a");
    expect(fmt(Number.NaN)).toBe("n/a");
    expect(fmtRatio({ hit: 1, of: 2 })).toBe("1/2");
    expect(fmtRatio(null)).toBe("n/a");
    expect(pct1(0.66667)).toBe(66.7);
    expect(pct1(null)).toBeNull();
  });

  test("padCell and renderTable", () => {
    expect(padCell("ab", 4)).toBe("ab  ");
    expect(padCell("ab", 4, true)).toBe("  ab");
    expect(padCell("abcdef", 3)).toBe("abc");
    const table = renderTable(["name", "n"], [["x", "1"], ["longer", "22"]], [false, true]).split("\n");
    expect(table).toHaveLength(4);
    expect(table[0]).toBe("name     n");
    expect(table[1]).toBe("------  --");
    expect(table[3]).toBe("longer  22");
  });

  test("compareRank is lexicographic", () => {
    expect(compareRank([4, 0], [3, 99])).toBeGreaterThan(0);
    expect(compareRank([3, 1], [3, 2])).toBeLessThan(0);
    expect(compareRank([3], [3, 0])).toBe(0);
  });
});

describe("privacy guard", () => {
  test("flags a money-shaped token but not one-decimal figures", () => {
    expect(findLeaks("total 12.34 here", null)).toEqual(["money-shaped-token"]);
    expect(findLeaks("1,234.56", null)).toEqual(["money-shaped-token"]);
    expect(findLeaks("f1 66.7 and 100.0 and 0.5", null)).toEqual([]);
  });

  test("flags ground-truth description tokens that are long or code-like", () => {
    const gt: GroundTruth = { ...GT, lines: [{ ...GT.lines[0], descTokens: ["abc", "longwordhere", "123456", "1234", "ab12"] }] };
    expect(findLeaks("mentions longwordhere", gt)).toEqual(["ground-truth-description-token"]);
    expect(findLeaks("mentions 123456", gt)).toEqual(["ground-truth-description-token"]);
    expect(findLeaks("mentions abc and 1234", gt)).toEqual([]);
  });

  test("buildReports refuses to emit a report that contains a money-shaped token", () => {
    const run = scoreRun([{ variant: "x-12.34", family: "x", pages: [], repeats: [], run: null, docker: null }], null, EMPTY_LIBRARY);
    expect(() => buildReports(run, null)).toThrow(/leak guard/);
  });

  test("errors are shown as known codes or masked, never as raw text", () => {
    expect(errorText("oom-killed")).toBe("oom-killed");
    expect(errorText("timeout after 900 ms")).toBe("timeout after 900 ms");
    expect(errorText("Invoice 4455 failed")).toBe("aaaaaaa 9999 aaaaaa");
    expect(errorText("x".repeat(200))).toHaveLength(60);
  });
});

describe("loaders", () => {
  test("deepFind finds nested keys and does not enter arrays", () => {
    expect(deepFind({ a: { b: { c: 5 } } }, "c")).toBe(5);
    expect(deepFind({ a: [{ c: 5 }] }, "c")).toBeUndefined();
    expect(deepFind({ c: 1, a: { c: 2 } }, "c")).toBe(1);
    expect(deepFind(null, "c")).toBeUndefined();
  });

  test("familyOf is the prefix before the first dash", () => {
    expect(familyOf("tess-best-psm6")).toBe("tess");
    expect(familyOf("ppocr")).toBe("ppocr");
  });

  test("loadOutDir skips scratch dirs and files, separates repeat passes, tolerates corrupt pages and reads thread counts", () => {
    const dir = tempDir("load");
    try {
      writeSyntheticVariant(dir, INV, {
        variant: "alpha-x",
        pages: [
          { doc: "scan", dpi: 150, layout: "rows", inferMs: 2000 },
          { doc: "scan", dpi: 100, layout: "rows" },
          { doc: "photo", dpi: 150, layout: "rows" },
        ],
        corrupt: ["scan-d100"],
        run: { loadMs: 10.123, maxRssMb: 300.678, cgroupPeakMb: 310, threadsObserved: 6, nested: true },
        docker: { status: "ok", oomKilled: false, exitCode: 0 },
      });
      const variantDir = path.join(dir, "alpha-x");
      fs.copyFileSync(path.join(variantDir, "scan-d150.json"), path.join(variantDir, "scanp2-d150.json"));
      fs.copyFileSync(path.join(variantDir, "scan-d150.json"), path.join(variantDir, "_tess-scan-d150.json"));
      fs.writeFileSync(path.join(variantDir, "notes.json"), "{}");
      fs.mkdirSync(path.join(dir, "_scratch"));
      fs.mkdirSync(path.join(dir, ".hidden"));

      const loaded = loadOutDir(dir);
      expect(loaded.map((v) => v.variant)).toEqual(["alpha-x"]);
      const [variant] = loaded;
      expect(variant.pages.map((p) => p.key)).toEqual(["scan-d100", "scan-d150", "photo-d150"]);
      expect(variant.pages.map((p) => p.ok)).toEqual([false, true, true]);
      expect(variant.pages[0].error).toBe("unreadable-json");
      expect(variant.repeats.map((p) => p.key)).toEqual(["scanp2-d150"]);
      expect(variant.run).toMatchObject({ loadMs: 10.1, maxRssMb: 300.7, cgroupPeakMb: 310, threadsObserved: 6 });
      expect(variant.docker).toMatchObject({ status: "ok", oomKilled: false, exitCode: 0 });
      expect(loadOutDir(path.join(dir, "missing"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readPage: an error object, an empty error and a missing markdown are told apart", () => {
    const dir = tempDir("page");
    try {
      const write = (name: string, body: unknown) => {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
        return readPage(path.join(dir, name), "scan", 150);
      };
      expect(write("a.json", { markdown: "x", error: null })).toMatchObject({ ok: true, error: null });
      expect(write("b.json", { markdown: "", error: "" })).toMatchObject({ ok: true });
      expect(write("c.json", { error: "Boom 12" })).toMatchObject({ ok: false, error: "aaaa 99" });
      expect(write("d.json", { markdown: "x", error: { code: 1 } })).toMatchObject({ ok: false, error: "error-object" });
      expect(write("e.json", { words: [] })).toMatchObject({ ok: false, error: "no-markdown" });
      expect(write("f.json", [1, 2])).toMatchObject({ ok: false, error: "unreadable-json" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadLibrary picks the wanted ids and dpis", () => {
    const dir = tempDir("lib");
    try {
      writeSyntheticLibrary(dir, INV, "fffd2e6c", "2be05f77");
      fs.writeFileSync(path.join(dir, "lib-Auto-dpi300-fffd2e6c.md"), "x");
      fs.writeFileSync(path.join(dir, "lib-Auto-dpi100-00000000.md"), "x");
      const library = loadLibrary(dir, "fffd2e6c", "2be05f77", [100, 150, 200]);
      expect(library.scan.map((r) => r.dpi)).toEqual([100, 150, 200]);
      expect(library.photo.map((r) => r.dpi)).toEqual([100, 150, 200]);
      expect(loadLibrary(null, "a", "b", [100])).toEqual({ scan: [], photo: [] });
      expect(loadLibrary(path.join(dir, "missing"), "a", "b", [100])).toEqual({ scan: [], photo: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("end to end on a synthetic fleet", () => {
  let base = "";
  let run: ScoreRun;
  let reportDir = "";
  let byName: Record<string, VariantScore> = {};

  beforeAll(() => {
    base = tempDir("e2e");
    const result = runSynthetic(base);
    run = result.run;
    reportDir = result.paths.report;
    byName = Object.fromEntries(run.variants.map((v) => [v.variant, v]));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const scanStatuses = (name: string) => byName[name].pages.filter((p) => p.doc === "scan").map((p) => p.template?.status ?? "n/a");

  test("the fleet covers every variant and the synthetic ground truth is arithmetic-verified", () => {
    expect(run.variants.map((v) => v.variant).sort()).toEqual(syntheticFleet().map((v) => v.variant).sort());
    expect(run.gt).toMatchObject({ lines: 8, gatePass: true, independentCheck: true, exactArithmetic: true, fieldConflicts: 0, derivedFromRenders: 3 });
    expect(run.library).toEqual({ scanRenders: 3, photoRenders: 3 });
    expect(run.scanDpis).toEqual([100, 150, 200]);
  });

  test("a clean variant passes at every resolution, with perfect money and quantity scores", () => {
    expect(byName["alpha-good"].pagesOk).toBe(5);
    expect(scanStatuses("alpha-good")).toEqual(["ok", "ok", "ok"]);
    for (const page of byName["alpha-good"].pages.filter((p) => p.doc === "scan")) {
      expect(page.money).toMatchObject({ fp: 0, fn: 0, f1Pct: 100 });
      expect(page.qty?.any).toEqual({ hit: 8, of: 8 });
      expect(page.template).toMatchObject({ gatePass: true, falseAccept: false });
    }
  });

  test("a variant that drops quantities or the dollar sign fails closed at those resolutions only", () => {
    expect(scanStatuses("alpha-half")).toEqual(["parse-failed", "ok", "parse-failed"]);
    expect(scanStatuses("beta-noqty")).toEqual(["parse-failed"]);
    expect(byName["beta-noqty"].pages[0].qty?.any.hit).toBeLessThan(8);
    expect(scanStatuses("gamma-partial")).toEqual(["parse-failed"]);
    expect(byName["gamma-partial"].pages[0].money?.f1Pct).toBeLessThan(100);
  });

  test("an out-of-memory variant, a variant with no pages and a corrupt page are reported as n/a, not as zeros", () => {
    const oom = byName["eps-oom"];
    expect(oom.pagesOk).toBe(0);
    expect(oom.docker?.oomKilled).toBe(true);
    expect(oom.run).toBeNull();
    expect(oom.pages.every((p) => !p.ok && p.error === "oom-killed" && p.template === null && p.money === null)).toBe(true);
    expect(oom.best).toBeNull();
    expect(byName["zeta-nopages"].pagesPresent).toBe(0);
    expect(byName["zeta-nopages"].docker?.oomKilled).toBe(false);
    const corrupt = byName["eta-corrupt"];
    expect(corrupt.pagesPresent).toBe(2);
    expect(corrupt.pagesOk).toBe(1);
    expect(corrupt.pages.find((p) => p.key === "scan-d100")?.error).toBe("unreadable-json");
    expect(corrupt.best).toBe("scan-d150");
  });

  test("cost fields come from the run and docker files, including a nested thread count", () => {
    expect(byName["alpha-good"].run).toMatchObject({ loadMs: 500, maxRssMb: 400, cgroupPeakMb: 450, threadsObserved: 5 });
    expect(byName["alpha-half"].run?.threadsObserved).toBe(5);
    expect(byName["alpha-good"].meanScanMs).toBe(1200);
    expect(byName["alpha-good"].meanPhotoMs).toBe(9000);
    expect(byName["alpha-good"].docker).toMatchObject({ oomKilled: false, mem: "1536m", cpus: 2 });
  });

  test("photo pages have no ground-truth score, only engine stats and a labelled cross-check", () => {
    const photo = byName["alpha-good"].pages.find((p) => p.doc === "photo");
    expect(photo?.money).toBeNull();
    expect(photo?.qty).toBeNull();
    expect(photo?.stats?.moneyTokens).toBeGreaterThan(0);
    expect(photo?.xcheck).not.toBeNull();
    expect(photo?.xcheck?.found).toBeLessThanOrEqual(photo?.xcheck?.reference ?? 0);
    expect(photo?.xcheck?.inLibrary).toBeLessThanOrEqual(photo?.xcheck?.engineTokens ?? 0);
    const missing = byName["beta-noqty"].pages.find((p) => p.doc === "photo");
    expect(missing?.xcheck?.found).toBeLessThanOrEqual(missing?.xcheck?.reference ?? 0);
  });

  test("best page per family is chosen by template outcome first", () => {
    const choice = Object.fromEntries(run.bestPerFamily.map((e) => [e.family, e.variant]));
    expect(choice.alpha).toBe("alpha-good");
    expect(choice.eta).toBe("eta-corrupt");
    expect(choice.eps).toBeUndefined();
    expect(choice.zeta).toBeUndefined();
  });

  test("merge experiment: complementary engines pass the gate, conflicting engines do not, nothing is falsely accepted", () => {
    const find = (a: string, b: string) => run.merges.find((m) => m.kind === "pair" && m.inputs.some((i) => i.variant === a) && m.inputs.some((i) => i.variant === b));
    const complementary = find("beta-noqty", "gamma-partial");
    expect(complementary?.outcome.template).toMatchObject({ status: "ok", gatePass: true, falseAccept: false });
    expect(complementary?.outcome.filled).toEqual({ qty: 2, amounts: 2 });
    expect(complementary?.inputs.every((i) => i.status === "PF")).toBe(true);
    const conflicting = find("alpha-good", "delta-conflict");
    expect(conflicting?.outcome.conflicts.qty).toBe(1);
    expect(conflicting?.outcome.template?.status).not.toBe("ok");
    expect(run.merges.filter((m) => m.kind === "all")).toHaveLength(1);
    expect(run.merges.some((m) => m.kind === "multi-dpi" && m.inputs.every((i) => i.variant === "alpha-good"))).toBe(true);
    for (const entry of run.merges) expect(entry.outcome.template?.falseAccept ?? false).toBe(false);
  });

  test("reports are written, structure only, and parse", () => {
    for (const name of ["summary.txt", "detail.txt", "scores.json"]) expect(fs.existsSync(path.join(reportDir, name))).toBe(true);
    const summary = fs.readFileSync(path.join(reportDir, "summary.txt"), "utf8");
    const detail = fs.readFileSync(path.join(reportDir, "detail.txt"), "utf8");
    const json = fs.readFileSync(path.join(reportDir, "scores.json"), "utf8");
    expect((JSON.parse(json) as ScoreRun).version).toBe(1);
    for (const text of [summary, detail, json]) {
      expect(findLeaks(text, GT)).toEqual([]);
      expect(/\d\.\d{2}(?!\d)/.test(text)).toBe(false);
    }
    expect(summary).toContain("ground truth (scan): 8 lines; gate pass=true");
    expect(summary).toContain("CROSS-ENGINE MERGE EXPERIMENT");
    expect(summary).toContain("PHOTO (main variants; no ground truth)");
    expect(summary).toContain("CROSS-ENGINE SWEEP");
    expect(summary).toMatch(/eps-oom\s+0\/2.*YES/);
    expect(summary).toMatch(/alpha-good\s+5\/5/);
    expect(detail).toContain("no pages");
    for (const row of INV.rows.slice(1)) expect(summary + detail).not.toContain(row.code);
  });

  test("scoring without a ground truth still reports template status, and says the metrics are n/a", () => {
    const dir = tempDir("nogt");
    try {
      writeSyntheticFleet(path.join(dir, "out"), INV);
      const result = runScoring({ out: path.join(dir, "out"), gt: path.join(dir, "gt"), report: path.join(dir, "report"), libocr: null });
      expect(result.run.gt).toBeNull();
      expect(result.reports["summary.txt"]).toContain("NOT FOUND");
      const alpha = result.run.variants.find((v) => v.variant === "alpha-good");
      expect(alpha?.pages.filter((p) => p.doc === "scan").map((p) => p.template?.status)).toEqual(["ok", "ok", "ok"]);
      expect(alpha?.pages.every((p) => p.money === null)).toBe(true);
      expect(result.run.library).toEqual({ scanRenders: 0, photoRenders: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty bench produces a report instead of a crash", () => {
    const dir = tempDir("empty");
    try {
      const result = runScoring({ out: path.join(dir, "none"), gt: path.join(dir, "gt"), report: path.join(dir, "report"), libocr: null });
      expect(result.run.variants).toEqual([]);
      expect(result.reports["summary.txt"]).toContain("variants: 0");
      expect(result.reports["summary.txt"]).toContain("fewer than two engine families");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repeat passes feed warm timing and a determinism flag, not the page scores", () => {
    const dir = tempDir("repeat");
    try {
      writeSyntheticVariant(path.join(dir, "out"), INV, {
        variant: "alpha-rep",
        pages: [{ doc: "scan", dpi: 150, layout: "rows", inferMs: 3000 }],
        run: { loadMs: 1, maxRssMb: 1, cgroupPeakMb: null, threadsObserved: 1 },
        docker: { status: "ok", oomKilled: false, exitCode: 0 },
      });
      const variantDir = path.join(dir, "out", "alpha-rep");
      const first = JSON.parse(fs.readFileSync(path.join(variantDir, "scan-d150.json"), "utf8")) as Record<string, unknown>;
      const again = { ...first, timings: { inferMs: 1000, stagesMs: {} } };
      fs.writeFileSync(path.join(variantDir, "scanp2-d150.json"), JSON.stringify(again));
      fs.writeFileSync(path.join(variantDir, "scanp3-d150.json"), JSON.stringify({ ...again, markdown: `${String(first.markdown)}\nextra` }));
      const result = runScoring({ out: path.join(dir, "out"), gt: path.join(dir, "gt"), report: path.join(dir, "report"), libocr: null });
      const variant = result.run.variants[0];
      expect(variant.pagesPresent).toBe(1);
      expect(variant.repeatPasses).toBe(2);
      expect(variant.warmScanMs).toBe(1000);
      expect(variant.repeatIdentical).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main versus exploratory variants", () => {
  let base = "";
  let paths: ReturnType<typeof runSynthetic>["paths"];
  let defaultRun: ScoreRun;

  beforeAll(() => {
    base = tempDir("explore");
    const result = runSynthetic(base);
    paths = result.paths;
    defaultRun = result.run;
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("the default pattern flags knob sweeps, memory caps, repeat passes and proofs, and nothing else", () => {
    const exploratory = [
      "ppocr-node-b1",
      "ppocr-node-bt40",
      "ppocr-node-pw1",
      "ppocr-node-rep3",
      "ppocr-node-s736",
      "ppocr-node-s1280",
      "tess-best-psm6-w2",
      "tess-best-psm6-wl-m1g",
      "tess-best-psm6-wl-m512",
      "tess-best-psm6-rep2-rec1",
      "tess-best-psm6-wl-scan-m256",
      "tess-fast-psm4-m768",
      "tess-proof-a",
    ];
    const main = ["ppocr-node", "ppocr-web", "tess-best-psm11", "tess-best-psm6", "tess-best-psm6-wl", "tess-fast-psm3", "granite-whole", "alpha-rep"];
    for (const name of exploratory) expect([name, isExploratory(name)]).toEqual([name, true]);
    for (const name of main) expect([name, isExploratory(name)]).toEqual([name, false]);
    expect(isExploratory("anything", /^anything$/)).toBe(true);
    expect(isExploratory("ppocr-node-b1", /^never$/)).toBe(false);
    expect(EXPLORATORY_PATTERN.test("")).toBe(false);
  });

  test("the synthetic fleet is all main under the default pattern", () => {
    expect(defaultRun.variants.every((v) => v.group === "main")).toBe(true);
    const summary = renderSummary(defaultRun);
    expect(summary).toContain("variants: 8 main, 0 exploratory");
    expect(summary).toContain("EXPLORATORY VARIANTS");
    expect(summary.slice(summary.indexOf("EXPLORATORY VARIANTS"))).toContain("(none)");
    expect(renderDetail(defaultRun)).toContain("MAIN VARIANTS");
  });

  test("a custom pattern keeps variants scored but out of the headline tables, the family choice and every merge", () => {
    const result = runScoring(paths, DEFAULT_IDS, /^(?:beta|gamma)-/);
    const { run } = result;
    const group = Object.fromEntries(run.variants.map((v) => [v.variant, v.group]));
    expect(group["beta-noqty"]).toBe("exploratory");
    expect(group["gamma-partial"]).toBe("exploratory");
    expect(group["alpha-good"]).toBe("main");
    expect(run.variants.find((v) => v.variant === "beta-noqty")?.pagesOk).toBe(2);
    expect(run.variants.find((v) => v.variant === "beta-noqty")?.pages[0].template?.status).toBe("parse-failed");

    const moved = new Set(["beta-noqty", "gamma-partial"]);
    expect(run.bestPerFamily.some((e) => moved.has(e.variant) || e.family === "beta" || e.family === "gamma")).toBe(false);
    for (const merge of run.merges) expect(merge.inputs.some((i) => moved.has(i.variant))).toBe(false);
    for (const sweep of run.mergeSweeps) expect(sweep.families.some((f) => f === "beta" || f === "gamma")).toBe(false);
    expect(run.merges.length).toBeLessThan(defaultRun.merges.length);

    const summary = result.reports["summary.txt"];
    const heading = summary.indexOf("EXPLORATORY VARIANTS");
    expect(heading).toBeGreaterThan(0);
    expect(summary).toContain("variants: 6 main, 2 exploratory");
    expect(summary.slice(0, heading)).not.toContain("beta-noqty");
    expect(summary.slice(0, heading)).not.toContain("gamma-partial");
    expect(summary.slice(heading)).toMatch(/beta-noqty\s+2\/2/);
    expect(summary.slice(heading)).toContain("gamma-partial");
    expect(summary.slice(0, heading)).toMatch(/alpha-good\s+5\/5/);

    const detail = result.reports["detail.txt"];
    const detailHeading = detail.indexOf("EXPLORATORY VARIANTS");
    expect(detail.indexOf("MAIN VARIANTS")).toBeGreaterThanOrEqual(0);
    expect(detail.slice(0, detailHeading)).not.toContain("beta-noqty");
    expect(detail.slice(detailHeading)).toContain("beta-noqty");

    const json = JSON.parse(result.reports["scores.json"]) as ScoreRun;
    expect(json.variants.filter((v) => v.group === "exploratory").map((v) => v.variant).sort()).toEqual(["beta-noqty", "gamma-partial"]);
    expect(findLeaks(summary + detail + result.reports["scores.json"], null)).toEqual([]);
  });

  test("the cross-engine sweep is blind: every readable scan page of one family against every one of the other", () => {
    expect(defaultRun.mergeSweeps.length).toBeGreaterThan(0);
    for (const sweep of defaultRun.mergeSweeps) {
      expect(sweep.families[0] < sweep.families[1]).toBe(true);
      expect(sweep.combos).toBe(sweep.pagesA * sweep.pagesB);
      expect(Object.values(sweep.status).reduce((a, b) => a + b, 0)).toBe(sweep.combos);
      expect(sweep.gatePasses).toBeLessThanOrEqual(sweep.combos);
      expect(sweep.falseAccepts).toBe(0);
      expect(sweep.alignedByAnchors + sweep.alignedByAmounts).toBeLessThanOrEqual(sweep.combos);
    }
    const betaGamma = defaultRun.mergeSweeps.find((s) => s.families[0] === "beta" && s.families[1] === "gamma");
    expect(betaGamma).toMatchObject({ pagesA: 1, pagesB: 1, combos: 1, gatePasses: 1, falseAccepts: 0 });
    expect(betaGamma?.status).toEqual({ ok: 1 });
    const alphaBeta = defaultRun.mergeSweeps.find((s) => s.families[0] === "alpha" && s.families[1] === "beta");
    expect(alphaBeta).toMatchObject({ pagesA: 6, pagesB: 1, combos: 6 });
    expect(alphaBeta?.status).toEqual({ ok: 4, PF: 2 });
    const alphaDelta = defaultRun.mergeSweeps.find((s) => s.families[0] === "alpha" && s.families[1] === "delta");
    expect(alphaDelta).toMatchObject({ combos: 6, gatePasses: 0, withConflict: 4 });
    const families = new Set(defaultRun.mergeSweeps.flatMap((s) => s.families));
    expect(families.has("eps")).toBe(false);
    expect(families.has("zeta")).toBe(false);
    const summary = renderSummary(defaultRun);
    expect(summary).toContain("CROSS-ENGINE SWEEP");
    expect(summary).toMatch(/beta x gamma\s+1 x 1\s+1/);
  });

  test("the sweep reports no combinations when fewer than two families are readable", () => {
    const sweeps = runMergeSweeps([{ variant: "solo-a", family: "solo", pages: [] }], () => "", null);
    expect(sweeps).toEqual([]);
    const run = { ...defaultRun, mergeSweeps: [] };
    expect(renderSummary(run)).toContain("(fewer than two engine families with a readable scan page)");
  });
});

describe("command line", () => {
  test("parseArgs separates the command from flags", () => {
    expect(parseArgs(["score", "--bench", "/x", "--keep"])).toEqual({ command: "score", flags: { bench: "/x", keep: true } });
    expect(parseArgs([])).toEqual({ command: null, flags: {} });
  });

  test("usage errors return 2 and print only the usage text", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(main([])).toBe(2);
      expect(main(["bogus", "--bench", "/x"])).toBe(2);
      expect(main(["score"])).toBe(2);
      expect(main(["derive-gt", "--bench", "/x"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  test("derive-gt, score and synthetic run end to end under a temp dir", () => {
    const dir = tempDir("cli");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      writeSyntheticFleet(path.join(dir, "out"), INV);
      writeSyntheticLibrary(path.join(dir, "libocr"), INV, "fffd2e6c", "2be05f77");
      expect(main(["derive-gt", "--bench", dir, "--libocr", path.join(dir, "libocr")])).toBe(0);
      expect(fs.existsSync(path.join(dir, "gt", "scan.json"))).toBe(true);
      expect(main(["score", "--bench", dir, "--libocr", path.join(dir, "libocr")])).toBe(0);
      expect(fs.existsSync(path.join(dir, "report", "summary.txt"))).toBe(true);
      expect(main(["synthetic"])).toBe(0);
      const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain("derive-gt: ok=true renders=3 lines=8 gatePass=true");
      expect(findLeaks(printed, GT)).toEqual([]);
    } finally {
      log.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a leak-guard trip is a failure exit with a masked message", () => {
    const dir = tempDir("leakcli");
    const err = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      writeSyntheticVariant(path.join(dir, "out"), INV, { variant: "bad-12.34", pages: [{ doc: "scan", dpi: 150, layout: "rows" }] });
      expect(main(["score", "--bench", dir])).toBe(1);
      expect(fs.existsSync(path.join(dir, "report", "summary.txt"))).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).toContain("score failed");
    } finally {
      err.mockRestore();
      log.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
