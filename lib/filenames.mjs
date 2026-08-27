// lib/filenames.mjs — filename parsing/validation shared by the ingest
// service and maintenance scripts. Keep the two patterns in sync with the
// README's documented conventions.

// Diary recordings:  YYYY-MM-DD HH-MM-SS optional comment.(m4a|aac|wav|mp3)
const FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})(?:\s+(\S.*?))?\.(m4a|aac|wav|mp3)$/i;

// Short-form voice-recorder filenames:  D Mmm at HH-MM optional comment.(m4a|aac|wav|mp3)
// e.g. "1 Apr at 17-46 bark bark.m4a"
const SHORT_FILENAME_RE =
  /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) at (\d{2})-(\d{2})(?:\s+(\S.*?))?\.(m4a|aac|wav|mp3)$/i;

const _MONTH_NUM = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Historical Goblin uploads embedded a mutable analysis snapshot after the
// durable "-A-" marker. hit_metadata is now the source of truth for these
// values, so new ingest/API paths collapse only that exact legacy suffix.
// Keep this deliberately strict: a free-form label that merely contains a
// C/D/W token must never be rewritten.
const AUTO_DETECTION_STATS_LABEL_RE =
  /^-A-\s+C\d+(?:\.\d+)?\s+D\d+(?:\.\d+)?\s+W\d+(?:\s+La\d+(?:\.\d+)?)?(?:\s+Lm\d+(?:\.\d+)?)?$/i;
const AUTO_DETECTION_STATS_ID_RE =
  /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_-A-)_C\d+(?:_\d+)?_D\d+(?:_\d+)?_W\d+(?:_La\d+(?:_\d+)?)?(?:_Lm\d+(?:_\d+)?)?$/i;

/** Slugify a filename stem into a stable, URL/filesystem-safe id. */
function slugify(stem) {
  return stem
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/, "");
}

/** Collapse an exact historical auto-detection stats label to its stable marker. */
export function canonicalizeAutoDetectionLabel(label) {
  return AUTO_DETECTION_STATS_LABEL_RE.test(label ?? "") ? "-A-" : label;
}

/**
 * Return the stable form of a diary filename while preserving its extension.
 * Non-auto and already-canonical filenames are returned unchanged.
 */
export function canonicalizeAutoDetectionFilename(filename) {
  const match = FILENAME_RE.exec(filename);
  if (!match) return filename;
  const [, datePart, hh, mm, ss, rawLabel, rawExt] = match;
  const label = canonicalizeAutoDetectionLabel(rawLabel?.trim() ?? "");
  if (label === (rawLabel?.trim() ?? "")) return filename;
  return `${datePart} ${hh}-${mm}-${ss} ${label}.${rawExt}`;
}

/** Collapse a slugified historical auto-detection ID to its stable identity. */
export function canonicalizeAutoDetectionId(id) {
  const match = AUTO_DETECTION_STATS_ID_RE.exec(id ?? "");
  return match ? match[1] : id;
}

/** Parse a diary recording filename. Returns null if it doesn't match. */
export function parseFilename(filename) {
  const match = FILENAME_RE.exec(filename);
  if (!match) return null;

  const [, datePart, hh, mm, ss, rawLabel] = match;
  const label = rawLabel ? rawLabel.trim() : "";
  const date = datePart;
  const time = `${hh}:${mm}`;
  const datetimeLocal = `${date}T${hh}:${mm}:${ss}`;

  const ext = filename.match(/\.(m4a|aac|wav|mp3)$/i)[0];
  const stem = filename.slice(0, -ext.length);
  const id = slugify(stem);

  return { date, time, datetimeLocal, label, id };
}

/**
 * Parse a short-form voice-recorder filename ("D Mmm at HH-MM [comment].ext").
 * Returns null if it doesn't match.
 * On success returns the same shape as parseFilename plus `normalisedFilename`
 * — the equivalent canonical "YYYY-MM-DD HH-MM-SS [comment].ext" name that
 * should be used as the storage destination.
 */
export function parseShortFilename(filename) {
  const match = SHORT_FILENAME_RE.exec(filename);
  if (!match) return null;

  const [, day, mon, hh, mm, rawLabel, rawExt] = match;
  const label = rawLabel ? rawLabel.trim() : "";
  const monthStr = _MONTH_NUM[mon.toLowerCase()];
  const year = new Date().getFullYear();
  const date = `${year}-${monthStr}-${day.padStart(2, "0")}`;
  const ss = "00";
  const time = `${hh}:${mm}`;
  const datetimeLocal = `${date}T${hh}:${mm}:${ss}`;

  const normalisedStem = `${date} ${hh}-${mm}-${ss}${label ? ` ${label}` : ""}`;
  const normalisedFilename = `${normalisedStem}.${rawExt.toLowerCase()}`;
  const id = slugify(normalisedStem);

  return { date, time, datetimeLocal, label, id, normalisedFilename };
}

// Training samples (uploaded by barktown-goblin):
//   YYYY-MM-DD HH-MM-SS SAMPLE <label>.wav
const SAMPLE_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2}) SAMPLE ([a-z]+)\.wav$/i;
const SAMPLE_MARKER_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} SAMPLE\b/i;

/** True when SAMPLE reserves this inbox object for training-sample ingest. */
export function isSampleFilenameCandidate(filename) {
  return SAMPLE_MARKER_RE.test(filename);
}

/** Parse a training-sample filename. Returns null if it doesn't match. */
export function parseSampleFilename(filename) {
  const match = SAMPLE_FILENAME_RE.exec(filename);
  if (!match) return null;
  const [, datePart, hh, mm, ss, label] = match;
  const datetimeLocal = `${datePart}T${hh}:${mm}:${ss}`;
  const stem = filename.slice(0, -".wav".length);
  const id = slugify(stem);
  return { date: datePart, datetimeLocal, label: label.toLowerCase(), id };
}
