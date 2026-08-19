import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getSample,
  insertAnnotation,
  insertSampleIfAbsent,
  listAnnotations,
  openDb,
} from "../lib/db.mjs";

test("only the first request creates a deterministic sample id", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-sample-idempotency-"));
  const db = openDb(path.join(tmpDir, "test.db"));
  const sample = {
    id: "2026-08-19_12-00-00_SAMPLE_bark",
    filename: "2026-08-19 12-00-00 SAMPLE bark.wav",
    audioPath: "training-samples/bark/2026-08-19 12-00-00 SAMPLE bark.wav",
    label: "bark",
    date: "2026-08-19",
    datetimeLocal: "2026-08-19T12:00:00",
    durationSec: 8,
    diaryId: "2026-08-19_12-00-00_auto",
  };

  try {
    for (let request = 0; request < 2; request++) {
      if (insertSampleIfAbsent(db, sample)) {
        insertAnnotation(db, sample.id, {
          startSec: 0,
          endSec: 1,
          label: "review",
          source: "model",
        });
      }
    }
    assert.equal(getSample(db, sample.id).diaryId, sample.diaryId);
    assert.equal(listAnnotations(db, sample.id).length, 1);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
