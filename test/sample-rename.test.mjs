import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getSample,
  insertAnnotation,
  listAnnotations,
  listDiaryEntries,
  openDb,
  renameSampleTransaction,
  upsertDiaryEntry,
  upsertSample,
} from "../lib/db.mjs";

test("renaming a sample preserves its diary link and annotations", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-sample-rename-"));
  const db = openDb(path.join(tmpDir, "test.db"));
  const oldId = "2026-10-28_12-00-00_SAMPLE_bark";
  const newId = "2026-10-28_12-00-00_SAMPLE_wrongdog";
  const diaryId = "2026-10-28_12-00-00_auto";

  try {
    upsertDiaryEntry(db, {
      id: diaryId,
      filename: "2026-10-28 12-00-00 auto.mp3",
      audioPath: "audio/2026/10/2026-10-28 12-00-00 auto.mp3",
      waveformPath: null,
      label: "-A- auto",
      date: "2026-10-28",
      time: "12:00",
      datetimeLocal: "2026-10-28T12:00:00",
      durationSec: 1.5,
      kind: "audio",
    });
    upsertSample(db, {
      id: oldId,
      filename: "2026-10-28 12-00-00 SAMPLE bark.wav",
      audioPath: "training-samples/bark/2026-10-28 12-00-00 SAMPLE bark.wav",
      waveformPath: "training-waveforms/bark/2026-10-28_12-00-00_SAMPLE_bark.json",
      label: "bark",
      date: "2026-10-28",
      datetimeLocal: "2026-10-28T12:00:00",
      durationSec: 1.5,
      diaryId,
    });
    insertAnnotation(db, oldId, {
      startSec: 0,
      endSec: 1.5,
      label: "bark",
      source: "manual",
    });

    renameSampleTransaction(db, oldId, {
      id: newId,
      filename: "2026-10-28 12-00-00 SAMPLE wrongdog.wav",
      audioPath: "training-samples/wrongdog/2026-10-28 12-00-00 SAMPLE wrongdog.wav",
      waveformPath: "training-waveforms/wrongdog/2026-10-28_12-00-00_SAMPLE_wrongdog.json",
      label: "wrongdog",
      date: "2026-10-28",
      datetimeLocal: "2026-10-28T12:00:00",
      durationSec: 1.5,
    });

    assert.equal(getSample(db, oldId), undefined);
    assert.equal(getSample(db, newId).diaryId, diaryId);
    assert.equal(listDiaryEntries(db)[0].sampleId, newId);
    assert.deepEqual(
      listAnnotations(db, newId).map(({ sampleId, label, startSec, endSec }) => ({
        sampleId,
        label,
        startSec,
        endSec,
      })),
      [{ sampleId: newId, label: "bark", startSec: 0, endSec: 1.5 }],
    );
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
