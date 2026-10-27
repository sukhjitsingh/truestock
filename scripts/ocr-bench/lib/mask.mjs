// Masking for anything that could echo invoice content into a log, JSON error field, or report.
// Letters -> 'a', digits -> '9'; everything else (punctuation, whitespace, symbols) is kept so the SHAPE survives.

/** Mask text: any Unicode letter -> 'a', any Unicode decimal digit -> '9'. */
export function maskText(s) {
  return String(s ?? '').replace(/\p{L}/gu, 'a').replace(/\p{Nd}/gu, '9');
}

/**
 * Masked one-line description of an error, safe to store in the per-image `error` field.
 * Keeps nothing but shape and the error class name (class names carry no document content).
 */
export function maskError(err, maxLen = 200) {
  const name = err && typeof err === 'object' && typeof err.name === 'string' ? err.name : 'Error';
  const msg = err && typeof err === 'object' && 'message' in err ? err.message : err;
  const flat = maskText(String(msg ?? '')).replace(/\s+/g, ' ').trim();
  const out = `${name}: ${flat}`;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}~` : out;
}
