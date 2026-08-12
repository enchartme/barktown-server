import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { getDiaryEntry, openDb, upsertDiaryEntry } from "../lib/db.mjs";


test("openDb migrates source WAV identity and diary upserts retain it", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-source-wav-test-"));
  const dbPath = path.join(tmpDir, "legacy.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE diary_entries (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      audio_path TEXT NOT NULL,
      waveform_path TEXT,
      label TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      datetime_local TEXT NOT NULL,
      duration_sec REAL NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'audio',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const db = openDb(dbPath);
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(diary_entries)").all().map(row => row.name));
    assert.ok(columns.has("source_wav_path"));
    assert.ok(columns.has("source_wav_etag"));

    const entry = {
      id: "clip-a",
      filename: "2026-08-12 12-00-00 bark.mp3",
      audioPath: "audio/2026/08/2026-08-12 12-00-00 bark.mp3",
      waveformPath: null,
      label: "bark",
      date: "2026-08-12",
      time: "12:00",
      datetimeLocal: "2026-08-12T12:00:00",
      durationSec: 3,
      kind: "audio",
      sourceWavPath: "uncompressed-uploads-archive/2026/08/2026-08-12 12-00-00 bark.wav",
      sourceWavEtag: "source-etag",
    };
    upsertDiaryEntry(db, entry);
    upsertDiaryEntry(db, { ...entry, sourceWavPath: null, sourceWavEtag: null });

    const stored = getDiaryEntry(db, entry.id);
    assert.equal(stored.sourceWavPath, entry.sourceWavPath);
    assert.equal(stored.sourceWavEtag, entry.sourceWavEtag);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
