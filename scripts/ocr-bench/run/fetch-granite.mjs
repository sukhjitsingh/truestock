// Fetches Granite-Docling (ONNX) into BENCH/models/hf through transformers.js itself, so exactly the files the chosen
// dtype combination needs are downloaded (graphs + external .onnx_data weights + tokenizer/processor configs), then
// proves the combination loads and takes a few decode steps on a SYNTHETIC image (no real content involved).
// Runs in a NETWORKED throwaway container via run/provision.sh granite [flags].
//
//   --combo min   embed_tokens q8 + vision_encoder q4f16 + decoder_model_merged q4f16   (smallest; fp16 weights on CPU)
//   --combo q4    embed_tokens q8 + vision_encoder q4     + decoder_model_merged q4     (4-bit, fp32 activations)
//   --combo q8    embed_tokens q8 + vision_encoder q8     + decoder_model_merged q8     (8-bit, lowest quality risk)
//   --combo list  print the table of repo files, no download
//   --no-smoke    download + load only, skip the decode steps
//
// The cache layout is transformers.js' own: <cacheDir>/onnx-community/granite-docling-258M-ONNX/<repo path>.
// An engine reads it offline with env.localModelPath = '/work/models/hf', env.allowLocalModels = true and
// env.allowRemoteModels = false (see engines/smoke-models.mjs). Setting allowLocalModels=false as well throws
// "both local and remote models are disabled".
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { boolFlag, parseArgs, strFlag } from '../lib/cli.mjs';
import { maskError } from '../lib/mask.mjs';

const MODEL_ID = 'onnx-community/granite-docling-258M-ONNX';
const CACHE_DIR = '/work/models/hf';
const COMBOS = {
  min: { embed_tokens: 'q8', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' },
  q4: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' },
  q8: { embed_tokens: 'q8', vision_encoder: 'q8', decoder_model_merged: 'q8' },
};

const { flags } = parseArgs(process.argv.slice(2));
const comboName = strFlag(flags, 'combo', 'min');
const smoke = boolFlag(flags, 'smoke', true);
if (comboName === 'list' || !COMBOS[comboName]) {
  console.log(`combos: ${JSON.stringify(COMBOS)}`);
  process.exit(comboName === 'list' ? 0 : 2);
}
const dtype = COMBOS[comboName];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const report = (label) => {
  let total = 0;
  const rows = [];
  try {
    for (const f of walk(CACHE_DIR)) {
      const s = statSync(f).size;
      total += s;
      rows.push(`${(s / 1048576).toFixed(2).padStart(9)} MiB  ${relative(CACHE_DIR, f)}`);
    }
  } catch {
    rows.push('(cache dir empty)');
  }
  console.log(`--- ${label}: ${rows.length} files, ${(total / 1048576).toFixed(1)} MiB total`);
  for (const r of rows.sort()) console.log(r);
};

const tf = await import('@huggingface/transformers');
const { env, AutoProcessor, AutoModelForVision2Seq, RawImage } = tf;
env.cacheDir = CACHE_DIR;
env.allowLocalModels = false;
env.allowRemoteModels = true;

console.log(`node ${process.version}  combo=${comboName} dtype=${JSON.stringify(dtype)}  cacheDir=${env.cacheDir}`);
try {
  const t0 = performance.now();
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, { dtype, device: 'cpu' });
  console.log(`loaded in ${Math.round(performance.now() - t0)} ms (download included)`);
  report('after load');

  if (smoke) {
    // Synthetic page: white background, a few black bars. No document content.
    const w = 512;
    const h = 512;
    const px = new Uint8ClampedArray(w * h * 3).fill(255);
    for (const y0 of [80, 120, 160, 200]) {
      for (let y = y0; y < y0 + 10; y++) for (let x = 60; x < 400; x++) px.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
    const image = new RawImage(px, w, h, 3);
    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Convert this page to docling.' }] }];
    const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(prompt, [image], { do_image_splitting: false });
    const t1 = performance.now();
    const ids = await model.generate({ ...inputs, max_new_tokens: 12 });
    const genMs = Math.round(performance.now() - t1);
    const promptLen = inputs.input_ids.dims.at(-1);
    const out = processor.batch_decode(ids.slice(null, [promptLen, null]), { skip_special_tokens: false });
    console.log(`smoke: promptTokens=${promptLen} newTokens<=12 generateMs=${genMs} output(synthetic)=${JSON.stringify(out[0])}`);
  }
  console.log(`RESULT combo=${comboName} OK`);
} catch (e) {
  // Model-loading errors carry no document content; print the real message so failures are diagnosable.
  console.log(`RESULT combo=${comboName} FAILED`);
  console.log(`error: ${e?.name}: ${String(e?.message ?? e).slice(0, 600)}`);
  console.log(`(masked form: ${maskError(e, 80)})`);
  report('after failure');
  process.exit(1);
}
report('final');
