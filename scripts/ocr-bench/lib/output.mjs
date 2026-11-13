// Result-file contract (see the bench spec) and its writer. No third-party imports, so host-side scripts
// (run/finish.mjs) can use it too.
//
// Per image  <out>/<variant>/<doc>-d<dpi>.json:
//   { engine, variant, doc, dpi, imageWidth, imageHeight,
//     words: [{ text, conf: 0..1 | null, box: [x0,y0,x1,y1] }],      // [] if the engine has no boxes
//     markdown: "reading order text, ONE visual row per line, cells separated by ' '",
//     timings: { inferMs, stagesMs: { ... } },
//     error: null | "message (masked: letters->a digits->9 if it could contain content)" }
// Per process <out>/<variant>/_run.json:
//   { variant, node, threads, loadMs, maxRssMb, cgroupPeakMb | null, images: [...], exitReason }
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const round1 = (n) => Math.round(n * 10) / 10;

function normalizeWord(w) {
  const text = String(w.text ?? '');
  const box = Array.isArray(w.box) ? w.box.map((v) => round1(Number(v))) : [];
  let conf = null;
  if (typeof w.conf === 'number' && Number.isFinite(w.conf)) conf = Math.min(1, Math.max(0, w.conf));
  return { text, conf: conf === null ? null : Math.round(conf * 10000) / 10000, box };
}

/** Build a contract-shaped result; fills defaults so engines only pass what they know. */
export function makeImageResult({
  engine,
  variant,
  doc,
  dpi,
  imageWidth = 0,
  imageHeight = 0,
  words = [],
  markdown = '',
  inferMs = 0,
  stagesMs = {},
  error = null,
}) {
  return {
    engine,
    variant,
    doc,
    dpi,
    imageWidth,
    imageHeight,
    words: words.map(normalizeWord),
    markdown,
    timings: { inferMs: round1(inferMs), stagesMs },
    error: error === null ? null : String(error),
  };
}

/** Result with no words and an error, used for OOM / timeout / crash / bad page. */
export function stubImageResult({ engine, variant, doc, dpi, error, imageWidth = 0, imageHeight = 0 }) {
  return makeImageResult({ engine, variant, doc, dpi, imageWidth, imageHeight, error });
}

/** Throws a descriptive Error if `r` does not satisfy the contract. Returns r. */
export function validateImageResult(r) {
  const bad = (why) => {
    throw new Error(`contract violation: ${why}`);
  };
  for (const k of ['engine', 'variant', 'doc', 'markdown']) if (typeof r[k] !== 'string') bad(`${k} must be a string`);
  for (const k of ['dpi', 'imageWidth', 'imageHeight']) if (!Number.isFinite(r[k])) bad(`${k} must be a number`);
  if (!Array.isArray(r.words)) bad('words must be an array');
  for (const w of r.words) {
    if (typeof w.text !== 'string') bad('word.text must be a string');
    if (!(w.conf === null || (typeof w.conf === 'number' && w.conf >= 0 && w.conf <= 1))) bad('word.conf must be 0..1 or null');
    if (!Array.isArray(w.box) || w.box.length !== 4 || !w.box.every(Number.isFinite)) bad('word.box must be 4 numbers');
  }
  if (!r.timings || !Number.isFinite(r.timings.inferMs) || typeof r.timings.stagesMs !== 'object') bad('timings');
  if (!(r.error === null || typeof r.error === 'string')) bad('error must be null or a string');
  return r;
}

export function variantDir(outDir, variant) {
  return join(outDir, variant);
}

export function imageResultPath(outDir, variant, name) {
  return join(variantDir(outDir, variant), `${name}.json`);
}

export function writeImageResult(outDir, variant, name, result) {
  validateImageResult(result);
  mkdirSync(variantDir(outDir, variant), { recursive: true });
  const p = imageResultPath(outDir, variant, name);
  writeFileSync(p, `${JSON.stringify(result)}\n`);
  return p;
}

export function writeRunFile(outDir, variant, run) {
  mkdirSync(variantDir(outDir, variant), { recursive: true });
  const p = join(variantDir(outDir, variant), '_run.json');
  writeFileSync(p, `${JSON.stringify(run, null, 2)}\n`);
  return p;
}
