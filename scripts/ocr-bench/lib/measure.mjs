// Process- and container-level measurement helpers. No third-party imports.
import { readFileSync } from 'node:fs';

const round1 = (n) => Math.round(n * 10) / 10;

/** Peak resident set size of this process so far, in MB (libuv reports KB on every platform). */
export function maxRssMb() {
  return round1(process.resourceUsage().maxRSS / 1024);
}

/** Current RSS in MB. */
export function rssMb() {
  return round1(process.memoryUsage.rss() / 1048576);
}

function readNumber(path) {
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (t === '' || t === 'max') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Peak memory of the whole container cgroup in MB, or null if the kernel does not expose it.
 * cgroup v2: /sys/fs/cgroup/memory.peak (Linux >= 5.19); cgroup v1: memory/memory.max_usage_in_bytes.
 * NOTE: this counts page cache too (reading models from a bind mount is charged to the container), so it can read
 * higher than the process RSS. The cap decides OOM on anonymous memory plus non-reclaimable cache.
 */
export function cgroupPeakMb() {
  const b =
    readNumber('/sys/fs/cgroup/memory.peak') ?? readNumber('/sys/fs/cgroup/memory/memory.max_usage_in_bytes');
  return b === null ? null : round1(b / 1048576);
}

/** Configured memory limit of the container cgroup in MB, or null (unlimited/unknown). */
export function cgroupLimitMb() {
  const b = readNumber('/sys/fs/cgroup/memory.max') ?? readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // cgroup v1 reports a huge number for "no limit".
  return b === null || b > 2 ** 52 ? null : round1(b / 1048576);
}

/** Anonymous vs file-cache split of the container's current usage in MB (cgroup v2 memory.stat), or null. */
export function cgroupSplitMb() {
  try {
    const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
    const get = (k) => {
      const m = new RegExp(`^${k} (\\d+)$`, 'm').exec(stat);
      return m ? round1(Number(m[1]) / 1048576) : null;
    };
    return { anonMb: get('anon'), fileMb: get('file') };
  } catch {
    return null;
  }
}

/** Wall-clock milliseconds, rounded to 0.1 ms. */
export function nowMs() {
  return performance.now();
}

export function elapsedMs(t0) {
  return round1(performance.now() - t0);
}

/**
 * Stage timer: `const t = createTimer(); await t.time('detect', () => ...); t.stagesMs` -> { detect: 123.4 }.
 * Repeated names accumulate.
 */
export function createTimer() {
  const stagesMs = {};
  const add = (name, ms) => {
    stagesMs[name] = round1((stagesMs[name] ?? 0) + ms);
  };
  return {
    stagesMs,
    async time(name, fn) {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        add(name, performance.now() - t0);
      }
    },
    timeSync(name, fn) {
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        add(name, performance.now() - t0);
      }
    },
  };
}
