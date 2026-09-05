import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { insertAnnotation, listAnnotations, openDb, upsertSample } from "../lib/db.mjs";

test("openDb repairs zero-duration review fragments created by diary moves", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-annotation-migration-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  let db;

  try {
    db = openDb(dbPath);
    upsertSample(db, {
      id: "moved-diary-sample",
      filename: "2026-09-06 10-00-00 SAMPLE background.wav",
      audioPath: "training-samples/background/2026-09-06 10-00-00 SAMPLE background.wav",
      waveformPath: null,
      label: "background",
      date: "2026-09-06",
      datetimeLocal: "2026-09-06T10:00:00",
      durationSec: 10,
    });
    insertAnnotation(db, "moved-diary-sample", {
      startSec: 4,
      endSec: 4,
      label: "review",
      source: "model",
    });
    insertAnnotation(db, "moved-diary-sample", {
      startSec: 5,
      endSec: 5,
      label: "a note",
      source: "note",
    });
    db.close();

    db = openDb(dbPath);
    const annotations = listAnnotations(db, "moved-diary-sample");
    assert.deepEqual(
      annotations.map(({ startSec, endSec, label, source }) => ({ startSec, endSec, label, source })),
      [
        { startSec: 2.5, endSec: 4, label: "review", source: "model" },
        { startSec: 5, endSec: 5, label: "a note", source: "note" },
      ],
    );

    db.close();
    db = null;
    db = openDb(dbPath);
    assert.equal(listAnnotations(db, "moved-diary-sample")[0].startSec, 2.5);
  } finally {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
