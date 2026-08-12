import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableSourceWavPath,
  archiveSourceKeyCandidatesForEntry,
  archiveSourceKeyForEntry,
  buildDiarySampleMove,
  sourceWavKeyCandidatesForEntry,
} from "../lib/diary-samples.mjs";
import { parseShortFilename } from "../lib/filenames.mjs";
import { SAMPLE_LABELS, SAMPLE_LABEL_COLORS } from "../lib/sample-labels.mjs";

const cfg = {
  audioPrefix: "audio/",
  archivePrefix: "uncompressed-uploads-archive/",
  samplesPrefix: "training-samples/",
};

const entry = {
  audioPath: "audio/2026/06/2026-06-07 21-54-03 barking.mp3",
  datetimeLocal: "2026-06-07T21:54:03",
};

test("buildDiarySampleMove maps an archived WAV to the selected sample label", () => {
  assert.deepEqual(buildDiarySampleMove(entry, "background", cfg), {
    label: "background",
    filename: "2026-06-07 21-54-03 SAMPLE background.wav",
    sourceKey: "uncompressed-uploads-archive/2026/06/2026-06-07 21-54-03 barking.wav",
    destinationKey: "training-samples/background/2026-06-07 21-54-03 SAMPLE background.wav",
  });
});

test("buildDiarySampleMove normalizes label case and whitespace", () => {
  assert.equal(buildDiarySampleMove(entry, "  Homestead ", cfg).label, "homestead");
});

test("the sample label catalog has unique labels and a color for each", () => {
  assert.equal(new Set(SAMPLE_LABELS).size, SAMPLE_LABELS.length);
  assert.deepEqual(Object.keys(SAMPLE_LABEL_COLORS), SAMPLE_LABELS);
  assert.ok(Object.values(SAMPLE_LABEL_COLORS).every((color) => /^#[0-9a-f]{6}$/i.test(color)));
});

test("buildDiarySampleMove rejects unknown labels before deriving storage keys", () => {
  assert.throws(
    () => buildDiarySampleMove(entry, "other", cfg),
    /label must be one of/,
  );
});

test("buildDiarySampleMove rejects diary audio outside the managed prefix", () => {
  assert.throws(
    () => buildDiarySampleMove({ ...entry, audioPath: "other/file.mp3" }, "wind", cfg),
    /below audio\//,
  );
});

test("short recorder names map to a deterministic normalized archive key", () => {
  const parsed = parseShortFilename("7 Jun at 21-54 barking.wav");
  const normalizedEntry = {
    audioPath: `audio/${parsed.date.slice(0, 4)}/06/${parsed.normalisedFilename.replace(/\.wav$/, ".mp3")}`,
  };
  assert.equal(
    archiveSourceKeyForEntry(normalizedEntry, cfg),
    `uncompressed-uploads-archive/${parsed.date.slice(0, 4)}/06/${parsed.normalisedFilename}`,
  );
  assert.deepEqual(
    archiveSourceKeyCandidatesForEntry({
      ...normalizedEntry,
      datetimeLocal: parsed.datetimeLocal,
      label: parsed.label,
    }, cfg),
    [
      `uncompressed-uploads-archive/${parsed.date.slice(0, 4)}/06/${parsed.normalisedFilename}`,
      `uncompressed-uploads-archive/${parsed.date.slice(0, 4)}/06/${parsed.normalisedFilename.replace(/\.wav$/, ".WAV")}`,
      `uncompressed-uploads-archive/${parsed.date.slice(0, 4)}/06/7 Jun at 21-54 barking.wav`,
      `uncompressed-uploads-archive/${parsed.date.slice(0, 4)}/06/7 Jun at 21-54 barking.WAV`,
    ],
  );
});

test("source discovery supports explicit archives and linked training WAVs", () => {
  const linked = {
    ...entry,
    sourceWavPath: "uncompressed-uploads-archive/2026/06/original.wav",
    sampleAudioPath: "training-samples/bark/sample.wav",
  };
  const candidates = sourceWavKeyCandidatesForEntry(linked, cfg);
  assert.deepEqual(candidates.slice(0, 2), [
    linked.sourceWavPath,
    linked.sampleAudioPath,
  ]);
  assert.equal(
    availableSourceWavPath(linked, cfg, new Set([linked.sampleAudioPath])),
    linked.sampleAudioPath,
  );
  assert.equal(availableSourceWavPath(linked, cfg, new Set()), null);
});

test("an explicit or linked source survives a malformed legacy audio path", () => {
  const linked = {
    ...entry,
    audioPath: "outside-managed-audio/source.mp3",
    sampleAudioPath: "training-samples/bark/sample.wav",
  };
  assert.deepEqual(sourceWavKeyCandidatesForEntry(linked, cfg), [linked.sampleAudioPath]);
});
