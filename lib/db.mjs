// lib/db.mjs — SQLite-backed metadata store for training samples and the
// diary recordings corpus.
//
// training samples: source of truth is this DB; training-samples-index.json
//   in MinIO is produced from it (exportSamplesIndexJson) for backwards
//   compatibility with GoblinPiStatus.svelte.
//
// diary entries: source of truth is this DB; index.json in MinIO is kept in
//   sync after each ingest purely as a read-only fallback. The barktown web
//   client reads diary entries via GET /api/diary.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS samples (
    id             TEXT PRIMARY KEY,
    filename       TEXT NOT NULL,
    audio_path     TEXT NOT NULL,
    waveform_path  TEXT,
    label          TEXT NOT NULL,
    date           TEXT NOT NULL,
    datetime_local TEXT NOT NULL,
    duration_sec   REAL NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_samples_label  ON samples(label);
  CREATE INDEX IF NOT EXISTS idx_samples_status ON samples(status);

  CREATE TABLE IF NOT EXISTS annotations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id   TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
    start_sec   REAL NOT NULL,
    end_sec     REAL NOT NULL,
    label       TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_annotations_sample ON annotations(sample_id);

  CREATE TABLE IF NOT EXISTS diary_entries (
    id             TEXT PRIMARY KEY,
    filename       TEXT NOT NULL,
    audio_path     TEXT NOT NULL,
    waveform_path  TEXT,
    label          TEXT NOT NULL DEFAULT '',
    date           TEXT NOT NULL,
    time           TEXT NOT NULL,
    datetime_local TEXT NOT NULL,
    duration_sec   REAL NOT NULL DEFAULT 0,
    kind           TEXT NOT NULL DEFAULT 'audio',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(date);

  -- Per-clip hit metadata sent by barktown-goblin after a successful upload.
  -- clip_id mirrors the diary_entries id derived by the ingest service from
  -- the upload filename (same slugify logic).  No FK constraint: goblin sends
  -- this before the ingest service has processed the file, so the diary row
  -- may not exist yet.  Cascade delete is handled explicitly in the API.
  CREATE TABLE IF NOT EXISTS hit_metadata (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id      TEXT NOT NULL UNIQUE,
    timestamps   TEXT NOT NULL DEFAULT '[]',
    confidences  TEXT NOT NULL DEFAULT '[]',
    loudnesses   TEXT NOT NULL DEFAULT '[]',
    padding_s    REAL NOT NULL DEFAULT 0,
    window_s     REAL NOT NULL DEFAULT 1.5,
    created_at   TEXT NOT NULL
  );
`;

/** Open (creating if necessary) the SQLite database at dbPath. */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // Idempotent migration: add window_s to existing hit_metadata tables.
  try { db.exec("ALTER TABLE hit_metadata ADD COLUMN window_s REAL NOT NULL DEFAULT 1.5"); } catch {}
  // Idempotent migration: add diary_id cross-link to samples.
  try { db.exec("ALTER TABLE samples ADD COLUMN diary_id TEXT"); } catch {}
  return db;
}

/**
 * Insert or update a training sample row. `entry` uses the same field
 * names as the legacy training-samples-index.json entries (id, filename,
 * audioPath, waveformPath, label, date, datetimeLocal, durationSec).
 * Re-activates a soft-deleted row if it's re-uploaded under the same id.
 */
export function upsertSample(db, entry) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT created_at FROM samples WHERE id = ?").get(entry.id);

  db.prepare(`
    INSERT INTO samples
      (id, filename, audio_path, waveform_path, label, date, datetime_local, duration_sec, status, diary_id, created_at, updated_at)
    VALUES
      (@id, @filename, @audioPath, @waveformPath, @label, @date, @datetimeLocal, @durationSec, 'active', @diaryId, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      filename       = excluded.filename,
      audio_path     = excluded.audio_path,
      waveform_path  = excluded.waveform_path,
      label          = excluded.label,
      date           = excluded.date,
      datetime_local = excluded.datetime_local,
      duration_sec   = excluded.duration_sec,
      status         = 'active',
      diary_id       = COALESCE(excluded.diary_id, samples.diary_id),
      updated_at     = excluded.updated_at
  `).run({
    id: entry.id,
    filename: entry.filename,
    audioPath: entry.audioPath,
    waveformPath: entry.waveformPath ?? null,
    label: entry.label,
    date: entry.date,
    datetimeLocal: entry.datetimeLocal,
    durationSec: entry.durationSec ?? 0,
    diaryId: entry.diaryId ?? null,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
  });
}

/** Fetch a single sample row by id (any status), or undefined. */
export function getSample(db, id) {
  return db.prepare(`
    SELECT id, filename, audio_path AS audioPath, waveform_path AS waveformPath,
           label, date, datetime_local AS datetimeLocal, duration_sec AS durationSec,
           status, diary_id AS diaryId, created_at AS createdAt, updated_at AS updatedAt
    FROM samples WHERE id = ?
  `).get(id);
}

/** List all active samples, oldest first (matches legacy index.json order). */
export function listActiveSamples(db) {
  return db.prepare(`
    SELECT id, filename, audio_path AS audioPath, waveform_path AS waveformPath,
           label, date, datetime_local AS datetimeLocal, duration_sec AS durationSec
    FROM samples
    WHERE status = 'active'
    ORDER BY datetime_local ASC
  `).all();
}

/**
 * List active samples for the API, optionally filtered by label.
 * Includes status/timestamps, unlike the legacy-index-shaped listActiveSamples().
 */
export function listSamples(db, { label } = {}) {
  if (label) {
    return db.prepare(`
      SELECT id, filename, audio_path AS audioPath, waveform_path AS waveformPath,
             label, date, datetime_local AS datetimeLocal, duration_sec AS durationSec,
             status, diary_id AS diaryId, created_at AS createdAt, updated_at AS updatedAt
      FROM samples
      WHERE status = 'active' AND label = ?
      ORDER BY datetime_local ASC
    `).all(label);
  }
  return db.prepare(`
    SELECT id, filename, audio_path AS audioPath, waveform_path AS waveformPath,
           label, date, datetime_local AS datetimeLocal, duration_sec AS durationSec,
           status, diary_id AS diaryId, created_at AS createdAt, updated_at AS updatedAt
    FROM samples
    WHERE status = 'active'
    ORDER BY datetime_local ASC
  `).all();
}

/** List annotations for a sample, ordered by start time. */
export function listAnnotations(db, sampleId) {
  return db.prepare(`
    SELECT id, sample_id AS sampleId, start_sec AS startSec, end_sec AS endSec,
           label, source, created_at AS createdAt
    FROM annotations
    WHERE sample_id = ?
    ORDER BY start_sec ASC
  `).all(sampleId);
}

/**
 * List every annotation across every (active) sample, for laptop-side training
 * export tools that need to sync the whole corpus in one request instead of
 * fetching per-sample. Includes the parent sample's audioPath/durationSec so
 * callers don't need a second round trip per sample.
 */
export function listAllAnnotations(db) {
  return db.prepare(`
    SELECT a.id, a.sample_id AS sampleId, a.start_sec AS startSec, a.end_sec AS endSec,
           a.label, a.source, a.created_at AS createdAt,
           s.audio_path AS sampleAudioPath, s.duration_sec AS sampleDurationSec
    FROM annotations a
    JOIN samples s ON s.id = a.sample_id
    WHERE s.status = 'active'
    ORDER BY a.sample_id ASC, a.start_sec ASC
  `).all();
}

/**
 * Produce the legacy training-samples-index.json array (active samples only)
 * from the current DB contents, for upload to MinIO.
 */
export function exportSamplesIndexJson(db) {
  return listActiveSamples(db);
}

// ─── Mutations ───────────────────────────────────────────────────────────────────

/** Permanently delete a sample row (annotations cascade via FK). */
export function deleteSampleRow(db, id) {
  db.prepare("DELETE FROM samples WHERE id = ?").run(id);
}

/**
 * Rename a sample to a new id/filename/label/paths, atomically: insert the
 * new row, move any annotations over to the new sample id, then remove the
 * old row. Caller is responsible for moving the underlying MinIO objects
 * (audio/waveform) before calling this.
 */
export function renameSampleTransaction(db, oldId, newSample) {
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT created_at FROM samples WHERE id = ?").get(oldId);

    db.prepare(`
      INSERT INTO samples
        (id, filename, audio_path, waveform_path, label, date, datetime_local, duration_sec, status, created_at, updated_at)
      VALUES
        (@id, @filename, @audioPath, @waveformPath, @label, @date, @datetimeLocal, @durationSec, 'active', @createdAt, @updatedAt)
    `).run({
      id: newSample.id,
      filename: newSample.filename,
      audioPath: newSample.audioPath,
      waveformPath: newSample.waveformPath ?? null,
      label: newSample.label,
      date: newSample.date,
      datetimeLocal: newSample.datetimeLocal,
      durationSec: newSample.durationSec ?? 0,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    });

    db.prepare("UPDATE annotations SET sample_id = ? WHERE sample_id = ?").run(newSample.id, oldId);
    db.prepare("DELETE FROM samples WHERE id = ?").run(oldId);
  });
  tx();
}

/** Fetch a single annotation row by id, or undefined. */
export function getAnnotation(db, id) {
  return db.prepare(`
    SELECT id, sample_id AS sampleId, start_sec AS startSec, end_sec AS endSec,
           label, source, created_at AS createdAt
    FROM annotations WHERE id = ?
  `).get(id);
}

/** Insert a new annotation for a sample. Returns the created row. */
export function insertAnnotation(db, sampleId, { startSec, endSec, label, source = "manual" }) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO annotations (sample_id, start_sec, end_sec, label, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sampleId, startSec, endSec, label, source, now);
  return getAnnotation(db, info.lastInsertRowid);
}

/** Update an existing annotation. Returns the updated row. */
export function updateAnnotation(db, id, { startSec, endSec, label }) {
  const current = getAnnotation(db, id);
  if (!current) return undefined;
  db.prepare(`
    UPDATE annotations SET start_sec = ?, end_sec = ?, label = ? WHERE id = ?
  `).run(
    startSec ?? current.startSec,
    endSec ?? current.endSec,
    label ?? current.label,
    id
  );
  return getAnnotation(db, id);
}

/** Delete an annotation by id. */
export function deleteAnnotationRow(db, id) {
  db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
}

// ─── Diary entries ───────────────────────────────────────────────────────────

/**
 * Insert or update a diary entry row. `entry` shape:
 *   { id, filename, audioPath, waveformPath, label, date, time,
 *     datetimeLocal, durationSec, kind }
 */
export function upsertDiaryEntry(db, entry) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT created_at FROM diary_entries WHERE id = ?").get(entry.id);

  db.prepare(`
    INSERT INTO diary_entries
      (id, filename, audio_path, waveform_path, label, date, time,
       datetime_local, duration_sec, kind, created_at, updated_at)
    VALUES
      (@id, @filename, @audioPath, @waveformPath, @label, @date, @time,
       @datetimeLocal, @durationSec, @kind, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      filename       = excluded.filename,
      audio_path     = excluded.audio_path,
      waveform_path  = excluded.waveform_path,
      label          = excluded.label,
      date           = excluded.date,
      time           = excluded.time,
      datetime_local = excluded.datetime_local,
      duration_sec   = excluded.duration_sec,
      kind           = excluded.kind,
      updated_at     = excluded.updated_at
  `).run({
    id: entry.id,
    filename: entry.filename,
    audioPath: entry.audioPath,
    waveformPath: entry.waveformPath ?? null,
    label: entry.label ?? '',
    date: entry.date,
    time: entry.time,
    datetimeLocal: entry.datetimeLocal,
    durationSec: entry.durationSec ?? 0,
    kind: entry.kind ?? 'audio',
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
  });
}

/** List all diary entries, oldest first. */
export function listDiaryEntries(db) {
  return db.prepare(`
    SELECT d.id, d.filename, d.audio_path AS audioPath, d.waveform_path AS waveformPath,
           d.label, d.date, d.time, d.datetime_local AS datetimeLocal,
           d.duration_sec AS durationSec, d.kind,
           s.id AS sampleId
    FROM diary_entries d
    LEFT JOIN samples s ON s.diary_id = d.id AND s.status = 'active'
    ORDER BY d.datetime_local ASC
  `).all();
}

/** Fetch a single diary entry by id, or undefined. */
export function getDiaryEntry(db, id) {
  return db.prepare(`
    SELECT d.id, d.filename, d.audio_path AS audioPath, d.waveform_path AS waveformPath,
           d.label, d.date, d.time, d.datetime_local AS datetimeLocal,
           d.duration_sec AS durationSec, d.kind,
           d.created_at AS createdAt, d.updated_at AS updatedAt,
           s.id AS sampleId
    FROM diary_entries d
    LEFT JOIN samples s ON s.diary_id = d.id AND s.status = 'active'
    WHERE d.id = ?
  `).get(id);
}

/** Permanently delete a diary entry row, clearing any sample's link to it. */
export function deleteDiaryEntryRow(db, id) {
  db.prepare("UPDATE samples SET diary_id = NULL, updated_at = ? WHERE diary_id = ?")
    .run(new Date().toISOString(), id);
  db.prepare("DELETE FROM diary_entries WHERE id = ?").run(id);
}

// ─── Hit metadata ─────────────────────────────────────────────────────────────

/**
 * Insert or replace the hit metadata row for a clip.
 * clip_id mirrors the diary_entries id (derived from the upload filename).
 * timestamps / confidences / loudnesses are parallel arrays of numbers.
 */
export function upsertHitMetadata(db, clipId, { timestamps, confidences, loudnesses, paddingS, windowS }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hit_metadata (clip_id, timestamps, confidences, loudnesses, padding_s, window_s, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(clip_id) DO UPDATE SET
      timestamps  = excluded.timestamps,
      confidences = excluded.confidences,
      loudnesses  = excluded.loudnesses,
      padding_s   = excluded.padding_s,
      window_s    = excluded.window_s
  `).run(
    clipId,
    JSON.stringify(timestamps ?? []),
    JSON.stringify(confidences ?? []),
    JSON.stringify(loudnesses ?? []),
    paddingS ?? 0,
    windowS ?? 1.5,
    now,
  );
}

/** Fetch hit metadata for a clip, parsing the JSON arrays. Returns null if not found. */
export function getHitMetadata(db, clipId) {
  const row = db.prepare(
    "SELECT clip_id AS clipId, timestamps, confidences, loudnesses, padding_s AS paddingS, window_s AS windowS, created_at AS createdAt FROM hit_metadata WHERE clip_id = ?"
  ).get(clipId);
  if (!row) return null;
  return {
    clipId: row.clipId,
    timestamps:  JSON.parse(row.timestamps),
    confidences: JSON.parse(row.confidences),
    loudnesses:  JSON.parse(row.loudnesses),
    paddingS:    row.paddingS,
    windowS:     row.windowS,
    createdAt:   row.createdAt,
  };
}

/** Delete a hit_metadata row by clip_id. No-op if not found. */
export function deleteHitMetadataRow(db, clipId) {
  db.prepare("DELETE FROM hit_metadata WHERE clip_id = ?").run(clipId);
}
