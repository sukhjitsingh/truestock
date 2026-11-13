/**
 * OCR bench scorer: reads BENCH/out/<variant>/*.json (engine outputs, see ../README.md), scores each page against
 * the ground truth, runs the REAL template + gate on every page, runs a cross-engine merge experiment, and writes
 * structure-only reports.
 *
 *   bun scripts/ocr-bench/score/score.ts derive-gt --bench <dir> --libocr <dir>
 *   bun scripts/ocr-bench/score/score.ts score     --bench <dir> --libocr <dir>
 *   bun scripts/ocr-bench/score/score.ts synthetic [--keep]
 *
 * `--bench <dir>` means <dir>/out (engine results, read), <dir>/gt (ground truth), <dir>/report (written); each can be
 * overridden with --out / --gt / --report. Privacy: reports contain counts, booleans, codes, masked error text and
 * percentages with at most one decimal. They never contain a money value, a description, or any text from a
 * document. `findLeaks` enforces that on everything written, and nothing is written when it objects.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  STATUS_CODE,
  type EngineStats,
  type GroundTruth,
  type MergeOutcome,
  type Multiset,
  type Prf,
  type QtySummary,
  type Ratio,
  type TemplateOutcome,
  type WordLike,
  agreedMultiset,
  deriveGroundTruth,
  deriveTolerated,
  descriptionRecall,
  engineStats,
  fmt,
  fmtRatio,
  gtMoneyMultiset,
  gtTolerated,
  intersectionSize,
  maskText,
  mergeLenient,
  moneyCentsOf,
  multisetSize,
  ratioValue,
  readLenient,
  renderTable,
  runTemplate,
  scoreMultiset,
  scoreQuantities,
  summarizeQuantities,
  toMultiset,
  unionMultiset,
  wordsOf,
} from "./core";
import { buildInvoice, writeSyntheticFleet, writeSyntheticLibrary } from "./synth";

// ---------------------------------------------------------------------------------------------------------------
// raw files

export type Doc = "scan" | "photo";

export interface PageRead {
  key: string;
  doc: Doc;
  dpi: number;
  /** 1 for the page itself; 2.. for the repeat passes some variants write (`scanp2-d150.json`) to measure steady state. */
  pass: number;
  ok: boolean;
  /** Masked (letters -> a, digits -> 9) and truncated. */
  error: string | null;
  markdown: string;
  words: WordLike[];
  inferMs: number | null;
}

export interface RunInfo {
  loadMs: number | null;
  maxRssMb: number | null;
  cgroupPeakMb: number | null;
  threadsObserved: number | null;
  exitReason: string | null;
}

export interface DockerInfo {
  status: string | null;
  oomKilled: boolean | null;
  exitCode: number | null;
  timedOut: boolean | null;
  wallSec: number | null;
  mem: string | null;
  cpus: number | null;
}

