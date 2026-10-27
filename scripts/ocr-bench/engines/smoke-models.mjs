// NOT an OCR engine. Offline load-check of the provisioned model sets, run through the same capped, network-less
// runner as the real engines, so "the files are there and the runtimes can open them" is proven under the real recipe:
//
//   run-capped.sh smoke-ppocr     smoke-models 1536m 2 2 scan-d100.png --what ppocr
//   run-capped.sh smoke-tess-fast smoke-models 1536m 2 2 scan-d100.png --what tesseract --tess-data fast
//   run-capped.sh smoke-granite   smoke-models 3072m 2 2 scan-d100.png --what granite --combo q4
//
// It never reads the input image's content (a synthetic white page with black bars is used where a page is needed) and
// it emits no words. Facts go to stderr/stdout and into `markdown` as plain status text.
import { runEngine } from '../lib/engine.mjs';
import { numFlag, strFlag } from '../lib/cli.mjs';
import { createTimer } from '../lib/measure.mjs';
import { encodePng } from '../lib/png.mjs';
import { readFileSync } from 'node:fs';

const GRANITE_ID = 'onnx-community/granite-docling-258M-ONNX';
const GRANITE_COMBOS = {
  min: { embed_tokens: 'q8', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' },
  q4: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' },
  q8: { embed_tokens: 'q8', vision_encoder: 'q8', decoder_model_merged: 'q8' },
};

function syntheticPage(size = 512) {
  const data = new Uint8Array(size * size * 3).fill(255);
  for (const y0 of [80, 120, 160, 200]) {
    for (let y = y0; y < y0 + 10; y++) for (let x = 60; x < 400; x++) data.fill(0, (y * size + x) * 3, (y * size + x) * 3 + 3);
  }
  return { width: size, height: size, channels: 3, data };
}

await runEngine({
  engine: 'smoke-models',
  init: async ({ opts, flags }) => {
    const what = strFlag(flags, 'what', 'ppocr');
    const state = { what, facts: '' };
    if (what === 'ppocr') {
      const ort = await import('onnxruntime-node');
      const sessionOptions = { intraOpNumThreads: opts.threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
      const det = await ort.InferenceSession.create('/work/models/ppocr/det.onnx', sessionOptions);
      const rec = await ort.InferenceSession.create('/work/models/ppocr/rec.onnx', sessionOptions);
      const dictLines = readFileSync('/work/models/ppocr/dict.txt', 'utf8').split('\n').length;
      state.facts = `ort=${ort.env?.versions?.node ?? 'n/a'} det in=${det.inputNames} out=${det.outputNames}; rec in=${rec.inputNames} out=${rec.outputNames}; dictLines=${dictLines}`;
      state.sessions = { det, rec };
    } else if (what === 'tesseract') {
      const { createWorker } = await import('tesseract.js');
      const set = strFlag(flags, 'tess-data', 'best_int');
      state.worker = await createWorker('eng', 1, {
        langPath: `/work/models/tessdata/${set}`,
        gzip: false,
        cacheMethod: 'none',
      });
      state.facts = `tesseract worker ready, traineddata=${set}`;
    } else if (what === 'granite') {
      const tf = await import('@huggingface/transformers');
      // Offline recipe: the fetch step stores files at <cacheDir>/<model id>/<repo path>, which is also exactly the
      // layout of a local model dir, so point localModelPath at it. (allowLocalModels=false together with
      // allowRemoteModels=false throws "both local and remote models are disabled".)
      tf.env.localModelPath = '/work/models/hf';
      tf.env.allowLocalModels = true;
      tf.env.allowRemoteModels = false;
      const combo = strFlag(flags, 'combo', 'q4');
      if (!GRANITE_COMBOS[combo]) throw new Error(`unknown --combo ${combo}`);
      state.processor = await tf.AutoProcessor.from_pretrained(GRANITE_ID);
      state.model = await tf.AutoModelForVision2Seq.from_pretrained(GRANITE_ID, { dtype: GRANITE_COMBOS[combo], device: 'cpu' });
      state.tf = tf;
      state.maxNew = numFlag(flags, 'max-new', 8);
      state.facts = `granite loaded offline, combo=${combo} ${JSON.stringify(GRANITE_COMBOS[combo])}`;
    } else {
      throw new Error(`unknown --what ${what}`);
    }
    console.log(`[smoke-models] ${state.facts}`);
    return state;
  },
  recognize: async (state) => {
    const t = createTimer();
    const page = syntheticPage();
    let note = state.facts;
    if (state.what === 'tesseract') {
      const res = await t.time('recognize', () => state.worker.recognize(Buffer.from(encodePng(page))));
      note = `${state.facts}; recognize returned (confidence field present: ${typeof res.data.confidence === 'number'})`;
    } else if (state.what === 'granite') {
      const { RawImage } = state.tf;
      const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Convert this page to docling.' }] }];
      const prompt = state.processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await state.processor(prompt, [new RawImage(page.data, page.width, page.height, 3)], { do_image_splitting: false });
      const ids = await t.time('generate', () => state.model.generate({ ...inputs, max_new_tokens: state.maxNew }));
      note = `${state.facts}; generated ${ids.dims.at(-1) - inputs.input_ids.dims.at(-1)} new tokens`;
    }
    console.log(`[smoke-models] ${note}`);
    return { words: [], markdown: note, stagesMs: t.stagesMs };
  },
  close: async (state) => {
    await state.worker?.terminate();
  },
});
