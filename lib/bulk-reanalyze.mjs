/** Return true only for a real calendar date formatted exactly as YYYY-MM-DD. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Select the currently re-analyzable diary entries for one exact date. */
export function selectReanalyzableEntries(entries, date) {
  if (!Array.isArray(entries)) throw new TypeError("diary response must be an array");
  return entries.filter(entry => entry?.date === date && entry.reanalyzable === true);
}

/**
 * Process entries through a bounded worker pool and keep going after failures.
 * Results retain input order; progress callbacks fire in real completion order.
 */
export async function runBulkReanalysis(entries, {
  concurrency = 4,
  analyze,
  onStart = () => {},
  onFinish = () => {},
} = {}) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("bulk re-analysis concurrency must be a positive integer");
  }
  if (typeof analyze !== "function") throw new TypeError("analyze must be a function");

  const results = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      const startedAt = Date.now();
      onStart({ entry, index, total: entries.length });
      try {
        const value = await analyze(entry);
        results[index] = { status: "fulfilled", entry, value };
      } catch (reason) {
        results[index] = { status: "rejected", entry, reason };
      }
      completed++;
      onFinish({
        ...results[index],
        index,
        completed,
        total: entries.length,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  const workerCount = Math.min(concurrency, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
