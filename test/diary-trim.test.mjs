import test from "node:test";
import assert from "node:assert/strict";

import {
  REANALYSIS_TRIM_PADDING_MS,
  trimBoundsAroundHits,
} from "../lib/diary-trim.mjs";

test("re-analysis trim surrounds the first and last bark by 1.5 seconds", () => {
  assert.equal(REANALYSIS_TRIM_PADDING_MS, 1500);
  assert.deepEqual(trimBoundsAroundHits([8, 2, 5], 10), {
    trimStartMs: 500,
    trimStopMs: 9500,
  });
  assert.deepEqual(trimBoundsAroundHits([5], 10), {
    trimStartMs: 3500,
    trimStopMs: 6500,
  });
});

test("re-analysis trim clamps to source boundaries and canonicalizes full range", () => {
  assert.deepEqual(trimBoundsAroundHits([0.4, 9.2], 10), {
    trimStartMs: null,
    trimStopMs: null,
  });
  assert.deepEqual(trimBoundsAroundHits([0.4, 5], 10), {
    trimStartMs: 0,
    trimStopMs: 6500,
  });
});

test("re-analysis with no newly identified barks keeps the full recording", () => {
  assert.deepEqual(trimBoundsAroundHits([], 10), {
    trimStartMs: null,
    trimStopMs: null,
  });
});
