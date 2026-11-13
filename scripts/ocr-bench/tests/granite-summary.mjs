// Structure-only summary of granite bench runs. Prints counts, sizes, timings and a MASKED sample of output lines
// (letters -> a, digits -> 9), so the output is safe to paste into a report even for real documents.
//
//   node tests/granite-summary.mjs <out-dir> <variant>[,<variant>...] [--sample 3]
//
// Reads, per variant: _run.json, _docker.json, <image>.json (markdown), _<image>.granite.json (sidecar). Host node.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { numFlag, parseArgs } from '../lib/cli.mjs';
import { maskText } from '../lib/mask.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
if (rest.length < 2) {
  console.error('usage: granite-summary.mjs <out-dir> <variant>[,<variant>...] [--sample N]');
  process.exit(2);
}
const [outDir, variantsArg] = rest;
const sampleN = numFlag(flags, 'sample', 3);

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const fmt = (v) => (v === null || v === undefined ? 'n/a' : String(v));

/** Evenly spaced non-empty lines, preferring lines that contain a digit (the interesting ones for invoices). */
function sampleLines(markdown, n) {
  const lines = String(markdown ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const withDigit = lines.filter((l) => /\d/.test(l));
  const pool = withDigit.length >= n ? withDigit : lines;
  if (pool.length <= n) return pool;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.floor(((i + 0.5) * pool.length) / n)]);
  return out;
}

for (const variant of variantsArg.split(',').filter(Boolean)) {
  const dir = join(outDir, variant);
  console.log(`=== ${variant} ===`);
  if (!existsSync(dir)) {
    console.log('  (no output directory)');
    continue;
  }
  const run = readJson(join(dir, '_run.json'));
  const docker = readJson(join(dir, '_docker.json'));
  const gr = readJson(join(dir, '_granite-run.json'));
  console.log(
    `  status=${fmt(docker?.status ?? run?.exitReason)} oomKilled=${fmt(docker?.oomKilled)} exit=${fmt(docker?.exitCode)} wallSec=${fmt(docker?.wallSec)} mem=${fmt(docker?.mem)} cpus=${fmt(docker?.cpus)} threads=${fmt(run?.threads)}`,
  );
  console.log(
    `  loadMs=${fmt(run?.loadMs)} maxRssMb=${fmt(run?.maxRssMb)} cgroupPeakMb=${fmt(run?.cgroupPeakMb)} cgroupLimitMb=${fmt(run?.cgroupLimitMb)} rssAfterLoadMb=${fmt(run?.rssAfterLoadMb)}`,
  );
  if (gr) {
    console.log(
      `  combo=${gr.combo} mode=${gr.mode} tile=${gr.mode === 'tiles' ? `${gr.tile.w}x${gr.tile.h}+${gr.overlap}` : 'n/a'} maxNew=${gr.maxNewTokens} intra=${gr.threads?.intra} inter=${gr.threads?.inter} tasksAfterLoad=${fmt(gr.threads?.tasksAfterLoad)} tasksMax=${fmt(gr.threads?.tasksMax)}`,
    );
  }
  const files = readdirSync(dir).filter((f) => /^_.+\.granite\.json$/.test(f)).sort();
  if (files.length === 0) console.log('  (no sidecars: the process may have been killed before the first page finished)');
  for (const f of files) {
    const side = readJson(join(dir, f));
    if (!side) continue;
    const t = side.totals ?? {};
    const res = readJson(join(dir, `${side.image}.json`));
    console.log(`  -- ${side.image} (${side.page?.width}x${side.page?.height})`);
    console.log(
      `     tiles run/total=${t.tilesRun}/${t.tilesTotal} notReached=${t.tilesNotReached} blank=${t.blankTiles} empty=${t.emptyTiles} failed=${t.failedTiles} repeatGuardFired=${t.repeatGuardFired} hitMaxTokens=${t.hitMaxTokens} budgetExceeded=${t.budgetExceeded}`,
    );
    console.log(
      `     tokens=${t.tokens} tokensPerTile=${t.tokensPerTile} generateSecPerTile=${t.generateSecPerTile} prefillSecPerTile=${t.prefillSecPerTile} tokPerSec=${t.tokensPerSec} pageSec=${t.pageSec} preprocessSec=${t.preprocessSec} tilesPerSec=${t.tilesPerSec}`,
    );
    console.log(
      `     numericTokens=${t.numericTokens} moneyLikeTokens=${t.moneyLikeTokens} locTokensSeen=${t.locTokensSeen} wordsReturned=${t.wordsReturned} markdownLines=${res ? String(res.markdown ?? '').split('\n').filter(Boolean).length : 'n/a'} error=${fmt(res?.error)} maxRssMbAtPageEnd=${t.maxRssMbAtPageEnd}`,
    );
    const md = res?.markdown || side.partialMarkdown || '';
    for (const l of sampleLines(md, sampleN)) console.log(`     sample: ${maskText(l).slice(0, 120)}`);
  }
}
