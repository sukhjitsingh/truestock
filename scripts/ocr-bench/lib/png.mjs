// PNG decode/encode helpers (pngjs) and small pixel conversions.
//
// Image shape used everywhere in the harness: { width, height, channels, data }
//   channels 1 = gray, 3 = RGB, 4 = RGBA; data is a Uint8Array of width*height*channels, row-major, interleaved.
// This is the only harness module that imports a third-party package (pngjs); keep it that way so
// host-side scripts (run/finish.mjs) can import the other lib modules without node_modules.
import { PNG } from 'pngjs';

/** Decode any PNG to 8-bit RGBA. 16-bit and palette inputs are rescaled/expanded by pngjs. */
export function decodePng(buf) {
  const png = PNG.sync.read(buf);
  const data = new Uint8Array(png.data.buffer, png.data.byteOffset, png.width * png.height * 4);
  return { width: png.width, height: png.height, channels: 4, data };
}

/** RGBA or RGB -> gray with Rec. 601 luma, rounded. Alpha is ignored (images here are opaque). */
export function toGray(img) {
  if (img.channels === 1) return img;
  if (img.channels !== 3 && img.channels !== 4) throw new Error(`toGray: unsupported channels ${img.channels}`);
  const { width, height, channels, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += channels) {
    out[i] = (299 * data[j] + 587 * data[j + 1] + 114 * data[j + 2] + 500) / 1000;
  }
  return { width, height, channels: 1, data: out };
}

/** RGBA or gray -> RGB (drops alpha, replicates gray). */
export function toRgb(img) {
  if (img.channels === 3) return img;
  const { width, height, channels, data } = img;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0, k = 0; i < width * height; i++, j += channels, k += 3) {
    if (channels === 1) {
      out[k] = out[k + 1] = out[k + 2] = data[j];
    } else if (channels === 4) {
      out[k] = data[j];
      out[k + 1] = data[j + 1];
      out[k + 2] = data[j + 2];
    } else {
      throw new Error(`toRgb: unsupported channels ${channels}`);
    }
  }
  return { width, height, channels: 3, data: out };
}

function toRgba(img) {
  if (img.channels === 4) return img.data;
  const { width, height, channels, data } = img;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0, k = 0; i < width * height; i++, j += channels, k += 4) {
    if (channels === 1) {
      out[k] = out[k + 1] = out[k + 2] = data[j];
    } else if (channels === 3) {
      out[k] = data[j];
      out[k + 1] = data[j + 1];
      out[k + 2] = data[j + 2];
    } else {
      throw new Error(`encodePng: unsupported channels ${channels}`);
    }
    out[k + 3] = 255;
  }
  return out;
}

/**
 * Encode an image to an 8-bit PNG. Output colour type follows `channels`:
 * 1 -> gray, 3 -> RGB (no alpha), 4 -> RGBA. Returns a Buffer.
 */
export function encodePng(img, { level = 6 } = {}) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[img.channels];
  if (colorType === undefined) throw new Error(`encodePng: unsupported channels ${img.channels}`);
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(toRgba(img));
  return PNG.sync.write(png, { colorType, inputColorType: 6, inputHasAlpha: true, deflateLevel: level });
}
