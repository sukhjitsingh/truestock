// Renders the two real input PDFs to PNGs at several DPIs (pure-WASM PDFium, no network, no native deps).
// Run through run/provision.sh render (container with PDFs mounted read-only at /in/scan and /in/photo).
//
//   /work/img/<doc>-d<dpi>.png   8-bit RGB, no alpha   (multi-page documents: <doc>p<N>-d<dpi>.png)
//   /work/img/manifest.json      array of { doc, page, dpi, file, width, height, bytes, sha256, megapixels }
//   /work/img/render-meta.json   { pdfs: [{doc, pages, pageSizePt}], skipped: [...], maxMegapixels }
//
// DPI convention: scale = dpi / 72 against the PDF page size in points. For the photo the page is the JPEG's pixel
// size at 72 dpi (the PDF is only a wrapper), so "dpi" there is an upscale factor over the source pixels.
// Anything above --max-mp megapixels (default 25) is NOT rendered and is listed under `skipped`.
// Prints structure only (names, sizes), never content.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { boolFlag, numFlag, parseArgs, strFlag } from '../lib/cli.mjs';
import { decodePng, encodePng, toRgb } from '../lib/png.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const dpis = strFlag(flags, 'dpis', '100,150,200').split(',').map(Number);
const maxMp = numFlag(flags, 'max-mp', 25);
const outDir = strFlag(flags, 'out', '/work/img');
const dryRun = boolFlag(flags, 'dry-run', false);
const docs = [
  { doc: 'scan', path: '/in/scan/3.pdf' },
  { doc: 'photo', path: '/in/photo/photo.pdf' },
];

const lib = await PDFiumLibrary.init();
const manifest = [];
const meta = { pdfs: [], skipped: [], maxMegapixels: maxMp };

for (const { doc, path } of docs) {
  const pdf = await lib.loadDocument(readFileSync(path));
  const pages = pdf.getPageCount();
  const sizes = [];
  for (let i = 0; i < pages; i++) {
    const page = pdf.getPage(i);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    sizes.push([originalWidth, originalHeight]);
    for (const dpi of dpis) {
      const name = pages > 1 ? `${doc}p${i + 1}` : doc;
      const scale = dpi / 72;
      const w = Math.round(originalWidth * scale);
      const h = Math.round(originalHeight * scale);
      const mp = Math.round((w * h) / 1e4) / 100;
      if (mp > maxMp) {
        console.log(`SKIP ${name}-d${dpi}: ${w}x${h} = ${mp} MP > ${maxMp} MP`);
        meta.skipped.push({ doc: name, dpi, width: w, height: h, megapixels: mp, reason: `exceeds ${maxMp} MP` });
        continue;
      }
      if (dryRun) {
        console.log(`would render ${name}-d${dpi}: ${w}x${h} = ${mp} MP`);
        continue;
      }
      const r = await page.render({ scale, render: 'bitmap', colorSpace: 'RGBA', transparent: false });
      const rgb = toRgb({ width: r.width, height: r.height, channels: 4, data: r.data });
      const png = encodePng(rgb);
      const file = `${name}-d${dpi}.png`;
      writeFileSync(`${outDir}/${file}`, png);
      // Verify: decode with our own lib and compare every RGB sample against what was rendered.
      const back = decodePng(png);
      let same = back.width === r.width && back.height === r.height;
      for (let p = 0; same && p < r.width * r.height; p++) {
        same = back.data[p * 4] === r.data[p * 4] && back.data[p * 4 + 1] === r.data[p * 4 + 1] &&
          back.data[p * 4 + 2] === r.data[p * 4 + 2] && back.data[p * 4 + 3] === 255;
      }
      if (!same) throw new Error(`round-trip mismatch for ${file}`);
      manifest.push({
        doc: name,
        page: pages > 1 ? i + 1 : null,
        dpi,
        file,
        width: r.width,
        height: r.height,
        bytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        megapixels: Math.round((r.width * r.height) / 1e4) / 100,
      });
      console.log(`ok ${file}: ${r.width}x${r.height} ${(png.length / 1048576).toFixed(2)} MiB, round-trip identical`);
    }
    page.close();
  }
  meta.pdfs.push({ doc, pages, pageSizePt: sizes });
  pdf.destroy();
}
lib.destroy();

if (!dryRun) {
  writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${outDir}/render-meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`wrote manifest.json (${manifest.length} images), skipped ${meta.skipped.length}`);
}
