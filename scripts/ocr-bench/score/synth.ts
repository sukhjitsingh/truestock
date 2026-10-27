/**
 * SYNTHETIC invoice and engine-output generator for the scorer's tests and dry run. Every name, code, amount and date
 * here is invented; nothing is derived from a real document. The layouts imitate the SHAPES the real engines produce
 * (a pipe table, a reflowed stream with the quantity glued onto the price, one visual row per line) so the scorer can
 * be exercised end to end before, and independently of, any real engine output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { formatCents } from "@/lib/domain/ocr-template/money";

export type PackWord = "Keg" | "Bottle" | "Can";

export interface SynthRow {
  kind: "product" | "deposit-return" | "deposit";
  code: string;
  name: string;
  pack: string;
  packWord: PackWord | null;
  qty: number;
  unitCents: number;
  /** A keg deposit folded into the row's TOTAL column (per unit). */
  embeddedDepositCents: number;
}

export interface SynthInvoice {
  rows: SynthRow[];
  totalCents: number;
}

export const netOf = (row: SynthRow): number => row.qty * row.unitCents;

export function grossOf(row: SynthRow): number {
  if (row.kind === "deposit-return") return -netOf(row);
  if (row.kind === "deposit") return netOf(row);
  return netOf(row) + row.qty * row.embeddedDepositCents;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Sample Pale Ale",
  "Sample Lager",
  "Sample Stout",
  "Sample Hard Cider",
  "Sample Seltzer Mango",
  "Sample Seltzer Lime",
  "Sample Wheat Ale",
  "Sample Amber",
  "Sample Porter",
  "Sample Pilsner",
  "Sample Cola",
  "Sample Ginger Beer",
];

const PACKS: readonly (readonly [string, PackWord])[] = [
  ["1/2", "Keg"],
  ["1/6", "Keg"],
  ["1/4", "Keg"],
  ["4/6", "Bottle"],
  ["6/4", "Can"],
  ["24/1", "Can"],
];

/** A deterministic invoice: one keg-deposit credit row, then `productRows` item rows (one of them a two-digit quantity). */
export function buildInvoice(seed: number, productRows = 7): SynthInvoice {
  const rng = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
  const rows: SynthRow[] = [
    { kind: "deposit-return", code: "", name: "1/6 KEG EMPTY DEPOSIT", pack: "", packWord: null, qty: 1 + Math.floor(rng() * 3), unitCents: 2500, embeddedDepositCents: 0 },
  ];
  const usedCodes = new Set<string>();
  for (let i = 0; i < productRows; i++) {
    const [pack, packWord] = pick(PACKS);
    let code = String(1000 + Math.floor(rng() * 89000));
    while (usedCodes.has(code)) code = String(Number(code) + 1);
    usedCodes.add(code);
    rows.push({
      kind: "product",
      code,
      name: NAMES[i % NAMES.length],
      pack,
      packWord,
      qty: i === 5 ? 12 : 1 + Math.floor(rng() * 4),
      unitCents: 1500 + 25 * Math.floor(rng() * 560),
      embeddedDepositCents: packWord === "Keg" ? pick([2500, 5000]) : 0,
    });
  }
  return { rows, totalCents: rows.reduce((sum, row) => sum + grossOf(row), 0) };
}

export type Layout = "rows" | "pipe" | "reflow";

export interface RenderOptions {
  /** Strip every `$` (an engine that drops the currency sign). */
  dropDollar?: boolean;
  /** 0-based rows whose quantity is not printed (an unread field). */
  dropQtyRows?: readonly number[];
  /** Keep only the first `keep` of a row's three amounts (a partial read). */
  dropAmountRows?: readonly { row: number; keep: number }[];
  wrongQty?: readonly { row: number; qty: number }[];
  wrongAmount?: readonly { row: number; which: 0 | 1 | 2; deltaCents: number }[];
  dropRows?: readonly number[];
  omitTotal?: boolean;
  /** Printed total override. */
  totalCents?: number;
  /** Leave out the "Load Sheet" label. */
  noLoadSheet?: boolean;
}

