// Synthetic smoke test for engines/granite.mjs. NO real content: the page is a made-up supplier invoice drawn from a
// hand-written PDF (standard Helvetica) and rendered offline by PDFium (WASM), so it needs no fonts, no network and
// no canvas. Run it in the capped offline container:
//
//   tests/run-granite-synthetic.sh [mem] [cpus]          (absolute path; default 3g, 2 cpus)
//
// What it checks (prints PASS/FAIL lines; exit 0 only if every check passed; plain content is fine to print because
// it is synthetic):
//   1. pure unit tests of the DocTags parser and the tile geometry (no model),
//   2. the engine end to end on the synthetic page, by default in tile512 and tile768 (tiles with overlap); `whole`
//      (the page natively split by the processor: 17 images for this page) is opt-in because it was measured to be
//      OOM-killed at a 3g cap, so give it >= 4g. Each mode runs through the real CLI (a child process, like the runner),
//   3. structure of the outputs: contract-shaped JSON, DocTags captured, boxes inside the page; recall of the known
//      made-up words is MEASURED and printed, and enforced only with --min-recall.
//
//   --parse-only     only the pure unit tests (no model, no PDFium)
//   --render-only    only write the synthetic page PNG and exit
//   --modes a,b,c    subset of tile512,tile768,whole (default tile512,tile768)
//   --min-recall F   fail a mode whose recall of the known words is below F (default 0 = report only)
//   --combo q4|q8    model dtype combo passed to the engine (default q4)
//   --dir PATH       scratch dir for the PNG and engine outputs (default /work/out/_granite-synthetic)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, strFlag } from '../lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const dir = strFlag(flags, 'dir', '/work/out/_granite-synthetic');
const combo = strFlag(flags, 'combo', 'q4');
const modes = strFlag(flags, 'modes', 'tile512,tile768').split(',').filter(Boolean);
const minRecall = Number(strFlag(flags, 'min-recall', '0'));

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  return ok;
};

// ---------------------------------------------------------------------------------------------------------------
// 1. Pure unit tests (no model).
// ---------------------------------------------------------------------------------------------------------------
const granite = await import('../engines/granite.mjs');

