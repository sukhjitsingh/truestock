// Smoke engine: implements the full CLI/JSON contract with a fake recogniser (3 fake words per image) so the contract,
// helpers and the capped-container runner can be proven end to end. It does NOT read any text from the image.
//
//   node echo.mjs --variant echo --img /work/img/scan-d150.png --out /work/out --threads 2
// Test hooks (only for proving the runner / error paths):
//   --sleep-ms N      sleep N ms inside every recognize()   (exercises --timeout-ms and the runner wall-clock timeout)
//   --alloc-mb N      allocate and touch N MB per image and keep it  (exercises OOM kill / maxRss / cgroup peak)
//   --throw-doc D     throw inside recognize() for images whose doc is D  (exercises per-page error capture + masking)
//   --crash-after N   process.exit(9) hard after N images are done, no stubs  (exercises the runner's crash path)
import { runEngine } from '../lib/engine.mjs';
import { numFlag, strFlag } from '../lib/cli.mjs';
import { createTimer } from '../lib/measure.mjs';
import { resizeBilinear } from '../lib/resize.mjs';
import { toGray } from '../lib/png.mjs';

const held = [];
let seen = 0;

await runEngine({
  engine: 'echo',
  init: async ({ flags }) => ({
    sleepMs: numFlag(flags, 'sleep-ms', 0),
    allocMb: numFlag(flags, 'alloc-mb', 0),
    throwDoc: strFlag(flags, 'throw-doc', ''),
    crashAfter: numFlag(flags, 'crash-after', 0),
  }),
  recognize: async (state, { image, doc, dpi }) => {
    if (state.crashAfter > 0 && seen >= state.crashAfter) process.exit(9);
    seen++;
    if (state.throwDoc && state.throwDoc === doc) throw new Error(`fake failure for ${doc} 123`);
    const t = createTimer();
    // Touch the shared helpers so a green echo run also proves they work on the real images.
    const gray = t.timeSync('gray', () => toGray(image));
    t.timeSync('resize', () => resizeBilinear(gray, Math.max(1, gray.width >> 2), Math.max(1, gray.height >> 2)));
    if (state.allocMb > 0) {
      const buf = Buffer.alloc(state.allocMb * 1048576, 1);
      held.push(buf);
    }
    if (state.sleepMs > 0) await t.time('sleep', () => new Promise((r) => setTimeout(r, state.sleepMs)));
    const w = image.width;
    const h = image.height;
    const row = (y, x0, text) => ({ text, conf: 0.99, box: [x0, y, x0 + 0.1 * w, y + 0.02 * h] });
    return {
      words: [row(0.1 * h, 0.1 * w, 'echo'), row(0.1 * h + 2, 0.25 * w, doc), row(0.2 * h, 0.1 * w, `d${dpi}`)],
      stagesMs: t.stagesMs,
    };
  },
});
