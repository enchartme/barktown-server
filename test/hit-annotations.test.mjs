import { test } from "node:test";
import assert from "node:assert/strict";

import { hitMetadataBarkFragments, hitMetadataReviewFragments } from "../lib/hit-annotations.mjs";

test("copied hit metadata becomes review fragments", () => {
  assert.deepEqual(hitMetadataReviewFragments({ timestamps: [1, 2.3456], paddingS: 1.5 }), [
    { startSec: 0, endSec: 1, label: "review", source: "model" },
    { startSec: 0.846, endSec: 2.346, label: "review", source: "model" },
  ]);
});

test("offline hits become exact model-generated bark windows", () => {
  assert.deepEqual(hitMetadataBarkFragments({
    timestamps: [1.5, 3, 4.5],
    window_s: 1.5,
  }, 4), [
    { startSec: 0, endSec: 1.5, label: "bark", source: "model" },
    { startSec: 1.5, endSec: 3, label: "bark", source: "model" },
    { startSec: 3, endSec: 4, label: "bark", source: "model" },
  ]);
});

test("zero hits remain a valid analyzer result", () => {
  assert.deepEqual(hitMetadataBarkFragments({ timestamps: [], window_s: 1.5 }, 4), []);
});

test("invalid analyzer metadata cannot masquerade as zero hits", () => {
  assert.throws(
    () => hitMetadataBarkFragments({ timestamps: [1] }, 4),
    /window must be a positive finite number/,
  );
  assert.throws(
    () => hitMetadataBarkFragments({ timestamps: [1], window_s: 0 }, 4),
    /window must be a positive finite number/,
  );
  assert.throws(
    () => hitMetadataBarkFragments({ timestamps: [1], window_s: 1.5 }, 0),
    /audio duration must be a positive finite number/,
  );
  assert.throws(
    () => hitMetadataBarkFragments({ timestamps: [0, Number.NaN], window_s: 1.5 }, 4),
    /hit timestamps must be positive finite numbers/,
  );
  assert.throws(
    () => hitMetadataBarkFragments({ timestamps: [6], window_s: 1.5 }, 4),
    /hit window does not intersect the audio duration/,
  );
  assert.throws(
    () => hitMetadataBarkFragments({ timestamps: [0.0001], window_s: 1.5 }, 4),
    /hit window is empty at annotation precision/,
  );
});