function unitTests() {
  const { parseDocTags, tileGrid, ownedRegion, elementsToLines } = granite;

  // A text block and a table, with boxes in the 0-500 grid.
  const sample =
    '<doctag><text><loc_10><loc_20><loc_250><loc_40>Hello synthetic world</text>' +
    '<otsl><loc_10><loc_100><loc_490><loc_200><ched>Item<ched>Qty<nl><fcel>Widget A<fcel>2<nl><fcel>Gadget<ecel><nl></otsl>' +
    '<section_header_level_1><loc_5><loc_300><loc_100><loc_320>Totals</section_header_level_1></doctag><|end_of_text|>';
  const els = parseDocTags(sample);
  check(els.length === 3, 'parse: three elements', `got ${els.length}`);
  check(els[0]?.kind === 'text' && els[0].text === 'Hello synthetic world', 'parse: text element content');
  check(JSON.stringify(els[0]?.box) === '[10,20,250,40]', 'parse: text element box from loc tokens');
  check(els[1]?.kind === 'table' && els[1].rows.length === 3, 'parse: table has 3 rows', `got ${els[1]?.rows?.length}`);
  check(JSON.stringify(els[1]?.rows?.[1]) === '["Widget A","2"]', 'parse: table row cells');
  check(JSON.stringify(els[1]?.rows?.[2]) === '["Gadget"]', 'parse: empty cell dropped from the row text');
  check(els[2]?.type === 'section_header_level_1' && els[2].text === 'Totals', 'parse: section header');

  // Truncated output (hit max tokens mid-element) must still parse what is there.
  const cut = parseDocTags('<doctag><text><loc_1><loc_2><loc_3><loc_4>First line</text><text><loc_1><loc_50><loc_3><loc_60>Second li');
  check(cut.length === 2 && cut[1].text === 'Second li', 'parse: truncated output keeps the partial element');

  // No loc tokens: boxes are null, text still comes out.
  const noBox = parseDocTags('<doctag><text>only text</text></doctag>');
  check(noBox.length === 1 && noBox[0].box === null && noBox[0].text === 'only text', 'parse: no loc tokens gives box null');

  // Tile grid: covers the page, last tiles are aligned to the page edge, stride = tile - overlap.
  const grid = tileGrid(1012, 2083, 512, 512, 48);
  check(grid.cols === 3 && grid.rows === 5, 'grid: 1012x2083 at 512/48 is 3x5', `${grid.cols}x${grid.rows}`);
  check(grid.tiles.length === 15, 'grid: 15 tiles', `${grid.tiles.length}`);
  const covered = grid.tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= 1012 + 512 && t.y + t.h <= 2083 + 512);
  check(covered, 'grid: tiles stay within page plus padding');
  const last = grid.tiles.at(-1);
  check(last.x + last.w >= 1012 && last.y + last.h >= 2083, 'grid: last tile reaches the page corner');
  const single = tileGrid(300, 200, 512, 512, 48);
  check(single.tiles.length === 1 && single.tiles[0].x === 0 && single.tiles[0].y === 0, 'grid: small page is one tile');

  // Ownership partition: every page pixel column belongs to exactly one tile column.
  let exactlyOne = true;
  for (let x = 0; x < 1012; x += 7) {
    const owners = [];
    for (let c = 0; c < grid.cols; c++) {
      const r = ownedRegion(grid, grid.tiles[c]);
      if (x >= r.x0 && x < r.x1) owners.push(c);
    }
    if (owners.length !== 1) exactlyOne = false;
  }
  check(exactlyOne, 'ownership: each x is owned by exactly one tile column');

  // Lines from two tiles on the same visual row are merged left to right with words kept once.
  const tile = { x: 0, y: 0, w: 512, h: 512 };
  const a = elementsToLines(parseDocTags('<text><loc_0><loc_50><loc_500><loc_60>alpha beta gamma</text>'), tile, 0);
  check(a.length === 1 && a[0].words.length === 3, 'lines: one line with three words');
  check(a[0].words.every((w) => w.box[2] >= w.box[0] && w.box[3] > w.box[1]), 'lines: word boxes are well formed');
  check(Math.abs(a[0].words[0].box[0] - 0) < 1 && Math.abs(a[0].words[2].box[2] - 512) < 2, 'lines: word boxes span the element box');

  // Stitching: fragments of one visual row from three tile columns merge left to right, an overlap word is kept once.
  const { findRepeat, stitchLines } = granite;
  const tileText = (c, tags) => ({ tile: grid.tiles[c], lines: elementsToLines(parseDocTags(tags), grid.tiles[c], c) });
  const stitched = stitchLines(
    [
      tileText(0, '<text><loc_0><loc_50><loc_100><loc_60>left words</text><text><loc_0><loc_200><loc_100><loc_210>second row</text>'),
      tileText(0, '<text><loc_390><loc_50><loc_490><loc_60>dup</text>'),
      tileText(1, '<text><loc_146><loc_50><loc_244><loc_60>dup</text>'),
      tileText(2, '<text><loc_200><loc_50><loc_400><loc_60>right words</text>'),
    ],
    grid,
  );
  check(
    JSON.stringify(stitched.lines) === '["left words dup right words","second row"]',
    'stitch: row fragments merge in order, overlap word kept once',
    JSON.stringify(stitched.lines),
  );
  check(stitched.words.length === 7,'stitch: word list matches the merged text', `${stitched.words.length}`);

  // Repetition guard: a 3-token loop repeated 25 times after a 10-token prefix is cut back to one period.
  const loop = [...Array(10).keys()];
  for (let i = 0; i < 25; i++) loop.push(101, 102, 103);
  const rep = findRepeat(loop);
  check(rep !== null && rep.period === 3 && rep.keepLen === 13, 'repeat: period-3 loop found and cut to one period', JSON.stringify(rep));
  check(findRepeat([...Array(120).keys()]) === null, 'repeat: strictly increasing ids never fire');
  check(findRepeat([...Array(20).keys(), ...Array(10).fill(7)]) === null, 'repeat: ten identical tokens are below the period-1 threshold');
  check(findRepeat([...Array(20).keys(), ...Array(70).fill(7)])?.period === 1, 'repeat: seventy identical tokens fire as period 1');

  // Text-level repetition: same element over and over with different loc numbers each time.
  const { findTextRepeat } = granite;
  let looped = '<doctag><section_header_level_1><loc_1><loc_2><loc_3><loc_4>Title</section_header_level_1>\n';
  for (let i = 0; i < 12; i++) looped += `<text><loc_0><loc_${50 + i * 17}><loc_19><loc_${59 + i * 17}>same words here</text>\n`;
  const tl = findTextRepeat(looped);
  check(tl !== null && tl.period === 9, 'text repeat: element loop with changing loc numbers found', JSON.stringify(tl));
  check(tl !== null && parseDocTags(looped.slice(0, tl.cutAt)).length === 2, 'text repeat: cut keeps the title and ONE loop element');
  check(findTextRepeat(looped.split('\n').slice(0, 4).join('\n')) === null, 'text repeat: three repeats do not fire');
}

