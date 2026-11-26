import { SAMPLE_LABELS } from './sample-labels.mjs';

export const AUTO_APPROVAL_RULE_VERSION = 3;
export const AUTO_APPROVAL_SETTINGS = [
  { key: 'auto_approve_require_all', value: 1, min: 0, max: 1, integer: true, description: 'Join the four approval conditions: 1 = AND (all 4), 0 = OR (at least 1).' },
  { key: 'auto_approve_mean_loudness_min', value: 4, min: 1, max: 10, description: 'Minimum mean loudness ratio for automatic approval (inclusive).' },
  { key: 'auto_approve_density_min', value: 50, min: 0, max: 100, description: 'Minimum unfiltered window density percentage for automatic approval (inclusive).' },
  { key: 'auto_approve_delta_mean_min', value: .9, min: .5, max: 1, description: 'Minimum mean window delta for automatic approval (inclusive).' },
  { key: 'auto_approve_delta_sigma_max', value: .1, min: 0, max: 1, description: 'Maximum population standard deviation of window delta for automatic approval (inclusive).' },
  { key: 'auto_approve_trim_sparse_tails_s', value: 0, min: 0, max: 120, description: 'Maximum bundle span and nearby supporting-window distance in seconds; 0 disables sparse-tail trimming.' },
  { key: 'auto_approve_bundle_count', value: 1, min: 1, max: 5, integer: true, description: 'Minimum windows in a compact bundle, plus one additional nearby supporting window.' },
];
const positiveLabels = ['bark', 'yap'];
const negativeLabels = SAMPLE_LABELS.filter(label => !positiveLabels.includes(label));

function recordingBounds(entry) {
  const durationMs = Math.round(entry.durationSec * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const validTrim = Number.isInteger(entry.trimStartMs) && Number.isInteger(entry.trimStopMs)
    && entry.trimStartMs >= 0 && entry.trimStopMs > entry.trimStartMs && entry.trimStopMs <= durationMs;
  return { startMs: validTrim ? entry.trimStartMs : 0, stopMs: validTrim ? entry.trimStopMs : durationMs };
}

/** Retain the envelope of every compact bundle with a nearby extra window. */
export function sparseTailTrimBounds(entry, metadata, settings) {
  const seconds = settings.auto_approve_trim_sparse_tails_s ?? 0;
  const bundleCount = settings.auto_approve_bundle_count ?? 1;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120 || !Number.isInteger(bundleCount) || bundleCount < 1 || bundleCount > 5) return null;
  const bounds = recordingBounds(entry);
  if (!bounds || !Number.isFinite(metadata?.windowS) || metadata.windowS <= 0 || !Array.isArray(metadata.timestamps)) return null;
  if (!metadata.timestamps.every(Number.isFinite)) return null;
  const timestamps = [...new Set(metadata.timestamps.filter(timestamp => timestamp >= bounds.startMs / 1000 && timestamp < bounds.stopMs / 1000))].sort((a, b) => a - b);
  let first = Infinity;
  let last = -Infinity;
  for (let start = 0; start + bundleCount <= timestamps.length; start++) {
    const end = start + bundleCount - 1;
    // Bundle span uses hit timestamps; full inference-window audio is kept below.
    if (timestamps[end] - timestamps[start] > seconds) continue;
    if (start > 0 && timestamps[start] - timestamps[start - 1] < seconds) {
      first = Math.min(first, timestamps[start - 1]);
      last = Math.max(last, timestamps[end]);
    }
    if (end + 1 < timestamps.length && timestamps[end + 1] - timestamps[end] < seconds) {
      first = Math.min(first, timestamps[start]);
      last = Math.max(last, timestamps[end + 1]);
    }
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  // Hits mark inference-window ends. Preserve the first complete window, and
  // include the final anchor in the half-open trim used by counts and playback.
  // Clamp to the existing visible bounds so manual trims are never expanded.
  const trimStartMs = Math.max(bounds.startMs, Math.floor((first - metadata.windowS) * 1000));
  const trimStopMs = Math.min(bounds.stopMs, Math.floor(last * 1000) + 1);
  if (trimStartMs === bounds.startMs && trimStopMs === bounds.stopMs) return null;
  return { trimStartMs, trimStopMs };
}

/** All detected hits within the saved trim, without presentation filters. */
export function autoApprovalMetrics(entry, metadata) {
  const bounds = recordingBounds(entry);
  if (!bounds || !Number.isFinite(metadata?.windowS) || metadata.windowS <= 0) return null;
  const startSec = bounds.startMs / 1000;
  const stopSec = bounds.stopMs / 1000;
  if (!Array.isArray(metadata.timestamps) || !Array.isArray(metadata.loudnesses) || !Array.isArray(metadata.multilabelScores)) return null;
  let count = 0;
  let loudnessSum = 0;
  let mean = 0;
  let squaredDifferences = 0;
  const maximum = (scores, labels) => {
    const values = labels.map(label => scores?.[label]).filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
    return values.length ? Math.max(...values) : null;
  };
  for (let i = 0; i < metadata.timestamps.length; i++) {
    const timestamp = metadata.timestamps[i];
    if (!Number.isFinite(timestamp)) return null;
    if (timestamp < startSec || timestamp >= stopSec) continue;
    const loudness = metadata.loudnesses[i];
    const positive = maximum(metadata.multilabelScores[i], positiveLabels);
    const negative = maximum(metadata.multilabelScores[i], negativeLabels);
    // Incomplete diagnostics must not silently improve a record's statistics.
    if (!Number.isFinite(loudness) || loudness < 0 || positive === null || negative === null) return null;
    count++;
    loudnessSum += loudness;
    const delta = positive - negative;
    const difference = delta - mean;
    mean += difference / count;
    squaredDifferences += difference * (delta - mean);
  }
  // A singleton's sigma is always zero and supplies no consistency evidence.
  if (count < 2) return null;
  return {
    windowCount: count, windowS: metadata.windowS, startSec, stopSec,
    meanLoudness: loudnessSum / count,
    density: count * metadata.windowS / (stopSec - startSec) * 100,
    deltaMean: mean,
    deltaSigma: Math.sqrt(Math.max(0, squaredDifferences / count)),
  };
}

export function passesAutoApproval(metrics, settings) {
  if (!metrics) return false;
  // Tolerance only absorbs floating-point arithmetic at inclusive boundaries.
  const epsilon = 1e-12;
  const conditions = [
    metrics.meanLoudness + epsilon >= settings.auto_approve_mean_loudness_min,
    metrics.density + epsilon >= settings.auto_approve_density_min,
    metrics.deltaMean + epsilon >= settings.auto_approve_delta_mean_min,
    metrics.deltaSigma <= settings.auto_approve_delta_sigma_max + epsilon,
  ];
  return settings.auto_approve_require_all === 0 ? conditions.some(Boolean) : conditions.every(Boolean);
}
