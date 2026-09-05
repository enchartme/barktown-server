import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  insertAnnotation,
  insertSampleIfAbsent,
  listAnnotations,
  openDb,
  replaceSampleAnalysisFragments,
} from "../lib/db.mjs";

test("sample re-analysis replaces bark/review/yap fragments and preserves everything else", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-sample-reanalysis-test-"));
  const db = openDb(path.join(tmpDir, "sample.db"));
  const sample = {
    id: "2026-08-20_12-00-00_SAMPLE_bark",
    filename: "2026-08-20 12-00-00 SAMPLE bark.wav",
    audioPath: "training-samples/bark/2026-08-20 12-00-00 SAMPLE bark.wav",
    waveformPath: null,
    label: "bark",
    date: "2026-08-20",
    datetimeLocal: "2026-08-20T12:00:00",
    durationSec: 10,
  };

  try {
    insertSampleIfAbsent(db, sample);
    insertAnnotation(db, sample.id, { startSec: 0, endSec: 1, label: "bark", source: "manual" });
    insertAnnotation(db, sample.id, { startSec: 1, endSec: 2, label: "review", source: "model" });
    insertAnnotation(db, sample.id, { startSec: 2, endSec: 3, label: "yap", source: "manual" });
    insertAnnotation(db, sample.id, { startSec: 3, endSec: 4, label: "wind", source: "manual" });
    insertAnnotation(db, sample.id, { startSec: 0, endSec: 0, label: "bark", source: "note" });

    const annotations = replaceSampleAnalysisFragments(db, sample.id, [
      { startSec: 4, endSec: 5.5, label: "bark", source: "model" },
      { startSec: 7, endSec: 8.5, label: "bark", source: "model" },
    ]);

    assert.deepEqual(
      annotations.map(({ startSec, endSec, label, source }) => ({ startSec, endSec, label, source })),
      [
        { startSec: 0, endSec: 0, label: "bark", source: "note" },
        { startSec: 3, endSec: 4, label: "wind", source: "manual" },
        { startSec: 4, endSec: 5.5, label: "bark", source: "model" },
        { startSec: 7, endSec: 8.5, label: "bark", source: "model" },
      ],
    );
    assert.deepEqual(listAnnotations(db, sample.id), annotations);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a zero-hit sample result removes bark/review/yap fragments without touching other labels", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-sample-reanalysis-empty-test-"));
  const db = openDb(path.join(tmpDir, "sample.db"));
  const sample = {
    id: "sample-empty",
    filename: "2026-08-20 12-00-00 SAMPLE background.wav",
    audioPath: "training-samples/background/sample.wav",
    waveformPath: null,
    label: "background",
    date: "2026-08-20",
    datetimeLocal: "2026-08-20T12:00:00",
    durationSec: 5,
  };

  try {
    insertSampleIfAbsent(db, sample);
    insertAnnotation(db, sample.id, { startSec: 1, endSec: 2, label: "bark" });
    insertAnnotation(db, sample.id, { startSec: 2, endSec: 3, label: "traffic" });
    insertAnnotation(db, sample.id, { startSec: 2, endSec: 2.5, label: "review" });
    insertAnnotation(db, sample.id, { startSec: 2.5, endSec: 3, label: "yap" });
    assert.deepEqual(
      replaceSampleAnalysisFragments(db, sample.id, []).map(({ label }) => label),
      ["traffic"],
    );
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
