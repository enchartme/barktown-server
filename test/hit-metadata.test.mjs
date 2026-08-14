import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { getHitMetadata, openDb, openReadonlyDb, upsertHitMetadata } from "../lib/db.mjs";


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
    assert.ok(columns.has("model_trained_at"));
    assert.ok(columns.has("analysis_settings"));
    assert.ok(columns.has("analysis_trigger"));

    const migrated = getHitMetadata(db, "legacy-clip");
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
