// Provisioning only (needs the network, run via run/provision.sh models). Not an engine.
// Produces /work/models/tessdata/{fast,best_int}/eng.traineddata (uncompressed).
//   best_int : @tesseract.js-data/eng@1.0.0 ships 4.0.0_best_int/eng.traineddata.gz (gunzip it).
//   fast     : that package has NO 4.0.0_fast, so take the official tesseract-ocr/tessdata_fast (tag 4.1.0).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const FAST_URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/eng.traineddata';
const BEST_INT_GZ = '/bench/node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const OUT = '/work/models/tessdata';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(`${OUT}/fast`, { recursive: true });
mkdirSync(`${OUT}/best_int`, { recursive: true });

const best = gunzipSync(readFileSync(BEST_INT_GZ));
writeFileSync(`${OUT}/best_int/eng.traineddata`, best);
console.log(`best_int: ${best.length} bytes sha256=${sha256(best)}`);

const res = await fetch(FAST_URL, { redirect: 'follow' });
if (!res.ok) throw new Error(`fast download failed: HTTP ${res.status}`);
const fast = Buffer.from(await res.arrayBuffer());
writeFileSync(`${OUT}/fast/eng.traineddata`, fast);
console.log(`fast: ${fast.length} bytes sha256=${sha256(fast)} from ${FAST_URL}`);

if (best.length < 1_000_000 || fast.length < 1_000_000) throw new Error('suspiciously small traineddata');
