import test from "node:test";
import assert from "node:assert/strict";

import {
  parseWaveformMigrationArgs,
  waveformPixelsPerSecond,
} from "../rebuild-samples-index.mjs";

test("waveform migration defaults to a read-only complete dry run", () => {
  assert.deepEqual(parseWaveformMigrationArgs([]), {
    apply: false,
    force: false,
    help: false,
    limit: Infinity,
  });
});

test("waveform migration parses guarded apply options", () => {
  assert.deepEqual(parseWaveformMigrationArgs(["--apply", "--force", "--limit", "25"]), {
    apply: true,
    force: true,
    help: false,
    limit: 25,
  });
  assert.throws(
    () => parseWaveformMigrationArgs(["--limit", "0"]),
    /positive integer/,
  );
  assert.throws(
    () => parseWaveformMigrationArgs(["--unknown"]),
    /unknown option/,
  );
});

test("waveform migration reads direct and audiowaveform-derived resolution", () => {
  assert.equal(waveformPixelsPerSecond({ pixels_per_second: 100 }), 100);
  assert.equal(waveformPixelsPerSecond({ sample_rate: 16000, samples_per_pixel: 160 }), 100);
  assert.equal(waveformPixelsPerSecond({ sampleRate: 48000, samplesPerPixel: 960 }), 50);
  assert.equal(waveformPixelsPerSecond({ sample_rate: 16000 }), null);
  assert.equal(waveformPixelsPerSecond(null), null);
});
