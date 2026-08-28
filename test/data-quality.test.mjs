import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  deleteDataQualityRow,
  getDataQuality,
  moveDataQualityRecord,
  openDb,
  upsertDataQuality,
} from "../lib/db.mjs";

const quality = {
  recordingStartedAt: "2026-08-28T10:00:00.000Z",
  recordingEndedAt: "2026-08-28T10:00:02.000Z",
  durationS: 2,
  xrunCount: 1,
  inputOverflowCount: 1,
  inputUnderflowCount: 0,
  outputOverflowCount: 0,
  outputUnderflowCount: 0,
  otherXrunCount: 0,
  errors: [{ type: "xrun", offset_ms: 500, reasons: ["input_overflow"], detail: "input overflow" }],
  errorsTruncated: 0,
};

test("data quality upserts by record id and follows a recording identity move", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-quality-test-"));
  const db = openDb(path.join(tmpDir, "quality.db"));
  try {
    upsertDataQuality(db, "diary-record", quality);
    assert.deepEqual(getDataQuality(db, "diary-record").errors, quality.errors);

    moveDataQualityRecord(db, "diary-record", "sample-record");
    assert.equal(getDataQuality(db, "diary-record"), null);
    assert.equal(getDataQuality(db, "sample-record").xrunCount, 1);

    deleteDataQualityRow(db, "sample-record");
    assert.equal(getDataQuality(db, "sample-record"), null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
