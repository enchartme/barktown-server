import { SAMPLE_LABELS } from "./sample-labels.mjs";

const LABELS = new Set(SAMPLE_LABELS);

/** Optional diagnostic vectors, indexed exactly like the binary hit arrays. */
export function validateMultilabelScores(scores, hitCount) {
  if (scores === undefined || scores === null) return null;
  if (!Array.isArray(scores)) return "multilabel_scores must be null or an array";
  if (scores.length !== hitCount) return "multilabel_scores must have the same length as timestamps";
  for (const vector of scores) {
    if (vector === null || typeof vector !== "object" || Array.isArray(vector)) {
      return "multilabel_scores entries must be JSON objects";
    }
    const entries = Object.entries(vector);
    if (!entries.length) return "multilabel_scores entries must contain at least one label score";
    if (!entries.every(([label]) => LABELS.has(label))) {
      return "multilabel_scores must use canonical sample label names";
    }
    if (!entries.every(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
      return "multilabel_scores values must be finite numbers in [0, 1]";
    }
  }
  return null;
}