function moneyCell(cents: number, dollar: boolean): string {
  const body = `${dollar ? "$" : ""}${formatCents(Math.abs(cents), 2)}`;
  return cents < 0 ? `(${body})` : body;
}

interface RowCells {
  lead: string;
  qty: string | null;
  amounts: string[];
}

function rowCells(inv: SynthInvoice, index: number, opts: RenderOptions): RowCells | null {
  if (opts.dropRows?.includes(index)) return null;
  const row = inv.rows[index];
  const dollar = !opts.dropDollar;
  const values = [row.unitCents, netOf(row), grossOf(row)];
  for (const fix of opts.wrongAmount ?? []) if (fix.row === index) values[fix.which] += fix.deltaCents;
  let amounts = values.map((v) => moneyCell(v, dollar));
  const partial = opts.dropAmountRows?.find((entry) => entry.row === index);
  if (partial) amounts = amounts.slice(0, partial.keep);
  let qtyValue: number | null = row.qty;
  for (const fix of opts.wrongQty ?? []) if (fix.row === index) qtyValue = fix.qty;
  if (opts.dropQtyRows?.includes(index)) qtyValue = null;
  const lead = row.kind === "product" ? `${row.code} ${row.name} ${row.pack} ${row.packWord}` : row.name;
  const qty = qtyValue === null ? null : row.kind === "product" ? String(qtyValue) : `Refused (${qtyValue})`;
  return { lead, qty, amounts };
}

