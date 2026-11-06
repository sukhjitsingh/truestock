/**
 * A fake camera for the browser harness: renders a retail barcode into a
 * YUV4MPEG2 (.y4m) video that Chromium can play as its webcam
 * (`--use-file-for-fake-video-capture`).
 *
 * Why this exists: the enroll screens ("Which bottle is this?", the size
 * confirmation) are reachable ONLY after a real scan. Without a camera they
 * could be checked only by hand on a phone. Feeding Chromium a video of a real,
 * correctly encoded barcode lets the app's own detector decode it, so the
 * whole path — camera → decoder → resolve → enroll — runs in the harness.
 *
 * Self-contained on purpose: no image library, no barcode package. EAN-13 and
 * UPC-E are fixed, public encodings, and the patterns below are the standard
 * GS1 tables. The check digit is validated, never computed silently, so a
 * typo in a test fixture fails loudly here instead of becoming a barcode the
 * detector reads as something else.
 */
import { writeFileSync } from "node:fs";

const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
// EAN-13 parity of the left six digits, chosen by the first digit.
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
// UPC-E parity of the six digits, number system 0, chosen by the check digit.
const UPCE_PARITY_NS0 = ["GGGLLL","GGLGLL","GGLLGL","GGLLLG","GLGGLL","GLLGGL","GLLLGG","GLGLGL","GLGLLG","GLLGLG"];

export function gs1CheckDigitValid(digits) {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** Modules ("1" bar, "0" space) for a 13-digit EAN-13, or a 12-digit UPC-A. */
export function ean13Modules(code) {
  const c = code.length === 12 ? `0${code}` : code;
  if (!/^\d{13}$/.test(c) || !gs1CheckDigitValid(c)) throw new Error(`not a valid EAN-13/UPC-A: ${code}`);
  const parity = PARITY[Number(c[0])];
  let m = "101";
  for (let i = 1; i <= 6; i++) m += (parity[i - 1] === "L" ? L : G)[Number(c[i])];
  m += "01010";
  for (let i = 7; i <= 12; i++) m += R[Number(c[i])];
  return m + "101";
}

/** Modules for an 8-digit UPC-E (number system 0). Caller supplies a valid code. */
export function upcEModules(code) {
  if (!/^0\d{7}$/.test(code)) throw new Error(`UPC-E must be 8 digits starting with 0: ${code}`);
  const parity = UPCE_PARITY_NS0[Number(code[7])];
  let m = "101";
  for (let i = 1; i <= 6; i++) m += (parity[i - 1] === "L" ? L : G)[Number(code[i])];
  return m + "010101";
}

/**
 * Write a .y4m showing the barcode, centred, black on white, `frames` long.
 * 640x480, 4:2:0, chroma neutral (grey) — a monochrome image is all a 1-D
 * barcode needs, and it keeps the file small.
 */
export function writeBarcodeY4m(path, modules, { width = 640, height = 480, moduleWidth = 4, frames = 30 } = {}) {
  const barWidth = modules.length * moduleWidth;
  if (barWidth > width - 40) throw new Error("barcode wider than the frame");
  const x0 = Math.floor((width - barWidth) / 2);
  const top = Math.floor(height * 0.2);
  const bottom = Math.floor(height * 0.8);

  const y = Buffer.alloc(width * height, 235); // white (video-range luma)
  for (let row = top; row < bottom; row++) {
    for (let i = 0; i < modules.length; i++) {
      if (modules[i] !== "1") continue;
      const start = row * width + x0 + i * moduleWidth;
      y.fill(16, start, start + moduleWidth); // black
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`);
  writeFileSync(path, Buffer.concat([header, ...Array(frames).fill(frame)]));
  return path;
}
