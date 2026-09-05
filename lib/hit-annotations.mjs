import { REVIEW_FRAGMENT_LABEL } from "./sample-labels.mjs";

const roundSeconds = (value) => parseFloat(value.toFixed(3));

/** Convert detector hit end-anchors into non-trainable fragments for review. */
export function hitMetadataReviewFragments(hitMetadata) {
  if (!hitMetadata || !Array.isArray(hitMetadata.timestamps)) return [];
  const paddingS = Number.isFinite(hitMetadata.paddingS) ? hitMetadata.paddingS : 0;
  return hitMetadata.timestamps.map((timestamp) => ({
    startSec: Math.max(0, roundSeconds(timestamp - paddingS)),
    endSec: roundSeconds(timestamp),
    label: REVIEW_FRAGMENT_LABEL,
    source: "model",
  }));
}

/** Convert offline analyzer hit end-anchors into exact bark-window fragments. */
export function hitMetadataBarkFragments(hitMetadata, durationSec) {
  if (!hitMetadata || !Array.isArray(hitMetadata.timestamps)) {
    throw new TypeError("hit metadata timestamps must be an array");
  }
  const windowS = hitMetadata.windowS ?? hitMetadata.window_s;
  if (!Number.isFinite(windowS) || windowS <= 0) {
    throw new RangeError("hit metadata window must be a positive finite number");
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError("audio duration must be a positive finite number");
  }

  return hitMetadata.timestamps.flatMap((timestamp) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new RangeError("hit timestamps must be positive finite numbers");
    }
    const startSec = Math.max(0, timestamp - windowS);
    const endSec = Math.min(timestamp, durationSec);
    if (endSec <= startSec) {
      throw new RangeError("hit window does not intersect the audio duration");
    }
    const roundedStartSec = roundSeconds(startSec);
    const roundedEndSec = roundSeconds(endSec);
    if (roundedEndSec <= roundedStartSec) {
      throw new RangeError("hit window is empty at annotation precision");
    }
    return [{
      startSec: roundedStartSec,
      endSec: roundedEndSec,
      label: "bark",
      source: "model",
    }];
  });
}