export interface LoadedVariant {
  variant: string;
  family: string;
  pages: PageRead[];
  /** Repeat passes (pass >= 2): timing and determinism samples, never scored as pages. */
  repeats: PageRead[];
  run: RunInfo | null;
  docker: DockerInfo | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Measurements are kept to one decimal: a two-decimal number in a report would look like a money token. */
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const asBool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
/** A short code-like string (a status or exit reason); anything else is masked so free text can not leak. */
const asCode = (value: unknown): string | null => {
  if (typeof value !== "string" || value === "") return null;
  return /^[A-Za-z0-9_.:-]{1,40}$/.test(value) ? value : maskText(value).slice(0, 40);
};

/** Harness-written error codes that carry no document content and are more useful unmasked. Anything else is masked. */
const KNOWN_ERRORS = new Set(["oom-killed", "skipped", "timeout", "no-run-file", "unreadable-json", "no-markdown", "error-object"]);

/** A known harness code as is (including "timeout after N ms"); any other text masked (letters -> a, digits -> 9) and cut. */
export function errorText(text: string): string {
  return KNOWN_ERRORS.has(text) || /^timeout after \d+ ms$/.test(text) ? text : maskText(text).slice(0, 60);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** First value stored under `key` anywhere in the nested objects (arrays are not entered). */
export function deepFind(value: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || !isRecord(value)) return undefined;
  if (key in value) return value[key];
  for (const child of Object.values(value)) {
    const hit = deepFind(child, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function readPage(file: string, doc: Doc, dpi: number, pass = 1): PageRead {
  const key = pass === 1 ? `${doc}-d${dpi}` : `${doc}p${pass}-d${dpi}`;
  const json = readJson(file);
  if (!isRecord(json)) return { key, doc, dpi, pass, ok: false, error: "unreadable-json", markdown: "", words: [], inferMs: null };
  const hasMarkdown = typeof json.markdown === "string";
  let error: string | null = null;
  if (typeof json.error === "string" && json.error !== "") error = errorText(json.error);
  else if (json.error !== null && json.error !== undefined && json.error !== "") error = "error-object";
  else if (!hasMarkdown) error = "no-markdown";
  const timings = isRecord(json.timings) ? json.timings : {};
  return {
    key,
    doc,
    dpi,
    pass,
    ok: error === null,
    error,
    markdown: hasMarkdown ? (json.markdown as string) : "",
    words: Array.isArray(json.words) ? (json.words as WordLike[]) : [],
    inferMs: asNumber(timings.inferMs),
  };
}

export const familyOf = (variant: string): string => variant.split("-")[0];

export function loadVariant(root: string, variant: string): LoadedVariant {
  const dir = path.join(root, variant);
  const pages: PageRead[] = [];
  const repeats: PageRead[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    const match = /^(scan|photo)(?:p(\d+))?-d(\d+)\.json$/.exec(file);
    if (!match) continue;
    const pass = match[2] === undefined ? 1 : Number(match[2]);
    (pass === 1 ? pages : repeats).push(readPage(path.join(dir, file), match[1] as Doc, Number(match[3]), pass));
  }
  pages.sort((a, b) => (a.doc === b.doc ? a.dpi - b.dpi : a.doc === "scan" ? -1 : 1));

  const runJson = readJson(path.join(dir, "_run.json"));
  const run: RunInfo | null = isRecord(runJson)
    ? {
        loadMs: asNumber(runJson.loadMs),
        maxRssMb: asNumber(runJson.maxRssMb),
        cgroupPeakMb: asNumber(runJson.cgroupPeakMb),
        threadsObserved: asNumber(deepFind(runJson, "threadsObserved")),
        exitReason: asCode(runJson.exitReason),
      }
    : null;
  const dockerJson = readJson(path.join(dir, "_docker.json"));
  const docker: DockerInfo | null = isRecord(dockerJson)
    ? {
        status: asCode(dockerJson.status),
        oomKilled: asBool(dockerJson.oomKilled),
        exitCode: asNumber(dockerJson.exitCode),
        timedOut: asBool(dockerJson.timedOut),
        wallSec: asNumber(dockerJson.wallSec),
        mem: asCode(dockerJson.mem),
        cpus: asNumber(dockerJson.cpus),
      }
    : null;
  return { variant, family: familyOf(variant), pages, repeats, run, docker };
}

/** Every variant directory under `root`, skipping names that start with `_` or `.` (scratch, proofs of the harness). */
export function loadOutDir(root: string): LoadedVariant[] {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => loadVariant(root, name));
}

export function isGroundTruth(value: unknown): value is GroundTruth {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.lines) || !isRecord(value.header) || !isRecord(value.gate)) return false;
  if (asNumber(value.header.printedTotalCents) === null || !Array.isArray(value.tolerated)) return false;
  return value.lines.every(
    (line) =>
      isRecord(line) &&
      asNumber(line.qty) !== null &&
      asNumber(line.unitCents) !== null &&
      asNumber(line.extCents) !== null &&
      asNumber(line.grossCents) !== null &&
      Array.isArray(line.descTokens),
  );
}

export function loadGroundTruth(file: string): GroundTruth | null {
  const json = readJson(file);
  return isGroundTruth(json) ? json : null;
}

export interface LibraryRender {
  dpi: number;
  markdown: string;
}

export interface Library {
  scan: LibraryRender[];
  photo: LibraryRender[];
}

/** Library-OCR markdown named `<anything>-dpi<N>-<8 hex id>.md`; only the listed dpis are used. */
export function loadLibrary(dir: string | null, scanId: string, photoId: string, dpis: readonly number[]): Library {
  const out: Library = { scan: [], photo: [] };
  if (dir === null) return out;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const match = /dpi(\d+)-([0-9a-f]{8})\.md$/.exec(file);
    if (!match || !dpis.includes(Number(match[1]))) continue;
    const render = { dpi: Number(match[1]), markdown: fs.readFileSync(path.join(dir, file), "utf8") };
    if (match[2] === scanId) out.scan.push(render);
    else if (match[2] === photoId) out.photo.push(render);
  }
  out.scan.sort((a, b) => a.dpi - b.dpi);
  out.photo.sort((a, b) => a.dpi - b.dpi);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ground truth derivation

export interface DeriveSummary {
  ok: boolean;
  renders: number;
  lines: number | null;
  gatePass: boolean | null;
  independentCheck: boolean | null;
  exactArithmetic: boolean | null;
  fieldConflicts: number | null;
  /** Extra copies of non-line money tolerated by the precision metric. */
  toleratedCopies: number | null;
  /** Why not, as a code. */
  why: string | null;
}

export function deriveGtFromLibrary(library: Library, gtDir: string): DeriveSummary {
  const markdowns = library.scan.map((render) => render.markdown);
  const none: DeriveSummary = { ok: false, renders: markdowns.length, lines: null, gatePass: null, independentCheck: null, exactArithmetic: null, fieldConflicts: null, toleratedCopies: null, why: null };
  if (markdowns.length < 2) return { ...none, why: "fewer-than-2-renders" };
  const derived = deriveGroundTruth(markdowns);
  if (!derived.ok) return { ...none, gatePass: false, fieldConflicts: derived.fieldConflicts, why: derived.sameShape ? "gate-failed-on-consensus" : "renders-differ-in-shape" };
  const gt: GroundTruth = { ...derived.gt, tolerated: deriveTolerated(derived.gt, markdowns) };
  fs.mkdirSync(gtDir, { recursive: true });
  fs.writeFileSync(path.join(gtDir, "scan.json"), `${JSON.stringify(gt, null, 1)}\n`, { mode: 0o600 });
  return {
    ok: true,
    renders: markdowns.length,
    lines: gt.lines.length,
    gatePass: gt.gate.pass,
    independentCheck: gt.gate.independentCheck,
    exactArithmetic: gt.gate.exactArithmetic,
    fieldConflicts: gt.gate.fieldConflicts,
    toleratedCopies: gt.tolerated.reduce((sum, entry) => sum + entry.extra, 0),
    why: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// per-page scoring

/** Percentage with at most one decimal (a two-decimal figure would look like a money token). */
export const pct1 = (value: number | null): number | null => (value === null ? null : Math.round(value * 1000) / 10);

export interface PrfPct {
  tp: number;
  fp: number;
  fn: number;
  expected: number;
  observed: number;
  precisionPct: number | null;
  recallPct: number | null;
  f1Pct: number | null;
}

export const toPrfPct = (prf: Prf): PrfPct => ({
  tp: prf.tp,
  fp: prf.fp,
  fn: prf.fn,
  expected: prf.expected,
  observed: prf.observed,
  precisionPct: pct1(prf.precision),
  recallPct: pct1(prf.recall),
  f1Pct: pct1(prf.f1),
});

export interface StatsPct {
  words: number;
  meanConfPct: number | null;
  rows: number;
  mdChars: number;
  moneyTokens: number;
  dollarPct: number | null;
}

export const toStatsPct = (stats: EngineStats): StatsPct => ({
  words: stats.words,
  meanConfPct: pct1(stats.meanConf),
  rows: stats.rows,
  mdChars: stats.mdChars,
  moneyTokens: stats.moneyTokens,
  dollarPct: pct1(stats.dollarFraction),
});

/** Photo only, and only a cross-check: there is no ground truth for the photo. */
export interface XCheck {
  /** Money tokens the library OCR renders agree on (at least two of them, or the only one). */
  reference: number;
  /** Of those, how many the engine also read. */
  found: number;
  engineTokens: number;
  /** Engine tokens that appear in at least one library render. */
  inLibrary: number;
}

export interface PageScore {
  variant: string;
  family: string;
  doc: Doc;
  dpi: number;
  key: string;
  ok: boolean;
  error: string | null;
  inferMs: number | null;
  stats: StatsPct | null;
  money: PrfPct | null;
  qty: QtySummary | null;
  desc: Ratio | null;
  template: TemplateOutcome | null;
  xcheck: XCheck | null;
}

function safeRunTemplate(markdown: string, gt?: GroundTruth): TemplateOutcome {
  try {
    return runTemplate(markdown, gt);
  } catch {
    return { status: "parse-failed", lineCount: null, gatePass: null, failedChecks: {}, failureKind: "threw", failureRow: null, failureAmounts: null, detectHits: null, exactVsGt: null, falseAccept: null };
  }
}

export function photoCrossCheck(markdown: string, librarySets: readonly Multiset[]): XCheck | null {
  if (librarySets.length === 0) return null;
  const reference = agreedMultiset(librarySets, Math.min(2, librarySets.length));
  const observed = toMultiset(moneyCentsOf(markdown));
  return {
    reference: multisetSize(reference),
    found: intersectionSize(reference, observed),
    engineTokens: multisetSize(observed),
    inLibrary: intersectionSize(observed, unionMultiset(librarySets)),
  };
}

export interface ScoreContext {
  gt: GroundTruth | null;
  libraryPhotoSets: Multiset[];
}

export function scorePage(variant: string, page: PageRead, ctx: ScoreContext): PageScore {
  const base = { variant, family: familyOf(variant), doc: page.doc, dpi: page.dpi, key: page.key, ok: page.ok, error: page.error, inferMs: page.inferMs };
  const empty = { stats: null, money: null, qty: null, desc: null, template: null, xcheck: null };
  if (!page.ok) return { ...base, ...empty };
  const gt = page.doc === "scan" ? ctx.gt : null;
  const result: PageScore = {
    ...base,
    ...empty,
    stats: toStatsPct(engineStats(page.words, page.markdown)),
    template: safeRunTemplate(page.markdown, gt ?? undefined),
  };
  if (gt) {
    result.money = toPrfPct(scoreMultiset(gtMoneyMultiset(gt), toMultiset(moneyCentsOf(page.markdown)), gtTolerated(gt)));
    result.qty = summarizeQuantities(scoreQuantities(page.markdown, gt.lines));
    result.desc = descriptionRecall(page.markdown, gt.lines);
  }
  if (page.doc === "photo") result.xcheck = photoCrossCheck(page.markdown, ctx.libraryPhotoSets);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// ranking and the merge experiment

function statusRank(template: TemplateOutcome): number {
  if (template.status === "ok") return template.falseAccept === true ? 2 : 4;
  if (template.status === "gate-failed") return 3;
  if (template.status === "parse-failed") return 1;
  return 0;
}

/** Higher is better; compared lexicographically. Template outcome first, then fidelity to the ground truth, then speed. */
export function rankKey(page: PageScore): number[] {
  const template = page.template;
  return [
    template ? statusRank(template) : -1,
    template?.exactVsGt?.hit ?? 0,
    page.money?.f1Pct ?? 0,
    ratioValue(page.qty?.adjacent ?? { hit: 0, of: 0 }) ?? 0,
    -(page.inferMs ?? 1e9),
  ];
}

export function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function bestPage(pages: readonly PageScore[]): PageScore | null {
  let best: PageScore | null = null;
  for (const page of pages) {
    if (!page.ok || !page.template) continue;
    if (best === null || compareRank(rankKey(page), rankKey(best)) > 0) best = page;
  }
  return best;
}

export interface MergeInput {
  variant: string;
  dpi: number;
  status: string;
  gatePass: boolean | null;
}

export interface MergeEntry {
  kind: "pair" | "all" | "multi-dpi";
  label: string;
  inputs: MergeInput[];
  outcome: MergeOutcome;
}

function mergeInputOf(page: PageScore): MergeInput {
  return { variant: page.variant, dpi: page.dpi, status: page.template ? STATUS_CODE[page.template.status] : "n/a", gatePass: page.template?.gatePass ?? null };
}

const labelOf = (pages: readonly PageScore[]): string => pages.map((p) => `${p.variant}@${p.dpi}`).join(" + ");

export interface FamilyBest {
  family: string;
  page: PageScore;
}

export function bestPerFamily(variants: readonly { family: string; pages: readonly PageScore[] }[]): FamilyBest[] {
  const byFamily = new Map<string, PageScore[]>();
  for (const variant of variants) {
    const list = byFamily.get(variant.family) ?? [];
    list.push(...variant.pages.filter((p) => p.doc === "scan"));
    byFamily.set(variant.family, list);
  }
  const out: FamilyBest[] = [];
  for (const family of [...byFamily.keys()].sort()) {
    const page = bestPage(byFamily.get(family) ?? []);
    if (page) out.push({ family, page });
  }
  return out;
}

/**
 * Merge experiment (scratch, scan only): the best single-resolution output of each engine family, merged field by
 * field by the earlier consensus rule, then through the real template + gate. Pairs of families, all families
 * together, and each family's best variant merged across its own resolutions (the earlier 3-render consensus, applied
 * to the new engine). "Best" is chosen with the ground truth, so these results are an optimistic picture of what a
 * blind choice would give.
 */
export function runMergeExperiment(
  variants: readonly { variant: string; family: string; pages: readonly PageScore[] }[],
  markdownOf: (variant: string, key: string) => string,
  gt: GroundTruth | null,
): MergeEntry[] {
  const cache = new Map<string, ReturnType<typeof readLenient>>();
  const read = (page: PageScore) => {
    const id = `${page.variant}/${page.key}`;
    if (!cache.has(id)) cache.set(id, readLenient(markdownOf(page.variant, page.key)));
    return cache.get(id) ?? null;
  };
  const entries: MergeEntry[] = [];
  const run = (kind: MergeEntry["kind"], pages: PageScore[]) => {
    entries.push({ kind, label: labelOf(pages), inputs: pages.map(mergeInputOf), outcome: mergeLenient(pages.map(read), gt ?? undefined) });
  };
  const bests = bestPerFamily(variants);
  for (let i = 0; i < bests.length; i++) for (let j = i + 1; j < bests.length; j++) run("pair", [bests[i].page, bests[j].page]);
  if (bests.length > 2) run("all", bests.map((entry) => entry.page));
  for (const entry of bests) {
    const own = variants.find((v) => v.variant === entry.page.variant);
    const resolutions = (own?.pages ?? []).filter((p) => p.doc === "scan" && p.ok);
    if (resolutions.length >= 2) run("multi-dpi", resolutions);
  }
  return entries;
}

/**
 * The blind version of the pair experiment: every readable scan page of one engine family against every readable scan
 * page of another (all variants and resolutions given), summarised per family pair. Nothing here is picked using the
 * ground truth, so "no combination passes" is a statement about the engines, not about the choice of inputs.
 */
export interface MergeSweep {
  families: [string, string];
  pagesA: number;
  pagesB: number;
  combos: number;
  /** Counts by merged-page template status code (ok / GF / PF / NT), or "unmergeable" when a side could not be read. */
  status: Record<string, number>;
  gatePasses: number;
  falseAccepts: number;
  withConflict: number;
  alignedByAnchors: number;
  alignedByAmounts: number;
}

export function runMergeSweeps(
  variants: readonly { variant: string; family: string; pages: readonly PageScore[] }[],
  markdownOf: (variant: string, key: string) => string,
  gt: GroundTruth | null,
): MergeSweep[] {
  const byFamily = new Map<string, PageScore[]>();
  for (const variant of variants) {
    const list = byFamily.get(variant.family) ?? [];
    list.push(...variant.pages.filter((p) => p.doc === "scan" && p.ok));
    byFamily.set(variant.family, list);
  }
  const cache = new Map<string, ReturnType<typeof readLenient>>();
  const read = (page: PageScore) => {
    const id = `${page.variant}/${page.key}`;
    if (!cache.has(id)) cache.set(id, readLenient(markdownOf(page.variant, page.key)));
    return cache.get(id) ?? null;
  };
  const families = [...byFamily.keys()].filter((family) => (byFamily.get(family) ?? []).length > 0).sort();
  const sweeps: MergeSweep[] = [];
  for (let i = 0; i < families.length; i++) {
    for (let j = i + 1; j < families.length; j++) {
      const a = byFamily.get(families[i]) ?? [];
      const b = byFamily.get(families[j]) ?? [];
      const sweep: MergeSweep = { families: [families[i], families[j]], pagesA: a.length, pagesB: b.length, combos: 0, status: {}, gatePasses: 0, falseAccepts: 0, withConflict: 0, alignedByAnchors: 0, alignedByAmounts: 0 };
      for (const pa of a) {
        for (const pb of b) {
          const outcome = mergeLenient([read(pa), read(pb)], gt ?? undefined);
          sweep.combos++;
          const code = outcome.template ? STATUS_CODE[outcome.template.status] : "unmergeable";
          sweep.status[code] = (sweep.status[code] ?? 0) + 1;
          if (outcome.template?.gatePass === true) sweep.gatePasses++;
          if (outcome.template?.falseAccept === true) sweep.falseAccepts++;
          if (outcome.conflicts.qty + outcome.conflicts.amounts + outcome.conflicts.total > 0) sweep.withConflict++;
          if (outcome.align === "anchor-order") sweep.alignedByAnchors++;
          if (outcome.align === "amount-token") sweep.alignedByAmounts++;
        }
      }
      sweeps.push(sweep);
    }
  }
  return sweeps;
}

// ---------------------------------------------------------------------------------------------------------------
// the run

/**
 * Variants the bench ran to answer a side question (a knob sweep, a memory cap, a repeat pass, a proof run) carry a
 * suffix naming the knob. They are scored in full but kept out of the headline tables, the best-per-family choice and
 * the merge experiments. Override with `--exploratory <regex>`.
 */
export const EXPLORATORY_PATTERN = /-(?:b\d+|bt\d+|pw\d+|rep\d+|rec\d+|s\d{3,4}|w\d+|m\d+[mg]?)(?:-|$)|^tess-proof/;

export const isExploratory = (variant: string, pattern: RegExp = EXPLORATORY_PATTERN): boolean => pattern.test(variant);

export interface VariantScore {
  variant: string;
  family: string;
  /** "main" variants form the headline matrix; "exploratory" ones are listed separately. */
  group: "main" | "exploratory";
  pagesPresent: number;
  pagesOk: number;
  run: RunInfo | null;
  docker: DockerInfo | null;
  meanScanMs: number | null;
  meanPhotoMs: number | null;
  /** Number of extra passes over the same scan the variant wrote (0 for most variants). */
  repeatPasses: number;
  /** Mean inference ms of the extra passes (warm / steady state), or null. */
  warmScanMs: number | null;
  /** Every extra pass reproduced its first-pass markdown exactly; null when there was nothing to compare. */
  repeatIdentical: boolean | null;
  /** Key of the best-ranked scan page. */
  best: string | null;
  pages: PageScore[];
}

export interface GtSummary {
  lines: number;
  gatePass: boolean;
  independentCheck: boolean;
  exactArithmetic: boolean;
  fieldConflicts: number;
  toleratedCopies: number;
  derivedFromRenders: number;
}

export interface ScoreRun {
  version: 1;
  gt: GtSummary | null;
  library: { scanRenders: number; photoRenders: number };
  scanDpis: number[];
  variants: VariantScore[];
  bestPerFamily: { family: string; variant: string; dpi: number }[];
  merges: MergeEntry[];
  mergeSweeps: MergeSweep[];
}

const mean = (values: readonly number[]): number | null => (values.length > 0 ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);

export function scoreRun(loaded: readonly LoadedVariant[], gt: GroundTruth | null, library: Library, exploratory: RegExp = EXPLORATORY_PATTERN): ScoreRun {
  const ctx: ScoreContext = { gt, libraryPhotoSets: library.photo.map((render) => toMultiset(moneyCentsOf(render.markdown))) };
  const markdowns = new Map<string, string>();
  const variants: VariantScore[] = loaded.map((entry) => {
    const pages = entry.pages.map((page) => {
      markdowns.set(`${entry.variant}/${page.key}`, page.markdown);
      return scorePage(entry.variant, page, ctx);
    });
    const best = bestPage(pages.filter((p) => p.doc === "scan"));
    const timed = (doc: Doc) => pages.filter((p) => p.doc === doc && p.ok && p.inferMs !== null).map((p) => p.inferMs as number);
    const firstPass = new Map(entry.pages.map((p) => [`${p.doc}-d${p.dpi}`, p]));
    const repeatOk = entry.repeats.filter((p) => p.ok);
    const comparable = repeatOk.map((p) => ({ again: p, first: firstPass.get(`${p.doc}-d${p.dpi}`) })).filter((pair) => pair.first?.ok === true);
    return {
      variant: entry.variant,
      family: entry.family,
      group: isExploratory(entry.variant, exploratory) ? "exploratory" : "main",
      pagesPresent: pages.length,
      pagesOk: pages.filter((p) => p.ok).length,
      run: entry.run,
      docker: entry.docker,
      meanScanMs: mean(timed("scan")),
      meanPhotoMs: mean(timed("photo")),
      repeatPasses: new Set(entry.repeats.map((p) => p.pass)).size,
      warmScanMs: mean(repeatOk.filter((p) => p.doc === "scan" && p.inferMs !== null).map((p) => p.inferMs as number)),
      repeatIdentical: comparable.length > 0 ? comparable.every((pair) => pair.again.markdown === pair.first?.markdown) : null,
      best: best?.key ?? null,
      pages,
    };
  });
  const scanDpis = [...new Set(variants.flatMap((v) => v.pages.filter((p) => p.doc === "scan").map((p) => p.dpi)))].sort((a, b) => a - b);
  const mainVariants = variants.filter((v) => v.group === "main");
  const bests = bestPerFamily(mainVariants);
  const markdownOf = (variant: string, key: string) => markdowns.get(`${variant}/${key}`) ?? "";
  return {
    version: 1,
    gt: gt
      ? {
          lines: gt.lines.length,
          gatePass: gt.gate.pass,
          independentCheck: gt.gate.independentCheck,
          exactArithmetic: gt.gate.exactArithmetic,
          fieldConflicts: gt.gate.fieldConflicts,
          toleratedCopies: gt.tolerated.reduce((sum, entry) => sum + entry.extra, 0),
          derivedFromRenders: gt.derivedFrom.renders,
        }
      : null,
    library: { scanRenders: library.scan.length, photoRenders: library.photo.length },
    scanDpis,
    variants,
    bestPerFamily: bests.map((entry) => ({ family: entry.family, variant: entry.page.variant, dpi: entry.page.dpi })),
    merges: runMergeExperiment(mainVariants, markdownOf, gt),
    mergeSweeps: runMergeSweeps(mainVariants, markdownOf, gt),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// reports

const NA = "n/a";
const yn = (value: boolean | null | undefined): string => (value === null || value === undefined ? NA : value ? "Y" : "n");
const num0 = (value: number | null | undefined): string => (value === null || value === undefined ? NA : String(Math.round(value)));
const secs = (ms: number | null | undefined): string => (ms === null || ms === undefined ? NA : fmt(ms / 1000, 1));
const pctRatio = (r: Ratio | null | undefined): string => {
  const v = r ? ratioValue(r) : null;
  return v === null ? NA : fmt(v * 100, 1);
};

function templateCell(variant: VariantScore, dpi: number): string {
  const page = variant.pages.find((p) => p.doc === "scan" && p.dpi === dpi);
  if (!page) return "-";
  if (!page.ok || !page.template) return "ERR";
  return STATUS_CODE[page.template.status];
}

function gateCell(variant: VariantScore, dpi: number): string {
  const page = variant.pages.find((p) => p.doc === "scan" && p.dpi === dpi);
  if (!page) return "-";
  if (!page.ok || !page.template || page.template.gatePass === null) return ".";
  return page.template.gatePass ? "Y" : "n";
}

function oomCell(variant: VariantScore): string {
  const oom = variant.docker?.oomKilled;
  return oom === null || oom === undefined ? NA : oom ? "YES" : "no";
}

function failureText(t: TemplateOutcome | null): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.failureKind) parts.push(`${t.failureKind}${t.failureRow !== null ? `@row${t.failureRow}` : ""}${t.failureAmounts !== null ? `(${t.failureAmounts} amts)` : ""}`);
  const checks = Object.entries(t.failedChecks).map(([name, count]) => `${name}x${count}`);
  if (checks.length > 0) parts.push(checks.join(","));
  if (t.detectHits) parts.push(`detect=${t.detectHits.map((h) => (h ? "1" : "0")).join("")}`);
  return parts.join(" ");
}

export function renderSummary(run: ScoreRun): string {
  const out: string[] = [];
  out.push("OCR bench scoring summary (structure only: counts, booleans, codes; no invoice values)");
  out.push("");
  if (run.gt) {
    out.push(
      `ground truth (scan): ${run.gt.lines} lines; gate pass=${run.gt.gatePass}; independent check=${run.gt.independentCheck}; exact arithmetic=${run.gt.exactArithmetic}; ` +
        `field conflicts=${run.gt.fieldConflicts}; derived from ${run.gt.derivedFromRenders} library renders; non-line money tolerated=${run.gt.toleratedCopies} copies`,
    );
  } else {
    out.push("ground truth (scan): NOT FOUND. Scan pages are scored on engine stats and template status only; money / quantity columns are n/a.");
  }
  const main = run.variants.filter((v) => v.group === "main");
  const exploratory = run.variants.filter((v) => v.group === "exploratory");
  out.push(`variants: ${main.length} main, ${exploratory.length} exploratory (listed separately below); library renders: scan=${run.library.scanRenders}, photo=${run.library.photoRenders}`);
  out.push("");

  const dpis = run.scanDpis;
  const dpiHeader = dpis.join("/");
  const header = ["variant", "pages ok", "best", "money F1%", "qty%", "qty1d%", `tmpl@${dpiHeader}`, `gate@${dpiHeader}`, "s/scan", "s/photo", "s/warm", "repeat=", "cap", "maxRssMb", "cgroupMb", "thr", "oom"];
  const rightAlign = [false, true, true, true, true, true, false, false, true, true, true, false, true, true, true, true, false];
  const variantRows = (list: readonly VariantScore[]) =>
    list.map((variant) => {
      const best = variant.pages.find((p) => p.key === variant.best) ?? null;
      return [
        variant.variant,
        `${variant.pagesOk}/${variant.pagesPresent}`,
        best ? String(best.dpi) : NA,
        best?.money ? fmt(best.money.f1Pct, 1) : NA,
        best?.qty ? pctRatio(best.qty.any) : NA,
        best?.qty ? pctRatio(best.qty.anyOneDigit) : NA,
        dpis.length > 0 ? dpis.map((d) => templateCell(variant, d)).join("/") : NA,
        dpis.length > 0 ? dpis.map((d) => gateCell(variant, d)).join("/") : NA,
        secs(variant.meanScanMs),
        secs(variant.meanPhotoMs),
        variant.repeatPasses > 0 ? secs(variant.warmScanMs) : "-",
        variant.repeatPasses > 0 ? yn(variant.repeatIdentical) : "-",
        variant.docker?.mem ?? NA,
        num0(variant.run?.maxRssMb),
        num0(variant.run?.cgroupPeakMb),
        num0(variant.run?.threadsObserved),
        oomCell(variant),
      ];
    });
  out.push(`PER VARIANT (main). F1 / qty columns are from the best-ranked scan page (dpi in "best"); template and gate are listed per scan dpi ${dpiHeader || NA}.`);
  out.push(main.length > 0 ? renderTable(header, variantRows(main), rightAlign) : "(no main variants)");
  out.push("");
  out.push("legend: tmpl = status of the REAL extractWithOcrTemplate on that page's markdown: ok (template matched and gate passed), GF gate-failed, PF parse-failed, NT no-template, ERR page had an engine error, - no such page.");
  out.push("        gate: Y gate passed, n gate ran and failed, . gate not reached, - no such page. qty% = ground-truth quantities found as standalone small integers in the row carrying that line's amount; qty1d% = only the one-digit ones.");
  out.push("        s/scan, s/photo = mean inference seconds per page (provisional: shared, CPU-contended Docker VM). s/warm = mean seconds of the extra passes over the same scan, repeat= whether every extra pass reproduced pass 1 exactly (- = no extra passes).");
  out.push("        cap = container memory cap; maxRssMb / cgroupMb / thr = process peaks from the run file. Percentages carry one decimal.");
  out.push("");

  out.push("BEST SINGLE-RESOLUTION SCAN OUTPUT PER ENGINE FAMILY (main variants only; chosen with the ground truth: template outcome, then lines matching it, then F1)");
  const familyRows = run.bestPerFamily.map((entry) => {
    const variant = run.variants.find((v) => v.variant === entry.variant);
    const page = variant?.pages.find((p) => p.doc === "scan" && p.dpi === entry.dpi);
    const t = page?.template ?? null;
    return [entry.family, entry.variant, String(entry.dpi), t ? STATUS_CODE[t.status] : NA, t?.lineCount === null || t === null ? NA : String(t.lineCount), yn(t?.gatePass), t?.exactVsGt ? fmtRatio(t.exactVsGt) : NA, page?.money ? fmt(page.money.f1Pct, 1) : NA];
  });
  out.push(renderTable(["family", "variant", "dpi", "tmpl", "lines", "gate", "lines=gt", "money F1%"], familyRows, [false, false, true, false, true, false, true, true]));
  out.push("");

  out.push("PHOTO (main variants; no ground truth). Cross-check only: reference = money tokens the library OCR renders agree on; found = how many of them this engine also read; in-lib = engine tokens that appear in some library render.");
  const photoRows = main.flatMap((variant) =>
    variant.pages
      .filter((p) => p.doc === "photo")
      .map((p) => [
        variant.variant,
        String(p.dpi),
        p.ok ? "ok" : (p.error ?? "err"),
        p.stats ? String(p.stats.words) : NA,
        p.stats ? String(p.stats.moneyTokens) : NA,
        p.stats ? fmt(p.stats.dollarPct, 1) : NA,
        p.xcheck ? `${p.xcheck.found}/${p.xcheck.reference}` : NA,
        p.xcheck ? `${p.xcheck.inLibrary}/${p.xcheck.engineTokens}` : NA,
        p.template ? STATUS_CODE[p.template.status] : NA,
        secs(p.inferMs),
      ]),
  );
  out.push(photoRows.length > 0 ? renderTable(["variant", "dpi", "page", "words", "money tok", "$%", "found/ref", "in-lib", "tmpl", "s"], photoRows, [false, true, false, true, true, true, true, true, false, true]) : "(no photo pages)");
  out.push("");

  out.push("CROSS-ENGINE MERGE EXPERIMENT (main variants; scratch; scan only; per-field merge: an unread field yields to a read value, two differing reads are a conflict; merged rows go through the real template + gate)");
  out.push("  align: anchor-order = both sources found the same item rows in the same order (row-aligned by construction); amount-token = rows were matched by a shared money value because the row sets differed.");
  const mergeRows = run.merges.map((entry) => {
    const o = entry.outcome;
    const t = o.template;
    return [
      entry.kind,
      entry.label,
      entry.inputs.map((i) => i.status).join("+"),
      o.mergeable ? (o.align ?? NA) : (o.why ?? NA),
      o.mergeable ? String(o.rows) : NA,
      o.mergeable ? String(o.unpaired) : NA,
      o.mergeable ? `${o.conflicts.qty}/${o.conflicts.amounts}/${o.conflicts.total}` : NA,
      o.mergeable ? `${o.filled.qty}/${o.filled.amounts}` : NA,
      t ? STATUS_CODE[t.status] : NA,
      t?.lineCount === null || t === null ? NA : String(t.lineCount),
      yn(t?.gatePass),
      t?.exactVsGt ? fmtRatio(t.exactVsGt) : NA,
      yn(t?.falseAccept),
    ];
  });
  out.push(
    mergeRows.length > 0
      ? renderTable(["kind", "inputs", "in", "align", "rows", "unpaired", "confl q/a/t", "filled q/a", "tmpl", "lines", "gate", "lines=gt", "false-accept"], mergeRows, [false, false, false, false, true, true, true, true, false, true, false, true, false])
      : "(fewer than two engine families with a readable scan page, and no variant with two readable resolutions)",
  );
  out.push("  false-accept = the gate passed but the lines are not the ground truth (the worst outcome). Merge inputs were picked using the ground truth, so these results are optimistic.");
  out.push("");

  out.push("CROSS-ENGINE SWEEP (main variants; blind: every readable scan page of one family merged with every readable scan page of another, no input picked with the ground truth)");
  const sweepRows = run.mergeSweeps.map((sweep) => [
    sweep.families.join(" x "),
    `${sweep.pagesA} x ${sweep.pagesB}`,
    String(sweep.combos),
    Object.entries(sweep.status)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => `${code}:${count}`)
      .join(" "),
    String(sweep.gatePasses),
    String(sweep.falseAccepts),
    String(sweep.withConflict),
    `${sweep.alignedByAnchors}/${sweep.alignedByAmounts}`,
  ]);
  out.push(
    sweepRows.length > 0
      ? renderTable(["families", "pages", "combos", "merged status", "gate pass", "false-accept", "with conflict", "align anchors/amounts"], sweepRows, [false, false, true, false, true, true, true, true])
      : "(fewer than two engine families with a readable scan page)",
  );
  out.push("");

  out.push("EXPLORATORY VARIANTS (knob sweeps, memory caps, repeat passes, proofs; same columns as the main table; not in the best-per-family choice, the photo table or the merges)");
  out.push(exploratory.length > 0 ? renderTable(header, variantRows(exploratory), rightAlign) : "(none)");
  out.push("");
  return out.join("\n");
}

export function renderDetail(run: ScoreRun): string {
  const header = ["variant", "doc", "dpi", "page", "words", "mdChars", "moneyTok", "$%", "P%", "R%", "F1%", "tp/fp/fn", "qtyAny%", "qty1d%", "qtyAdj%", "desc%", "tmpl", "lines", "gate", "lines=gt", "false-acc", "s", "failure"];
  const right = header.map((_, i) => i >= 2 && i !== 3 && i !== 16 && i !== 18 && i !== 20 && i !== 22);
  const detailRow = (name: string, p: PageScore): string[] => {
    const t = p.template;
    return [
      name,
      p.doc,
      String(p.dpi),
      p.ok ? "ok" : (p.error ?? "err"),
      p.stats ? String(p.stats.words) : NA,
      p.stats ? String(p.stats.mdChars) : NA,
      p.stats ? String(p.stats.moneyTokens) : NA,
      p.stats ? fmt(p.stats.dollarPct, 1) : NA,
      p.money ? fmt(p.money.precisionPct, 1) : NA,
      p.money ? fmt(p.money.recallPct, 1) : NA,
      p.money ? fmt(p.money.f1Pct, 1) : NA,
      p.money ? `${p.money.tp}/${p.money.fp}/${p.money.fn}` : NA,
      p.qty ? pctRatio(p.qty.any) : NA,
      p.qty ? pctRatio(p.qty.anyOneDigit) : NA,
      p.qty ? pctRatio(p.qty.adjacent) : NA,
      p.desc ? pctRatio(p.desc) : NA,
      t ? STATUS_CODE[t.status] : NA,
      t?.lineCount === null || t === null ? NA : String(t.lineCount),
      yn(t?.gatePass),
      t?.exactVsGt ? fmtRatio(t.exactVsGt) : NA,
      yn(t?.falseAccept),
      secs(p.inferMs),
      failureText(t),
    ];
  };
  const tableFor = (list: readonly VariantScore[]): string => {
    const rows: string[][] = [];
    for (const variant of list) {
      if (variant.pages.length === 0) rows.push([variant.variant, "-", "-", "no pages", ...Array<string>(header.length - 4).fill("")]);
      for (const p of variant.pages) rows.push(detailRow(variant.variant, p));
    }
    return rows.length > 0 ? renderTable(header, rows, right) : "(none)";
  };
  return [
    "OCR bench per-page detail (structure only)",
    "",
    "MAIN VARIANTS",
    tableFor(run.variants.filter((v) => v.group === "main")),
    "",
    "EXPLORATORY VARIANTS (knob sweeps, memory caps, repeat passes, proofs)",
    tableFor(run.variants.filter((v) => v.group === "exploratory")),
    "",
    "P/R/F1 = multiset precision/recall of money tokens vs the ground-truth line amounts and printed total (page money outside the lines that library renders agree on is tolerated, not penalised).",
    "qtyAny = quantity is a standalone small integer in the row carrying the line's amount; qtyAdj = it sits directly before one of the row's own amounts (what the template reads). desc% = ground-truth description words found (relative to the library consensus).",
    "failure: parse/gate failure codes, with the row number and amount count where the parser names them; detect=ab are the template's two detect patterns (1 hit, 0 miss).",
    "",
  ].join("\n");
}

/**
 * What must never appear in a report: a money-shaped token (the reports print at most one decimal, so any `d.dd` is a
 * leak or a bug) and any ground-truth description word that is long, or code-like. Returns problem codes only.
 */
export function findLeaks(text: string, gt: GroundTruth | null): string[] {
  const problems: string[] = [];
  if (/\d[\d,]*\.\d{2}(?!\d)/.test(text)) problems.push("money-shaped-token");
  if (gt) {
    const risky = new Set(
      gt.lines
        .flatMap((line) => line.descTokens)
        .filter((token) => (/^\d+$/.test(token) ? token.length >= 5 : /\d/.test(token) ? token.length >= 4 : token.length >= 7)),
    );
    if (wordsOf(text).some((word) => risky.has(word))) problems.push("ground-truth-description-token");
  }
  return problems;
}

export interface Reports {
  "summary.txt": string;
  "detail.txt": string;
  "scores.json": string;
}

export function buildReports(run: ScoreRun, gt: GroundTruth | null): Reports {
  const reports: Reports = {
    "summary.txt": renderSummary(run),
    "detail.txt": renderDetail(run),
    "scores.json": `${JSON.stringify(run, null, 1)}\n`,
  };
  for (const [name, text] of Object.entries(reports)) {
    const problems = findLeaks(text, gt);
    if (problems.length > 0) throw new Error(`leak guard: ${name}: ${problems.join(", ")}`);
  }
  return reports;
}

export function writeReports(reportDir: string, reports: Reports): void {
  fs.mkdirSync(reportDir, { recursive: true });
  for (const [name, text] of Object.entries(reports)) fs.writeFileSync(path.join(reportDir, name), text);
}

// ---------------------------------------------------------------------------------------------------------------
// orchestration and CLI

export interface Paths {
  out: string;
  gt: string;
  report: string;
  libocr: string | null;
}

export interface IdOptions {
  scanId: string;
  photoId: string;
  dpis: number[];
}

export const DEFAULT_IDS: IdOptions = { scanId: "fffd2e6c", photoId: "2be05f77", dpis: [100, 150, 200] };

export function runScoring(paths: Paths, ids: IdOptions = DEFAULT_IDS, exploratory: RegExp = EXPLORATORY_PATTERN): { run: ScoreRun; reports: Reports } {
  const gt = loadGroundTruth(path.join(paths.gt, "scan.json"));
  const library = loadLibrary(paths.libocr, ids.scanId, ids.photoId, ids.dpis);
  const run = scoreRun(loadOutDir(paths.out), gt, library, exploratory);
  const reports = buildReports(run, gt);
  writeReports(paths.report, reports);
  return { run, reports };
}

/** Full pipeline on invented data under `baseDir`: fleet of engine outputs, library, ground truth, scoring. */
export function runSynthetic(baseDir: string, seed = 7): { run: ScoreRun; reports: Reports; derive: DeriveSummary; paths: Paths } {
  const paths: Paths = { out: path.join(baseDir, "out"), gt: path.join(baseDir, "gt"), report: path.join(baseDir, "report"), libocr: path.join(baseDir, "libocr") };
  const invoice = buildInvoice(seed);
  writeSyntheticFleet(paths.out, invoice);
  writeSyntheticLibrary(paths.libocr as string, invoice, DEFAULT_IDS.scanId, DEFAULT_IDS.photoId);
  const derive = deriveGtFromLibrary(loadLibrary(paths.libocr, DEFAULT_IDS.scanId, DEFAULT_IDS.photoId, DEFAULT_IDS.dpis), paths.gt);
  return { ...runScoring(paths), derive, paths };
}

export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else if (command === null) command = arg;
  }
  return { command, flags };
}

const USAGE = [
  "usage: score.ts derive-gt --bench <dir> --libocr <dir>   (writes <bench>/gt/scan.json; prints counts and booleans only)",
  "       score.ts score     --bench <dir> [--libocr <dir>] (reads <bench>/out and <bench>/gt/scan.json; writes <bench>/report/)",
  "       score.ts synthetic [--keep]                       (invented data under the temp dir; the dry run)",
  "overrides: --out <dir> --gt <dir> --report <dir>; ids: --scan-id <8 hex> --photo-id <8 hex>",
  "exploratory variants (listed apart from the main matrix): default pattern is EXPLORATORY_PATTERN; override with --exploratory <regex>",
].join("\n");

function pathsFrom(flags: Record<string, string | true>): Paths | null {
  const str = (name: string): string | null => (typeof flags[name] === "string" ? (flags[name] as string) : null);
  const bench = str("bench");
  const pick = (name: string, sub: string): string | null => str(name) ?? (bench ? path.join(bench, sub) : null);
  const out = pick("out", "out");
  const gt = pick("gt", "gt");
  const report = pick("report", "report");
  if (out === null || gt === null || report === null) return null;
  return { out, gt, report, libocr: str("libocr") };
}

export function main(argv: readonly string[]): number {
  const { command, flags } = parseArgs(argv);
  const ids: IdOptions = {
    scanId: typeof flags["scan-id"] === "string" ? (flags["scan-id"] as string) : DEFAULT_IDS.scanId,
    photoId: typeof flags["photo-id"] === "string" ? (flags["photo-id"] as string) : DEFAULT_IDS.photoId,
    dpis: DEFAULT_IDS.dpis,
  };
  try {
    if (command === "synthetic") {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "ocrb-synth-"));
      const { reports, derive } = runSynthetic(base);
      console.log(`synthetic ground truth: ok=${derive.ok} lines=${derive.lines} gatePass=${derive.gatePass}`);
      console.log(reports["summary.txt"]);
      if (flags.keep === true) console.log(`kept: ${base}`);
      else fs.rmSync(base, { recursive: true, force: true });
      return 0;
    }
    const paths = pathsFrom(flags);
    if (command === null || paths === null || (command !== "derive-gt" && command !== "score")) {
      console.error(USAGE);
      return 2;
    }
    if (command === "derive-gt") {
      if (paths.libocr === null) {
        console.error("derive-gt needs --libocr <dir>");
        return 2;
      }
      const summary = deriveGtFromLibrary(loadLibrary(paths.libocr, ids.scanId, ids.photoId, ids.dpis), paths.gt);
      console.log(
        `derive-gt: ok=${summary.ok} renders=${summary.renders} lines=${summary.lines} gatePass=${summary.gatePass} independentCheck=${summary.independentCheck} ` +
          `exactArithmetic=${summary.exactArithmetic} fieldConflicts=${summary.fieldConflicts} toleratedCopies=${summary.toleratedCopies} why=${summary.why}`,
      );
      return summary.ok ? 0 : 1;
    }
    const exploratory = typeof flags.exploratory === "string" ? new RegExp(flags.exploratory) : EXPLORATORY_PATTERN;
    const { reports } = runScoring(paths, ids, exploratory);
    console.log(reports["summary.txt"]);
    console.log(`wrote summary.txt, detail.txt, scores.json to ${paths.report}`);
    return 0;
  } catch (error) {
    // Error text can only come from this program's own checks (the leak guard names a file and a code, not content).
    console.error(`score failed: ${error instanceof Error ? maskText(error.message).slice(0, 120) : "unknown"}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
