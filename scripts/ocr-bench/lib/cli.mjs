// Tiny CLI parser shared by all engines (engines have different extra flags, so no fixed schema).
//
//   --key value     string flag          --key=value   same
//   --flag          boolean true (when the next token is missing or starts with "--")
//   --no-flag       boolean false
// Anything not starting with "--" and not consumed as a value goes to `rest`.
import { basename } from 'node:path';

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--no-')) {
      flags[a.slice(5)] = false;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[a.slice(2)] = argv[++i];
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { flags, rest };
}

export function strFlag(flags, name, dflt = undefined) {
  const v = flags[name];
  return v === undefined || v === true || v === false ? dflt : String(v);
}

export function numFlag(flags, name, dflt = undefined) {
  const v = flags[name];
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

export function boolFlag(flags, name, dflt = false) {
  const v = flags[name];
  if (v === undefined) return dflt;
  if (v === true || v === false) return v;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

/**
 * Image names are <doc>[p<page>]-d<dpi>.png, e.g. scan-d150.png, photo-d100.png, scanp2-d150.png.
 * Returns { doc, page|null, dpi, name } where `name` is the base file name without extension (also the name of the
 * result JSON), or null when the file name does not follow the convention.
 */
export function parseImageName(pathOrName) {
  const m = /^([a-z]+?)(?:p(\d+))?-d(\d+)\.png$/i.exec(basename(pathOrName));
  if (!m) return null;
  return {
    doc: m[1],
    page: m[2] === undefined ? null : Number(m[2]),
    dpi: Number(m[3]),
    name: basename(pathOrName).replace(/\.png$/i, ''),
  };
}

/** The flags every engine understands, validated. Throws on missing/invalid required flags. */
export function commonOptions(flags) {
  const variant = strFlag(flags, 'variant');
  const img = strFlag(flags, 'img');
  if (!variant || !/^[A-Za-z0-9._-]+$/.test(variant)) throw new Error('--variant is required ([A-Za-z0-9._-]+)');
  if (!img) throw new Error('--img is required (comma-separated PNG paths)');
  return {
    variant,
    imgs: img.split(',').map((s) => s.trim()).filter(Boolean),
    outDir: strFlag(flags, 'out', '/work/out'),
    threads: numFlag(flags, 'threads', 2),
    timeoutMs: numFlag(flags, 'timeout-ms', 0),
  };
}