unitTests();
if (flags['parse-only']) {
  console.log(failures === 0 ? 'ALL PASS (parse only)' : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. The synthetic page: a hand-written one page PDF, rendered by PDFium.
// ---------------------------------------------------------------------------------------------------------------
const PAGE_W = 520; // points; at 150 dpi this is 1083 px wide, so a 512 tile sees roughly a third of the width
const PAGE_H = 420;

// (x, y from the top, size, bold, text). All values are made up.
const TEXT = [
  [30, 40, 16, true, 'NORTHWIND TEST SUPPLY'],
  [30, 60, 10, false, '100 Example Street, Sampletown'],
  [330, 40, 12, true, 'INVOICE 000417'],
  [330, 58, 10, false, 'Date: 2026-01-15'],
  [30, 110, 10, true, 'Description'],
  [250, 110, 10, true, 'Qty'],
  [320, 110, 10, true, 'Unit'],
  [420, 110, 10, true, 'Amount'],
  [30, 140, 10, false, 'Widget Alpha 12 pack'],
  [250, 140, 10, false, '2'],
  [320, 140, 10, false, '14.50'],
  [420, 140, 10, false, '29.00'],
  [30, 170, 10, false, 'Gadget Beta 6 pack'],
  [250, 170, 10, false, '10'],
  [320, 170, 10, false, '3.25'],
  [420, 170, 10, false, '32.50'],
  [30, 200, 10, false, 'Sprocket Gamma single'],
  [250, 200, 10, false, '1'],
  [320, 200, 10, false, '19.99'],
  [420, 200, 10, false, '19.99'],
  [320, 250, 11, true, 'Total'],
  [420, 250, 11, true, '81.49'],
];
// Words that must come back (known text). Compared case-insensitively on whitespace-split markdown tokens.
const EXPECT = ['Widget', 'Gadget', 'Sprocket', '14.50', '29.00', '32.50', '19.99', '81.49', 'INVOICE', '000417'];

function buildSyntheticPdf() {
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const ops = [];
  ops.push('0.8 w');
  // table frame and rules (y flipped: PDF origin is bottom-left)
  const Y = (y) => PAGE_H - y;
  const rule = (x0, y0, x1, y1) => ops.push(`${x0} ${Y(y0)} m ${x1} ${Y(y1)} l S`);
  rule(24, 98, 500, 98);
  rule(24, 126, 500, 126);
  rule(24, 228, 500, 228);
  rule(24, 98, 24, 228);
  rule(500, 98, 500, 228);
  for (const x of [240, 310, 405]) rule(x, 98, x, 228);
  for (const [x, y, size, bold, text] of TEXT) {
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${Y(y)} Td (${esc(text)}) Tj ET`);
  }
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

mkdirSync(dir, { recursive: true });
const { PDFiumLibrary } = await import('@hyzyla/pdfium');
const { encodePng, toRgb } = await import('../lib/png.mjs');
const lib = await PDFiumLibrary.init();
const pdf = await lib.loadDocument(buildSyntheticPdf());
const page = pdf.getPage(0);
const DPI = 150;
const rendered = await page.render({ scale: DPI / 72, render: 'bitmap', colorSpace: 'RGBA', transparent: false });
const imgPath = join(dir, `syn-d${DPI}.png`);
writeFileSync(imgPath, encodePng(toRgb({ width: rendered.width, height: rendered.height, channels: 4, data: rendered.data })));
page.close();
pdf.destroy();
lib.destroy();
console.log(`rendered synthetic page ${rendered.width}x${rendered.height} -> ${imgPath}`);
check(rendered.width > 800 && rendered.height > 600, 'synthetic page rendered');
if (flags['render-only']) process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------------------------------------------
// 3. The engine through its real CLI.
// ---------------------------------------------------------------------------------------------------------------
const MODES = {
  whole: ['--whole-page'],
  tile512: ['--tile', '512x512', '--overlap', '48'],
  tile768: ['--tile', '768x768', '--overlap', '48'],
};

for (const mode of modes) {
  if (!MODES[mode]) {
    check(false, `unknown mode ${mode}`);
    continue;
  }
  const variant = `granite-synth-${mode}`;
  const t0 = Date.now();
  const res = spawnSync(
    process.execPath,
    ['/bench/engines/granite.mjs', '--variant', variant, '--img', imgPath, '--out', dir, '--threads', '2', '--combo', combo,
      '--max-new-tokens', '1024', ...MODES[mode]],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  check(res.status === 0, `${mode}: engine exit code 0`, `status=${res.status} ${secs}s`);
  if (res.status !== 0) {
    console.log((res.stderr ?? '').split('\n').slice(-8).join('\n'));
    continue;
  }
  const resultPath = join(dir, variant, `syn-d${DPI}.json`);
  const sidecarPath = join(dir, variant, `_syn-d${DPI}.granite.json`);
  check(existsSync(resultPath), `${mode}: result JSON written`);
  check(existsSync(sidecarPath), `${mode}: sidecar (raw tiles, stats) written`);
  if (!existsSync(resultPath) || !existsSync(sidecarPath)) continue;
  const r = JSON.parse(readFileSync(resultPath, 'utf8'));
  const side = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  check(r.error === null, `${mode}: no error`, String(r.error));
  const lines = r.markdown === '' ? [] : r.markdown.split('\n');
  // Plumbing only: a non-empty page came back. How many lines the model manages to read is quality, reported below.
  check(lines.length >= 1, `${mode}: markdown has >= 1 line`, `${lines.length} lines`);
  check(side.tiles.length >= 1 && side.tiles.every((t) => typeof t.raw === 'string'), `${mode}: raw DocTags kept per tile`);
  check(side.tiles.some((t) => /<loc_\d+>/.test(t.raw)), `${mode}: model emitted loc tokens`);
  const tokens = new Set(r.markdown.toLowerCase().split(/\s+/).filter(Boolean));
  const found = EXPECT.filter((w) => tokens.has(w.toLowerCase()));
  const missing = EXPECT.filter((w) => !tokens.has(w.toLowerCase()));
  // Recall is a property of the MODEL, not of the plumbing under test: it is reported always and enforced only when
  // --min-recall is given (a fraction, e.g. 0.6). Measured 2026-10: the quantised model reads the large title but
  // not the 10-11 pt table text, so an enforced default would make this smoke test fail for a reason that is not a bug.
  const recall = found.length / EXPECT.length;
  console.log(`  ${mode}: MEASURED recall of known words ${found.length}/${EXPECT.length}; missing: ${missing.join(' ') || '-'}`);
  if (minRecall > 0) check(recall >= minRecall, `${mode}: recall >= ${minRecall}`, `${recall.toFixed(2)}`);
  const inside = r.words.every((w) => w.box[0] >= -1 && w.box[1] >= -1 && w.box[2] <= r.imageWidth + 1 && w.box[3] <= r.imageHeight + 1);
  check(inside, `${mode}: every word box lies inside the page`, `${r.words.length} words`);
  console.log(
    `  ${mode}: tiles=${side.tiles.length} generated=${side.totals.tokens} tok genSec=${side.totals.generateSec} ` +
      `tok/s=${side.totals.tokensPerSec} repeatGuard=${side.totals.repeatGuardFired} emptyTiles=${side.totals.emptyTiles}`,
  );
  console.log(`  ${mode}: markdown:\n${r.markdown.split('\n').map((l) => `    | ${l}`).join('\n')}`);
}

console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
