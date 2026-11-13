// Plumbing test for engines/tesseract.mjs on a SYNTHETIC page (no real document content anywhere).
//
// It draws a small invoice-shaped page with a 5x7 bitmap font, runs the engine as a child process in three
// configurations and checks the contract and the engine's own bookkeeping. It does not judge OCR quality (a blocky
// bitmap font is not a scan); it proves that the offline wiring, worker pool, recycle, repeat and second pass run.
//
// Run it inside the offline container (needs the harness node_modules and /work/models):
//   node /bench/tests/tesseract-synthetic.mjs [--work /tmp/ocrb-synth] [--tess-data fast|best_int]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, strFlag } from '../lib/cli.mjs';
import { encodePng } from '../lib/png.mjs';
import { resizeBilinear } from '../lib/resize.mjs';

const GLYPHS = {
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
};

const SCALE = 6; // each font pixel -> 6x6 page pixels, smoothed afterwards
const ROWS = [
  'ITEM   QTY   PRICE   TOTAL',
  'ALPHA   12   4.50   54.00',
  'BRAVO   6   10.25   61.50',
  'CREDIT   -3.75',
  'SUBTOTAL   111.75',
  'TOTAL   $111.75',
];

function drawPage() {
  const margin = 40;
  const cell = 6 * SCALE;
  const lineH = 11 * SCALE;
  const maxChars = Math.max(...ROWS.map((r) => r.length));
  const w = margin * 2 + maxChars * cell;
  const h = margin * 2 + ROWS.length * lineH;
  const big = new Uint8Array(w * h).fill(255);
  ROWS.forEach((row, ri) => {
    [...row].forEach((ch, ci) => {
      const g = GLYPHS[ch];
      if (!g) return;
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (g[gy][gx] !== '#') continue;
          for (let dy = 0; dy < SCALE; dy++) {
            for (let dx = 0; dx < SCALE; dx++) {
              big[(margin + ri * lineH + gy * SCALE + dy) * w + margin + ci * cell + gx * SCALE + dx] = 0;
            }
          }
        }
      }
    });
  });
  // smooth the blocky edges: down to 2/3 and back up (bilinear), then to 8-bit gray PNG
  const small = resizeBilinear({ width: w, height: h, channels: 1, data: big }, Math.round(w * 0.66), Math.round(h * 0.66));
  const back = resizeBilinear(small, w, h);
  return encodePng(back);
}

const { flags } = parseArgs(process.argv.slice(2));
const work = strFlag(flags, 'work', '/tmp/ocrb-synth');
const tessData = strFlag(flags, 'tess-data', 'best_int');
const engine = fileURLToPath(new URL('../engines/tesseract.mjs', import.meta.url));
const imgDir = join(work, 'img');
mkdirSync(imgDir, { recursive: true });
const imgPath = join(imgDir, 'synth-d150.png');
writeFileSync(imgPath, drawPage());

let failures = 0;
const check = (ok, what) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};

const wantTokens = ROWS.flatMap((r) => r.split(/\s+/)).filter(Boolean);
const NUMERIC = /^[\d.,$()-]+$/;

function runConfig(label, extra) {
  const variant = `synth-${label}`;
  const out = join(work, 'out');
  const r = spawnSync(
    process.execPath,
    [engine, '--variant', variant, '--img', imgPath, '--out', out, '--threads', '2', '--tess-data', tessData, ...extra],
    { encoding: 'utf8', timeout: 240000 },
  );
  check(r.status === 0, `[${label}] engine exit code 0 (got ${r.status})`);
  const dir = join(out, variant);
  const run = JSON.parse(readFileSync(join(dir, '_run.json'), 'utf8'));
  return { variant, dir, run, tess: run.flags?._tess, stderr: r.stderr };
}

