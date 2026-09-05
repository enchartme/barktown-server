/** Return true only for a real calendar date formatted exactly as YYYY-MM-DD. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const TUNING_OPTIONS = {
  "-t": { field: "candidateThreshold", label: "threshold", min: 0, max: 1 },
  "--threshold": { field: "candidateThreshold", label: "threshold", min: 0, max: 1 },
  "-r": { field: "hitRefractoryS", label: "refractory", min: 0 },
  "--refractory": { field: "hitRefractoryS", label: "refractory", min: 0 },
  "-w": { field: "inferenceWindowS", label: "window", min: 0.1 },
  "--window": { field: "inferenceWindowS", label: "window", min: 0.1 },
  "-s": { field: "scoreIntervalS", label: "step", min: 0.05 },
  "--step": { field: "scoreIntervalS", label: "step", min: 0.05 },
};

/** Parse one-day or inclusive-date-range CLI arguments and per-run tuning. */
export function parseBulkReanalyzeArgs(args) {
  if (!Array.isArray(args)) throw new TypeError("arguments must be an array");

  let positionalDate = null;
  let startDate = null;
  let endDate = null;
  const tuning = {};

  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!option.startsWith("-")) {
      if (positionalDate !== null) throw new Error("only one positional date is allowed");
      positionalDate = option;
      continue;
    }

    const value = args[++index];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--start-date") startDate = value;
    else if (option === "--end-date") endDate = value;
    else if (TUNING_OPTIONS[option]) {
      const spec = TUNING_OPTIONS[option];
      const parsed = Number(value);
      const outsideRange = !Number.isFinite(parsed)
        || parsed < spec.min
        || (spec.max !== undefined && parsed > spec.max);
      if (outsideRange) {
        const range = spec.max === undefined ? `>= ${spec.min}` : `in [${spec.min}, ${spec.max}]`;
        throw new Error(`${spec.label} must be a number ${range}`);
      }
      tuning[spec.field] = parsed;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }

  if (positionalDate !== null) {
    if (startDate !== null || endDate !== null) {
      throw new Error("use either one positional date or --start-date/--end-date, not both");
    }
    startDate = positionalDate;
    endDate = positionalDate;
  } else if (startDate === null || endDate === null) {
    throw new Error("provide one date, or both --start-date and --end-date");
  }

  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("dates must be real calendar dates in YYYY-MM-DD format");
  }
  if (startDate > endDate) throw new Error("start date must not be later than end date");

  return { startDate, endDate, tuning };
}

/** Select currently re-analyzable diary entries in an inclusive date range. */
export function selectReanalyzableEntries(entries, startDate, endDate = startDate) {
  if (!Array.isArray(entries)) throw new TypeError("diary response must be an array");
  return entries.filter(entry => (
    entry?.date >= startDate
    && entry.date <= endDate
    && entry.reanalyzable === true
  ));
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
