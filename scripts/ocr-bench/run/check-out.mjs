// Contract checker for a result dir. Host-side plain node, no node_modules needed.
//
//   node check-out.mjs <BENCH/out> <variant> [--expect scan-d100,scan-d150,...]
//
// Verifies: _run.json and _docker.json exist and have their fields, every expected image has a result file that
// satisfies the per-image contract, and prints ONE line per image with structure only (word count, markdown line
// count, sizes, timings, error class). It never prints word text or markdown content.
// Exit status 0 if every check passed, 1 otherwise.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, strFlag } from '../lib/cli.mjs';
import { validateImageResult } from '../lib/output.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
const [outDir, variant] = rest;
if (!outDir || !variant) {
  console.error('usage: node check-out.mjs <out-dir> <variant> [--expect a,b,c]');
  process.exit(2);
}
const dir = join(outDir, variant);
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
let failures = 0;
const check = (ok, what) => {
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}`);
  }
  return ok;
};

const run = load(join(dir, '_run.json'));
const dock = load(join(dir, '_docker.json'));
check(run !== null, '_run.json exists');
check(dock !== null, '_docker.json exists');
if (run) {
  for (const k of ['variant', 'node', 'threads', 'loadMs', 'maxRssMb', 'cgroupPeakMb', 'images', 'exitReason']) {
    check(k in run, `_run.json has ${k}`);
  }
  console.log(
    `run: exitReason=${run.exitReason} node=${run.node} threads=${run.threads} loadMs=${run.loadMs} ` +
      `maxRssMb=${run.maxRssMb} cgroupPeakMb=${run.cgroupPeakMb} cgroupLimitMb=${run.cgroupLimitMb ?? 'n/a'} stub=${run.stub === true}`,
  );
}
if (dock) {
  for (const k of ['oomKilled', 'exitCode', 'wallSec', 'mem', 'cpus', 'status']) check(k in dock, `_docker.json has ${k}`);
  console.log(
    `docker: status=${dock.status} oomKilled=${dock.oomKilled} exitCode=${dock.exitCode} timedOut=${dock.timedOut} ` +
      `wallSec=${dock.wallSec} mem=${dock.mem} cpus=${dock.cpus} stubsWritten=${dock.stubsWritten?.length ?? 0}`,
  );
}

const expected = (strFlag(flags, 'expect', '') ?? '').split(',').filter(Boolean);
const present = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''));
for (const name of expected) check(present.includes(name), `result file for ${name}`);
for (const name of present) {
  let r;
  try {
    r = validateImageResult(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
  } catch (e) {
    check(false, `${name}: ${e.message}`);
    continue;
  }
  const mdLines = r.markdown === '' ? 0 : r.markdown.split('\n').length;
  const boxesInside = r.words.every(
    (w) => w.box[0] >= 0 && w.box[1] >= 0 && w.box[2] <= r.imageWidth + 1 && w.box[3] <= r.imageHeight + 1,
  );
  console.log(
    `${name}: ok=${r.error === null} words=${r.words.length} mdLines=${mdLines} size=${r.imageWidth}x${r.imageHeight} ` +
      `boxesInside=${boxesInside} inferMs=${r.timings.inferMs} stages=${Object.keys(r.timings.stagesMs).join('+') || '-'} ` +
      `error=${r.error === null ? 'null' : JSON.stringify(r.error.slice(0, 60))}`,
  );
}
console.log(failures === 0 ? 'CONTRACT OK' : `CONTRACT FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
