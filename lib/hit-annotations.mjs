import { REVIEW_FRAGMENT_LABEL } from "./sample-labels.mjs";

/** Convert detector hit end-anchors into non-trainable fragments for review. */
export function hitMetadataReviewFragments(hitMetadata) {
  if (!hitMetadata || !Array.isArray(hitMetadata.timestamps)) return [];
  const paddingS = Number.isFinite(hitMetadata.paddingS) ? hitMetadata.paddingS : 0;
  return hitMetadata.timestamps.map((timestamp) => ({
    startSec: Math.max(0, parseFloat((timestamp - paddingS).toFixed(3))),
    endSec: parseFloat(timestamp.toFixed(3)),
    label: REVIEW_FRAGMENT_LABEL,
    source: "model",
  }));
}
