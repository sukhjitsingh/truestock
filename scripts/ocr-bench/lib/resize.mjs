// Bilinear resize for interleaved images ({ width, height, channels, data }).
//
// Sampling convention is pixel-centre ("half-pixel", align_corners=false), the same as OpenCV INTER_LINEAR and
// PyTorch/ONNX Resize(linear, half_pixel): source x = (dx + 0.5) * sw/dw - 0.5, clamped to [0, sw-1].
// No anti-aliasing prefilter, so large downscales (>2x) alias slightly; that matches what detection
// pre-processing in the reference PP-OCR pipelines does (cv2.resize), which is the point of using it.

function axisTable(srcLen, dstLen) {
  const i0 = new Int32Array(dstLen);
  const i1 = new Int32Array(dstLen);
  const w = new Float32Array(dstLen);
  const scale = srcLen / dstLen;
  for (let d = 0; d < dstLen; d++) {
    let f = (d + 0.5) * scale - 0.5;
    if (f < 0) f = 0;
    if (f > srcLen - 1) f = srcLen - 1;
    const lo = Math.floor(f);
    i0[d] = lo;
    i1[d] = Math.min(lo + 1, srcLen - 1);
    w[d] = f - lo;
  }
  return { i0, i1, w };
}

/**
 * @param {{width:number,height:number,channels:number,data:Uint8Array}} img
 * @param {number} dw destination width (>= 1)
 * @param {number} dh destination height (>= 1)
 * @param {{float?: boolean}} [opts] float: true returns data as Float32Array holding unrounded 0..255 values
 */
export function resizeBilinear(img, dw, dh, { float = false } = {}) {
  const { width: sw, height: sh, channels: c, data } = img;
  if (!(dw >= 1 && dh >= 1) || !Number.isInteger(dw) || !Number.isInteger(dh)) {
    throw new Error(`resizeBilinear: bad destination ${dw}x${dh}`);
  }
  const out = float ? new Float32Array(dw * dh * c) : new Uint8Array(dw * dh * c);
  const xt = axisTable(sw, dw);
  const yt = axisTable(sh, dh);
  for (let y = 0; y < dh; y++) {
    const r0 = yt.i0[y] * sw * c;
    const r1 = yt.i1[y] * sw * c;
    const wy = yt.w[y];
    for (let x = 0; x < dw; x++) {
      const a = xt.i0[x] * c;
      const b = xt.i1[x] * c;
      const wx = xt.w[x];
      const o = (y * dw + x) * c;
      for (let k = 0; k < c; k++) {
        const top = data[r0 + a + k] * (1 - wx) + data[r0 + b + k] * wx;
        const bot = data[r1 + a + k] * (1 - wx) + data[r1 + b + k] * wx;
        const v = top * (1 - wy) + bot * wy;
        out[o + k] = float ? v : Math.round(v);
      }
    }
  }
  return { width: dw, height: dh, channels: c, data: out };
}
