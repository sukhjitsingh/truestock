// Host-side post-processing for run/run-capped.sh (plain node on the Mac, no node_modules needed).
// Takes the docker-level facts of one capped run and:
//   1. writes <out>/<variant>/_docker.json  { variant, engine, status, oomKilled, exitCode, timedOut, wallSec, mem, cpus, ... }
//   2. writes a stub result JSON (error: "oom-killed" | "timeout (wall-clock cap)" | "crash: exit N" | ...) for every
//      requested image that has no result file yet, and a stub _run.json if the engine never wrote one
//   3. prints ONE summary line (structure only)
// status: ok | image-errors | timeout | oom-killed | init-failed | uncaught | crash | docker-error | no-run-file
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { numFlag, parseArgs, parseImageName, strFlag } from '../lib/cli.mjs';
import { imageResultPath, stubImageResult, writeImageResult, writeRunFile } from '../lib/output.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const outDir = strFlag(flags, 'out-dir');
const variant = strFlag(flags, 'variant');
const engine = strFlag(flags, 'engine');
const names = (strFlag(flags, 'imgs', '') ?? '').split(',').filter(Boolean);
const oomKilled = strFlag(flags, 'oom') === 'true';
const exitCode = numFlag(flags, 'exit-code', null);
const timedOut = strFlag(flags, 'timed-out') === '1';
const dockerError = strFlag(flags, 'docker-error', '') || null;
const started = Date.parse(strFlag(flags, 'started', ''));
const finished = Date.parse(strFlag(flags, 'finished', ''));
const polledSec = numFlag(flags, 'polled-sec', null);

const runPath = join(outDir, variant, '_run.json');
let run = null;
try {
  run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) : null;
} catch {
  run = null; // half-written by a kill: treat as absent
}

let status;
if (dockerError) status = 'docker-error';
else if (timedOut) status = 'timeout';
else if (oomKilled) status = 'oom-killed';
else if (exitCode === 0) status = run ? run.exitReason : 'no-run-file';
else if (run && ['timeout', 'init-failed', 'uncaught'].includes(run.exitReason)) status = run.exitReason;
else status = 'crash';

const stubError =
  {
    'oom-killed': 'oom-killed',
    timeout: 'timeout (wall-clock cap)',
    'docker-error': 'docker-error',
  }[status] ?? `crash: exit ${exitCode}`;

const stubs = [];
for (const name of names) {
  if (existsSync(imageResultPath(outDir, variant, name))) continue;
  const info = parseImageName(`${name}.png`);
  writeImageResult(
    outDir,
    variant,
    name,
    stubImageResult({ engine, variant, doc: info?.doc ?? 'unknown', dpi: info?.dpi ?? 0, error: stubError }),
  );
  stubs.push(name);
}

if (!run) {
  writeRunFile(outDir, variant, {
    variant,
    engine,
    node: null,
    threads: numFlag(flags, 'threads', null),
    loadMs: null,
    maxRssMb: null,
    cgroupPeakMb: null,
    images: [],
    exitReason: status,
    stub: true,
  });
}

const wallSec =
  Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? Math.round((finished - started) / 100) / 10
    : polledSec;

const facts = {
  variant,
  engine,
  status,
  oomKilled,
  exitCode,
  timedOut,
  wallSec,
  mem: strFlag(flags, 'mem'),
  cpus: numFlag(flags, 'cpus', null),
  threads: numFlag(flags, 'threads', null),
  timeoutSec: numFlag(flags, 'timeout-sec', null),
  imgs: names,
  stubsWritten: stubs,
  dockerError,
  startedAt: strFlag(flags, 'started', null),
  finishedAt: strFlag(flags, 'finished', null),
};
writeFileSync(join(outDir, variant, '_docker.json'), `${JSON.stringify(facts, null, 2)}\n`);

const r = run ?? {};
console.log(
  [
    `variant=${variant}`,
    `status=${status}`,
    `exit=${exitCode}`,
    `oomKilled=${oomKilled}`,
    `timedOut=${timedOut}`,
    `wallSec=${wallSec}`,
    `mem=${facts.mem}`,
    `cpus=${facts.cpus}`,
    `loadMs=${r.loadMs ?? 'n/a'}`,
    `maxRssMb=${r.maxRssMb ?? 'n/a'}`,
    `cgroupPeakMb=${r.cgroupPeakMb ?? 'n/a'}`,
    `stubs=${stubs.length}`,
  ].join(' '),
);
