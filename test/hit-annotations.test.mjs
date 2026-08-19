import { test } from "node:test";
import assert from "node:assert/strict";

import { hitMetadataReviewFragments } from "../lib/hit-annotations.mjs";

test("copied hit metadata becomes review fragments", () => {
  assert.deepEqual(hitMetadataReviewFragments({ timestamps: [1, 2.3456], paddingS: 1.5 }), [
    { startSec: 0, endSec: 1, label: "review", source: "model" },
    { startSec: 0.846, endSec: 2.346, label: "review", source: "model" },
  ]);
});