function checkPage(label, dir, name) {
  const p = join(dir, `${name}.json`);
  check(existsSync(p), `[${label}] result file ${name}.json exists`);
  const res = JSON.parse(readFileSync(p, 'utf8'));
  check(res.error === null, `[${label}] ${name} error is null`);
  check(res.words.length >= 10, `[${label}] ${name} has >= 10 words (got ${res.words.length})`);
  check(
    res.words.every((w) => w.box[0] >= 0 && w.box[2] <= res.imageWidth + 1 && w.box[3] <= res.imageHeight + 1),
    `[${label}] ${name} boxes lie inside the image`,
  );
  const rows = res.markdown === '' ? 0 : res.markdown.split('\n').length;
  check(rows >= ROWS.length - 1 && rows <= ROWS.length + 2, `[${label}] ${name} markdown has about ${ROWS.length} rows (got ${rows})`);
  const found = new Set(res.words.map((w) => w.text));
  const hit = wantTokens.filter((t) => found.has(t)).length;
  const numWant = wantTokens.filter((t) => NUMERIC.test(t));
  const numHit = numWant.filter((t) => found.has(t)).length;
  console.log(`INFO [${label}] ${name} exact tokens ${hit}/${wantTokens.length}, numeric tokens ${numHit}/${numWant.length}`);
  // A blocky 5x7 bitmap font is not a scan: recovery is informational, the assertion only proves text came through.
  check(hit >= 3, `[${label}] ${name} recovered at least 3 tokens exactly (got ${hit})`);
  check(['load', 'recognize', 'secondPass'].every((k) => k in res.timings.stagesMs), `[${label}] ${name} has load/recognize/secondPass stages`);
  check(existsSync(join(dir, `_tess-${name}.json`)), `[${label}] ${name} side file _tess-${name}.json exists`);
  return res;
}

// Thread accounting: /proc/self/task also counts Node/V8/libuv helper threads that start lazily once a worker_thread
// exists, so the absolute "added" number is a fixed overhead plus one thread per tesseract worker. The test therefore
// asserts the DELTAS between configurations (+1 per extra worker), not an absolute count.
let baseAdded = null;

// A: plain PSM 6, one worker
{
  const a = runConfig('a-psm6', ['--psm', '6']);
  checkPage('a', a.dir, 'synth-d150');
  baseAdded = a.tess?.workerThreadsAdded ?? null;
  check(typeof baseAdded === 'number' && baseAdded >= 1, `[a] --workers 1 adds >= 1 thread (got ${baseAdded})`);
  console.log(`INFO [a] threads: baseline ${a.tess?.baselineThreads}, after load ${a.tess?.threadsAfterLoad}, peak ${a.tess?.threadsObserved}, added ${baseAdded}`);
  check(a.tess?.passes?.length === 1, `[a] one pass recorded (got ${a.tess?.passes?.length})`);
}

// B: second pass with the numeric whitelist worker
{
  const b = runConfig('b-wl', ['--psm', '6', '--wl']);
  checkPage('b', b.dir, 'synth-d150');
  const sp = b.tess?.secondPass;
  check(sp && sp.candidates > 0 && sp.reread > 0, `[b] second pass re-read some words (candidates ${sp?.candidates}, reread ${sp?.reread})`);
  check(
    b.tess?.workerThreadsAdded === baseAdded + 1,
    `[b] recognition worker + whitelist worker = one more thread than config a (got ${b.tess?.workerThreadsAdded}, a had ${baseAdded})`,
  );
  console.log(`INFO [b] second pass ${JSON.stringify(sp)}`);
}

// C: pool of 2, recycle every page, image list twice
{
  const c = runConfig('c-pool', ['--psm', '4', '--workers', '2', '--recycle', '1', '--repeat', '2']);
  checkPage('c', c.dir, 'synth-d150');
  checkPage('c', c.dir, 'synthp2-d150');
  check(
    c.tess?.workerThreadsAdded === baseAdded + 1,
    `[c] --workers 2 adds one more thread than --workers 1 (got ${c.tess?.workerThreadsAdded}, a had ${baseAdded})`,
  );
  check(c.tess?.passes?.length === 2, `[c] two passes recorded (got ${c.tess?.passes?.length})`);
  // page 1 -> worker 1, page 2 -> worker 2: neither has recognised a page yet when it is picked, so no recycle
  check(c.tess?.recycles === 0, `[c] round-robin over 2 workers: no recycle yet (recycles=${c.tess?.recycles})`);
}

// D: a recycle that actually triggers (1 worker, 2 pages)
{
  const d = runConfig('d-recycle', ['--psm', '6', '--workers', '1', '--recycle', '1', '--repeat', '2']);
  checkPage('d', d.dir, 'synthp2-d150');
  check(d.tess?.recycles === 1, `[d] the second page recreated the worker (recycles=${d.tess?.recycles})`);
  check(
    d.tess?.workerThreadsAdded === baseAdded,
    `[d] a recycle does not leave extra threads behind (got ${d.tess?.workerThreadsAdded}, a had ${baseAdded})`,
  );
}

console.log(failures === 0 ? 'SYNTHETIC OK' : `SYNTHETIC FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