/** Renders the invoice the way one engine family's markdown looks, with optional degradations. */
export function renderMarkdown(inv: SynthInvoice, layout: Layout, opts: RenderOptions = {}): string {
  const dollar = !opts.dropDollar;
  const out: string[] = [];
  const total = moneyCell(opts.totalCents ?? inv.totalCents, dollar);
  const loadSheet = opts.noLoadSheet ? "Route" : "Load Sheet";
  if (layout === "pipe") {
    out.push("Example Bar & Grill | Example Draft Distributing", "", `Date | Invoice | ${loadSheet} | Route`, "03/14/2027 | 4455667 | 998877 | 12 TS Mon", "");
    out.push("| ID | PRODUCT | QTY | PRICE | DISC | NET | TOTAL |", "|---|---|---|---|---|---|---|");
  } else if (layout === "reflow") {
    out.push("Example Bar & Grill 1 Demo Street Example Draft Distributing 100 Sample Road", "", `Deliveryman Salesman Date Customer Invoice ${loadSheet} Route 03/14/2027 4455667 998877 12 TS Mon`, "");
  } else {
    out.push("Example Bar & Grill", `Date Invoice ${loadSheet} Route`, "03/14/2027 4455667 998877 12 TS Mon", "ID PRODUCT QTY PRICE DISC NET TOTAL");
  }
  let emitted = 0;
  for (let i = 0; i < inv.rows.length; i++) {
    const cells = rowCells(inv, i, opts);
    if (!cells) continue;
    const { lead, qty, amounts } = cells;
    if (layout === "pipe") {
      out.push(`| ${lead} | ${qty ?? ""} | ${amounts[0] ?? ""} | | ${amounts[1] ?? ""} | ${amounts[2] ?? ""} |`);
    } else if (layout === "reflow") {
      const glued = dollar && qty !== null && /^\d$/.test(qty) && emitted % 3 === 2;
      out.push(`## ${lead}`, "", `${glued ? qty : qty === null ? "" : `${qty} `}${amounts.join(" ")}`.trim(), "");
    } else {
      out.push([lead, qty, ...amounts].filter((cell): cell is string => cell !== null && cell !== "").join(" "));
    }
    emitted++;
  }
  if (!opts.omitTotal) {
    out.push(layout === "pipe" ? `| | | Total | ${total} |` : `Total ${total} ${total}`);
  }
  out.push(layout === "pipe" ? "" : `${moneyCell(0, dollar)} Receipt Check Num`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// engine-output files

export interface SynthPage {
  doc: "scan" | "photo";
  dpi: number;
  layout: Layout;
  opts?: RenderOptions;
  /** A page-level error: the markdown is empty, as an engine stub would be. */
  error?: string;
  inferMs?: number;
  /** Replace the generated markdown (for hand-built edge cases). */
  markdown?: string;
}

export interface SynthRun {
  loadMs: number;
  maxRssMb: number;
  cgroupPeakMb: number | null;
  threadsObserved: number;
  /** Where to put threadsObserved: top level (ppocr style) or nested under flags._tess (tesseract style). */
  nested?: boolean;
}

export interface SynthDocker {
  status: string;
  oomKilled: boolean;
  exitCode: number;
  timedOut?: boolean;
  wallSec?: number;
  mem?: string;
  cpus?: number;
}

export interface SynthVariant {
  variant: string;
  pages: readonly SynthPage[];
  run?: SynthRun | null;
  docker?: SynthDocker | null;
  /** Write this page file as invalid JSON. */
  corrupt?: readonly string[];
}

function fakeWords(markdown: string): { text: string; conf: number; box: number[] }[] {
  const words: { text: string; conf: number; box: number[] }[] = [];
  markdown.split("\n").forEach((row, r) => {
    row
      .split(/\s+/)
      .filter((w) => w !== "")
      .forEach((text, c) => words.push({ text, conf: 0.9, box: [c * 10, r * 12, c * 10 + 8, r * 12 + 10] }));
  });
  return words;
}

export function writeSyntheticVariant(outDir: string, inv: SynthInvoice, spec: SynthVariant): void {
  const dir = path.join(outDir, spec.variant);
  fs.mkdirSync(dir, { recursive: true });
  const images: { name: string; ok: boolean; inferMs: number }[] = [];
  for (const page of spec.pages) {
    const name = `${page.doc}-d${page.dpi}`;
    const markdown = page.error ? "" : (page.markdown ?? renderMarkdown(inv, page.layout, page.opts));
    const words = page.error ? [] : fakeWords(markdown);
    const inferMs = page.inferMs ?? 1000;
    images.push({ name, ok: !page.error, inferMs });
    const body = {
      engine: spec.variant.split("-")[0],
      variant: spec.variant,
      doc: page.doc,
      dpi: page.dpi,
      imageWidth: 1000,
      imageHeight: 2000,
      words,
      markdown,
      timings: { inferMs, stagesMs: {} },
      error: page.error ?? null,
    };
    fs.writeFileSync(path.join(dir, `${name}.json`), spec.corrupt?.includes(name) ? "{ not json" : JSON.stringify(body));
  }
  if (spec.run) {
    const base: Record<string, unknown> = {
      variant: spec.variant,
      engine: spec.variant.split("-")[0],
      node: "v22.0.0",
      threads: 2,
      loadMs: spec.run.loadMs,
      maxRssMb: spec.run.maxRssMb,
      cgroupPeakMb: spec.run.cgroupPeakMb,
      images,
      exitReason: "done",
    };
    if (spec.run.nested) base.flags = { _tess: { threadsObserved: spec.run.threadsObserved } };
    else base.threadsObserved = spec.run.threadsObserved;
    fs.writeFileSync(path.join(dir, "_run.json"), JSON.stringify(base));
  }
  if (spec.docker) {
    fs.writeFileSync(
      path.join(dir, "_docker.json"),
      JSON.stringify({
        variant: spec.variant,
        status: spec.docker.status,
        oomKilled: spec.docker.oomKilled,
        exitCode: spec.docker.exitCode,
        timedOut: spec.docker.timedOut ?? false,
        wallSec: spec.docker.wallSec ?? 10,
        mem: spec.docker.mem ?? "1536m",
        cpus: spec.docker.cpus ?? 2,
      }),
    );
  }
}

const OK_RUN: SynthRun = { loadMs: 500, maxRssMb: 400, cgroupPeakMb: 450, threadsObserved: 5 };
const OK_DOCKER: SynthDocker = { status: "ok", oomKilled: false, exitCode: 0 };

/** The photo as an engine sees it: noisier, often without the currency sign. */
const PHOTO_OPTS: RenderOptions = { dropDollar: true, dropQtyRows: [2] };

/**
 * A small fleet of invented variants covering every outcome the scorer reports: a clean pass at all resolutions, a
 * partial pass, complementary failures that merge into a pass, a conflicting pair, an OOM stub, a variant with no
 * page files, and a corrupt page file.
 */
export function syntheticFleet(): SynthVariant[] {
  const scan = (dpi: number, layout: Layout, opts?: RenderOptions, inferMs = 1200): SynthPage => ({ doc: "scan", dpi, layout, opts, inferMs });
  const photo = (dpi: number, layout: Layout, opts?: RenderOptions): SynthPage => ({ doc: "photo", dpi, layout, opts, inferMs: 9000 });
  return [
    {
      variant: "alpha-good",
      pages: [scan(100, "rows"), scan(150, "pipe"), scan(200, "reflow"), photo(100, "rows", PHOTO_OPTS), photo(150, "rows", PHOTO_OPTS)],
      run: OK_RUN,
      docker: OK_DOCKER,
    },
    {
      variant: "alpha-half",
      pages: [scan(100, "rows", { dropQtyRows: [1, 3] }), scan(150, "pipe"), scan(200, "rows", { dropDollar: true })],
      run: { ...OK_RUN, nested: true },
      docker: OK_DOCKER,
    },
    {
      variant: "beta-noqty",
      pages: [scan(150, "rows", { dropQtyRows: [1, 3] }), photo(100, "pipe", PHOTO_OPTS)],
      run: OK_RUN,
      docker: OK_DOCKER,
    },
    {
      variant: "gamma-partial",
      pages: [scan(150, "rows", { dropAmountRows: [{ row: 2, keep: 2 }, { row: 4, keep: 1 }] })],
      run: OK_RUN,
      docker: OK_DOCKER,
    },
    {
      variant: "delta-conflict",
      pages: [scan(150, "rows", { wrongQty: [{ row: 1, qty: 7 }] })],
      run: OK_RUN,
      docker: OK_DOCKER,
    },
    {
      variant: "eps-oom",
      pages: [
        { doc: "scan", dpi: 150, layout: "rows", error: "oom-killed" },
        { doc: "photo", dpi: 150, layout: "rows", error: "oom-killed" },
      ],
      run: null,
      docker: { status: "oom-killed", oomKilled: true, exitCode: 137, mem: "512m" },
    },
    { variant: "zeta-nopages", pages: [], run: null, docker: { status: "no-run-file", oomKilled: false, exitCode: 1 } },
    { variant: "eta-corrupt", pages: [scan(150, "rows"), scan(100, "rows")], corrupt: ["scan-d100"], run: OK_RUN, docker: OK_DOCKER },
  ];
}

/**
 * Library-OCR stand-ins: the three scan renders (different layouts, as the real renders differ in layout) and the
 * photo renders, named like the real saved markdown so the same loader reads both.
 */
export function writeSyntheticLibrary(dir: string, inv: SynthInvoice, scanId: string, photoId: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const write = (dpi: number, id: string, markdown: string) => fs.writeFileSync(path.join(dir, `lib-Auto-dpi${dpi}-${id}.md`), markdown);
  write(100, scanId, renderMarkdown(inv, "pipe"));
  write(150, scanId, renderMarkdown(inv, "reflow"));
  write(200, scanId, renderMarkdown(inv, "rows"));
  write(100, photoId, renderMarkdown(inv, "rows", { dropQtyRows: [2] }));
  write(150, photoId, renderMarkdown(inv, "pipe", { dropQtyRows: [3] }));
  write(200, photoId, renderMarkdown(inv, "reflow"));
}

export function writeSyntheticFleet(outDir: string, inv: SynthInvoice): string[] {
  const fleet = syntheticFleet();
  for (const spec of fleet) writeSyntheticVariant(outDir, inv, spec);
  return fleet.map((spec) => spec.variant);
}
