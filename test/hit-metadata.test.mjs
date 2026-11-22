import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import {
  getDiaryEntry,
  getHitMetadata,
  listHitMetadataPage,
  openDb,
  openReadonlyDb,
  saveReanalysisResult,
  setDiaryApproved,
  upsertDiaryEntry,
  upsertHitMetadata,
} from "../lib/db.mjs";


test("openDb migrates legacy hit_metadata rows to provenance columns", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-hit-metadata-test-"));
  const dbPath = path.join(tmpDir, "legacy.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE hit_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id TEXT NOT NULL UNIQUE,
      timestamps TEXT NOT NULL DEFAULT '[]',
      confidences TEXT NOT NULL DEFAULT '[]',
      loudnesses TEXT NOT NULL DEFAULT '[]',
      padding_s REAL NOT NULL DEFAULT 0,
      window_s REAL NOT NULL DEFAULT 1.5,
      created_at TEXT NOT NULL
    );
    INSERT INTO hit_metadata (clip_id, created_at) VALUES ('legacy-clip', '2026-01-01T00:00:00Z');
  `);
  legacy.close();

  const db = openDb(dbPath);
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(hit_metadata)").all().map(row => row.name));
    assert.ok(columns.has("multilabel_scores"));
    assert.equal(db.prepare("SELECT multilabel_scores FROM hit_metadata").get().multilabel_scores, null);
    openDb(dbPath).close();
    assert.ok(columns.has("model_trained_at"));
    assert.ok(columns.has("analysis_settings"));
    assert.ok(columns.has("analysis_trigger"));

    const migrated = getHitMetadata(db, "legacy-clip");
    assert.equal(migrated.multilabelScores, null);
    assert.equal(migrated.modelTrainedAt, null);
    assert.deepEqual(migrated.analysisSettings, {});
    assert.equal(migrated.analysisTrigger, "automatic");

    upsertHitMetadata(db, "legacy-clip", {
      timestamps: [2],
      confidences: [0.9],
      loudnesses: [1.2],
      paddingS: 0,
      windowS: 1.5,
      modelTrainedAt: "2026-08-12T13:32:07Z",
      analysisSettings: { monitor: { candidate_threshold: 0.8 } },
      analysisTrigger: "manual",
    });
    const updated = getHitMetadata(db, "legacy-clip");
    assert.equal(updated.modelTrainedAt, "2026-08-12T13:32:07Z");
    assert.equal(updated.analysisTrigger, "manual");
    assert.equal(updated.analysisSettings.monitor.candidate_threshold, 0.8);
    assert.notEqual(updated.createdAt, "2026-01-01T00:00:00Z");
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("openReadonlyDb shares live WAL reads but rejects writes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-readonly-db-test-"));
  const dbPath = path.join(tmpDir, "shared.db");
  const writer = openDb(dbPath);
  const reader = openReadonlyDb(dbPath);
  try {
    upsertHitMetadata(writer, "concurrent-clip", {
      timestamps: [1], confidences: [0.9], loudnesses: [1.1], paddingS: 0, windowS: 1.5,
    });
    assert.equal(getHitMetadata(reader, "concurrent-clip").clipId, "concurrent-clip");
    assert.throws(
      () => reader.prepare("DELETE FROM hit_metadata").run(),
      /readonly|read-only/i,
    );
  } finally {
    reader.close();
    writer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("successful re-analysis replaces metadata and trim while clearing approval atomically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-reanalysis-result-test-"));
  const db = openDb(path.join(tmpDir, "result.db"));
  const id = "2026-08-20_12-00-00_-A-";
  try {
    upsertDiaryEntry(db, {
      id,
      filename: "2026-08-20 12-00-00 -A-.mp3",
      audioPath: "audio/2026/08/2026-08-20 12-00-00 -A-.mp3",
      waveformPath: null,
      label: "-A-",
      date: "2026-08-20",
      time: "12:00",
      datetimeLocal: "2026-08-20T12:00:00",
      durationSec: 10,
      kind: "audio",
    });
    setDiaryApproved(db, id, true);
    assert.equal(typeof getDiaryEntry(db, id).approved, "string");

    const saved = saveReanalysisResult(db, id, {
      timestamps: [2, 7],
      multilabelScores: [{ bark: .8, wildlife: .7 }, { yap: .9, wrongdog: .2 }],
      confidences: [0.93, 0.98],
      loudnesses: [1.4, 2.1],
      paddingS: 0,
      windowS: 1.5,
      modelTrainedAt: "2026-08-19T10:00:00Z",
      analysisSettings: { monitor: { candidate_threshold: 0.9 } },
      analysisTrigger: "manual",
    }, { trimStartMs: 500, trimStopMs: 8500 });

    assert.equal(saved.approved, null);
    assert.deepEqual(saved.timestamps, [2, 7]);
    assert.deepEqual(saved.multilabelScores, [{ bark: .8, wildlife: .7 }, { yap: .9, wrongdog: .2 }]);
    assert.equal(saved.trimStartMs, 500);
    assert.equal(saved.trimStopMs, 8500);
    assert.equal(getDiaryEntry(db, id).approved, null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test("hit diagnostics round trip through single and paginated reads and clear on legacy replacement", () => {
  const db = openDb(":memory:");
  try {
    const vectors = [{ bark: .98, yap: .12, wildlife: .9 }, { bark: .4, wind: .7 }];
    const base = { timestamps: [1.5, 5.5], confidences: [.99, .96], loudnesses: [1.2, 1.4] };
    upsertHitMetadata(db, "richer-clip", { ...base, multilabelScores: vectors });
    assert.deepEqual(getHitMetadata(db, "richer-clip").multilabelScores, vectors);
    assert.deepEqual(listHitMetadataPage(db).items[0].multilabelScores, vectors);
    assert.equal(db.prepare("SELECT multilabel_scores FROM hit_metadata").get().multilabel_scores, JSON.stringify(vectors));
    upsertHitMetadata(db, "richer-clip", { timestamps: [3], confidences: [.8], loudnesses: [1] });
    assert.equal(getHitMetadata(db, "richer-clip").multilabelScores, null);
    assert.equal(db.prepare("SELECT multilabel_scores FROM hit_metadata").get().multilabel_scores, null);
    upsertHitMetadata(db, "richer-clip", { timestamps: [], confidences: [], loudnesses: [], multilabelScores: [] });
    assert.deepEqual(getHitMetadata(db, "richer-clip").multilabelScores, []);
  } finally {
    db.close();
  }
});

test("invalid diagnostics cannot overwrite existing hit metadata", () => {
  const db = openDb(":memory:");
  try {
    const original = { timestamps: [1], confidences: [.9], loudnesses: [1], multilabelScores: [{ bark: .8 }] };
    upsertHitMetadata(db, "safe-clip", original);
    for (const multilabelScores of [[], [null], [{ bark: NaN }], [{ bark: Infinity }], [{ bark: -1 }], [{ bark: 1.01 }], [{ bark: "0.9" }], [{ b: .9 }], [{}]]) {
      assert.throws(() => upsertHitMetadata(db, "safe-clip", { ...original, multilabelScores }), /multilabel_scores/);
      assert.deepEqual(getHitMetadata(db, "safe-clip").multilabelScores, original.multilabelScores);
    }
  } finally {
    db.close();
  }
});
