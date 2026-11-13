// words -> visual rows -> markdown. SHARED BY THE ENGINES AND THE SCORER: do not fork this, or the engines and
// the scorer will disagree about what a "row" is.
//
// Input : words = [{ text, conf?, box: [x0, y0, x1, y1] }] in image pixels (y grows downward, axis-aligned).
// Output: rows of words, and markdown with ONE visual row per line, cells joined by a single space.
//
// Algorithm (wordsToRows):
//   1. Normalise: collapse whitespace runs in text to one space, trim; drop words that end up empty or whose box
//      has a non-finite coordinate. (A dropped word never changes the row structure of the others.)
//   2. medH = median of (y1 - y0) over the kept words with a positive height. If there is none, there are no rows.
//   3. tol = rowTol * medH (rowTol defaults to 0.5, i.e. half a typical word height).
//   4. Sort words by y-centre ((y0 + y1) / 2) ascending, ties by x0.
//   5. Sweep: keep a "current row" with the running mean y-centre of its members. A word joins the current row if
//      |its y-centre - row mean| <= tol, otherwise it closes the row and starts a new one.
//   6. Sort each row by x0 (ties by x1) and join the cells with single spaces; rows are already top-to-bottom
//      because of step 4.
// Known limits (deliberate, kept simple so the scorer can reproduce it exactly): no de-skew, so a page rotated by
// more than about tol / (row width) drifts and a long row can split; no column awareness; a word taller than ~2*medH
// (a logo, a stamp) is still just one word in one row.

export function normalizeWords(words) {
  const out = [];
  for (const w of words) {
    const text = String(w.text ?? '').replace(/\s+/g, ' ').trim();
    const b = w.box;
    if (text === '' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) continue;
    out.push({ ...w, text });
  }
  return out;
}

export function medianWordHeight(words) {
  const hs = words.map((w) => w.box[3] - w.box[1]).filter((h) => h > 0).sort((a, b) => a - b);
  if (hs.length === 0) return 0;
  const mid = hs.length >> 1;
  return hs.length % 2 ? hs[mid] : (hs[mid - 1] + hs[mid]) / 2;
}

export function wordsToRows(words, { rowTol = 0.5 } = {}) {
  const ws = normalizeWords(words);
  const medH = medianWordHeight(ws);
  if (ws.length === 0 || medH === 0) return [];
  const tol = rowTol * medH;
  const yc = (w) => (w.box[1] + w.box[3]) / 2;
  const sorted = ws.slice().sort((a, b) => yc(a) - yc(b) || a.box[0] - b.box[0]);

  const rows = [];
  let cur = null;
  for (const w of sorted) {
    const y = yc(w);
    if (cur && Math.abs(y - cur.sum / cur.words.length) <= tol) {
      cur.words.push(w);
      cur.sum += y;
    } else {
      cur = { words: [w], sum: y };
      rows.push(cur);
    }
  }
  return rows.map((r) => r.words.sort((a, b) => a.box[0] - b.box[0] || a.box[2] - b.box[2]));
}

export function rowsToMarkdown(rows) {
  return rows.map((r) => r.map((w) => w.text).join(' ')).join('\n');
}

export function wordsToMarkdown(words, opts) {
  return rowsToMarkdown(wordsToRows(words, opts));
}
