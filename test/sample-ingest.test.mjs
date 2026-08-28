import { test } from "node:test";
import assert from "node:assert/strict";

import { planSampleIngest } from "../lib/sample-ingest.mjs";
import { isSampleFilenameCandidate } from "../lib/filenames.mjs";

const cfg = {
  samplesPrefix: "training-samples/",
  samplesWavePrefix: "training-samples-waveforms/",
};

test("SAMPLE marker routes an inbox WAV to the label-specific sample folders", () => {
  const plan = planSampleIngest("2026-08-27 12-34-56 SAMPLE bark.wav", cfg);

  assert.equal(plan.parsed.label, "bark");
  assert.equal(
    plan.audioPath,
    "training-samples/bark/2026-08-27 12-34-56 SAMPLE bark.wav",
  );
  assert.equal(
    plan.waveformPath,
    "training-samples-waveforms/bark/2026-08-27_12-34-56_SAMPLE_bark.json",
  );
});

test("unknown SAMPLE labels remain in the inbox", () => {
  const plan = planSampleIngest("2026-08-27 12-34-56 SAMPLE mystery.wav", cfg);
  assert.match(plan.error, /unknown sample label: mystery/);
});

test("malformed files with the reserved SAMPLE marker cannot fall through to diary ingest", () => {
  const filename = "2026-08-27 12-34-56 SAMPLE bark extra.wav";
  assert.equal(isSampleFilenameCandidate(filename), true);
  assert.equal(planSampleIngest(filename, cfg), null);
});
