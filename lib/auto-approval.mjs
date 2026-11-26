import { SAMPLE_LABELS } from './sample-labels.mjs';

export const AUTO_APPROVAL_RULE_VERSION = 1;
export const AUTO_APPROVAL_SETTINGS = [
  { key: 'auto_approve_mean_loudness_min', value: 4, min: 1, max: 10, description: 'Minimum mean loudness ratio for automatic approval (inclusive).' },
  { key: 'auto_approve_density_min', value: 50, min: 0, max: 100, description: 'Minimum unfiltered window density percentage for automatic approval (inclusive).' },
  { key: 'auto_approve_delta_mean_min', value: .9, min: .5, max: 1, description: 'Minimum mean window delta for automatic approval (inclusive).' },
  { key: 'auto_approve_delta_sigma_max', value: .1, min: 0, max: 1, description: 'Maximum population standard deviation of window delta for automatic approval (inclusive).' },
];
const positiveLabels = ['bark', 'yap'];
const negativeLabels = SAMPLE_LABELS.filter(label => !positiveLabels.includes(label));

/** All detected hits within the saved trim, without presentation filters. */
export function autoApprovalMetrics(entry, metadata) {
  const durationMs = Math.round(entry.durationSec * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(metadata?.windowS) || metadata.windowS <= 0) return null;
  const validTrim = Number.isInteger(entry.trimStartMs) && Number.isInteger(entry.trimStopMs)
    && entry.trimStartMs >= 0 && entry.trimStopMs > entry.trimStartMs && entry.trimStopMs <= durationMs;
  const startSec = validTrim ? entry.trimStartMs / 1000 : 0;
  const stopSec = validTrim ? entry.trimStopMs / 1000 : durationMs / 1000;
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
  return metrics.meanLoudness + epsilon >= settings.auto_approve_mean_loudness_min
    && metrics.density + epsilon >= settings.auto_approve_density_min
    && metrics.deltaMean + epsilon >= settings.auto_approve_delta_mean_min
    && metrics.deltaSigma <= settings.auto_approve_delta_sigma_max + epsilon;
}
