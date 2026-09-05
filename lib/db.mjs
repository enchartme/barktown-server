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
    trim_start_ms  INTEGER,
    trim_stop_ms   INTEGER,
    approved       TEXT,
    kind           TEXT NOT NULL DEFAULT 'audio',
    source_wav_path TEXT,
    source_wav_etag TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(date);

  -- Whole-recording notes for diary clips that are not linked to a training
  -- sample. Linked clips keep using annotations(start_sec=0,end_sec=0).
  CREATE TABLE IF NOT EXISTS diary_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    diary_id    TEXT NOT NULL UNIQUE REFERENCES diary_entries(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diary_notes_diary ON diary_notes(diary_id);

  -- Per-clip hit metadata sent by barktown-goblin after a successful upload.
  -- clip_id mirrors the diary_entries id derived by the ingest service from
  -- the upload filename (same slugify logic).  No FK constraint: goblin sends
  -- this before the ingest service has processed the file, so the diary row
  -- may not exist yet.  Cascade delete is handled explicitly in the API.
  CREATE TABLE IF NOT EXISTS hit_metadata (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id           TEXT NOT NULL UNIQUE,
    timestamps        TEXT NOT NULL DEFAULT '[]',
    confidences       TEXT NOT NULL DEFAULT '[]',
    loudnesses        TEXT NOT NULL DEFAULT '[]',
    padding_s         REAL NOT NULL DEFAULT 0,
    window_s          REAL NOT NULL DEFAULT 1.5,
    model_trained_at  TEXT,
    analysis_settings TEXT NOT NULL DEFAULT '{}',
    analysis_trigger  TEXT NOT NULL DEFAULT 'automatic',
    created_at        TEXT NOT NULL
  );

  -- Capture integrity for one uploaded recording. No FK: Goblin submits this
  -- immediately after uploading audio, before asynchronous diary ingest may
  -- have created the corresponding diary row.
  CREATE TABLE IF NOT EXISTS data_quality (
    record_id              TEXT PRIMARY KEY,
    recording_started_at   TEXT NOT NULL,
    recording_ended_at     TEXT NOT NULL,
    duration_s             REAL NOT NULL CHECK (duration_s >= 0),
    xrun_count             INTEGER NOT NULL DEFAULT 0 CHECK (xrun_count >= 0),
    input_overflow_count   INTEGER NOT NULL DEFAULT 0 CHECK (input_overflow_count >= 0),
    input_underflow_count  INTEGER NOT NULL DEFAULT 0 CHECK (input_underflow_count >= 0),
    output_overflow_count  INTEGER NOT NULL DEFAULT 0 CHECK (output_overflow_count >= 0),
    output_underflow_count INTEGER NOT NULL DEFAULT 0 CHECK (output_underflow_count >= 0),
    other_xrun_count       INTEGER NOT NULL DEFAULT 0 CHECK (other_xrun_count >= 0),
    errors                 TEXT NOT NULL DEFAULT '[]',
    errors_truncated       INTEGER NOT NULL DEFAULT 0 CHECK (errors_truncated >= 0),
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_data_quality_xruns ON data_quality(xrun_count);
  CREATE INDEX IF NOT EXISTS idx_data_quality_recorded
    ON data_quality(recording_started_at DESC, record_id DESC);

  -- Single source of truth for the bark-monitor's "event state machine"
  -- tuning (barktown-goblin's config.yaml monitor: section, and the
  -- equivalent knobs Goblin's offline WAV analyzer consumes).
  -- param_id is the same snake_case name used in barktown-goblin's cfg dict
  -- and the analyzer's monitor-settings JSON, so no translation is needed.
  CREATE TABLE IF NOT EXISTS monitor_params (
    param_id      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    current_value REAL NOT NULL,
    default_value REAL NOT NULL,
    min_value     REAL,
    max_value     REAL,
    description   TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL
  );
`;

// Seed rows for monitor_params, applied idempotently on every openDb() call
// (INSERT OR IGNORE — never overwrites an operator-modified current_value).
// Defaults/ranges mirror barktown-goblin/config.yaml's monitor: section.
const MONITOR_PARAM_SEEDS = [
  { paramId: "candidate_threshold",   name: "Candidate threshold",     value: 0.92, min: 0,    max: 1,     description: "bark_prob to enter ACTIVE_CANDIDATE" },
  { paramId: "confirmation_hits",     name: "Confirmation hits",       value: 4,    min: 1,    max: 50,    description: "distinct hits within confirmation_window_s to confirm" },
  { paramId: "confirmation_window_s", name: "Confirmation window (s)", value: 30.0, min: 10,   max: 600,   description: "sliding window for hit accumulation" },
  { paramId: "hit_refractory_s",      name: "Hit refractory (s)",      value: 1.5,  min: 0,    max: 3,     description: "minimum gap between counted hits" },
  { paramId: "silence_gap_s",         name: "Silence gap (s)",         value: 120,  min: 0,    max: 3600,  description: "sub-threshold gap before COOLDOWN starts" },
  { paramId: "cooldown_s",            name: "Cooldown (s)",            value: 1.5,  min: 0,    max: 10,    description: "finalisation delay after silence_gap_s fires" },
  { paramId: "inference_window_s",    name: "Inference window (s)",    value: 1.5,  min: 0.1,  max: 30,    description: "trailing audio window scored each time" },
  { paramId: "score_interval_s",      name: "Score interval (s)",      value: 0.25, min: 0.05, max: 30,    description: "how often to re-run YAMNet + classifier" },
  { paramId: "evidence_window_s",     name: "Evidence window (s)",     value: 700,  min: 1,    max: 7200,  description: "rolling audio buffer size kept in RAM" },
  { paramId: "max_clip_s",            name: "Max clip (s)",            value: 570,  min: 1,    max: 3600,  description: "max duration of a single upload clip" },
  { paramId: "padding_s",             name: "Padding (s)",             value: 1.5,  min: 0,    max: 30,    description: "audio margin added before/after the event clip" },
  { paramId: "upload_min_score",      name: "Upload min score",        value: 0.0,  min: 0,    max: 1,     description: "skip upload if peak_score below this (0 = upload all)" },
  { paramId: "upload_cooldown_s",     name: "Upload cooldown (s)",     value: 60,   min: 0,    max: 3600,  description: "minimum seconds between uploads" },
];

function seedMonitorParams(db) {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO monitor_params
      (param_id, name, current_value, default_value, min_value, max_value, description, updated_at)
    VALUES (@paramId, @name, @value, @value, @min, @max, @description, @now)
  `);
  const insertAll = db.transaction((seeds) => {
    for (const seed of seeds) insert.run({ ...seed, now });
  });
  insertAll(MONITOR_PARAM_SEEDS);
}

/** Open (creating if necessary) the SQLite database at dbPath. */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // Idempotent migrations for databases created by earlier releases.
  try { db.exec("ALTER TABLE hit_metadata ADD COLUMN window_s REAL NOT NULL DEFAULT 1.5"); } catch {}
  try { db.exec("ALTER TABLE hit_metadata ADD COLUMN model_trained_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE hit_metadata ADD COLUMN analysis_settings TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE hit_metadata ADD COLUMN analysis_trigger TEXT NOT NULL DEFAULT 'automatic'"); } catch {}
  try { db.exec("ALTER TABLE diary_entries ADD COLUMN source_wav_path TEXT"); } catch {}
  try { db.exec("ALTER TABLE diary_entries ADD COLUMN source_wav_etag TEXT"); } catch {}
  try { db.exec("ALTER TABLE diary_entries ADD COLUMN trim_start_ms INTEGER"); } catch {}
  try { db.exec("ALTER TABLE diary_entries ADD COLUMN trim_stop_ms INTEGER"); } catch {}
  try { db.exec("ALTER TABLE diary_entries ADD COLUMN approved TEXT"); } catch {}
  // Idempotent migration: add diary_id cross-link to samples.
  try { db.exec("ALTER TABLE samples ADD COLUMN diary_id TEXT"); } catch {}
  seedMonitorParams(db);
  return db;
}

/**
 * Open an existing database for the anonymous public API.
 *
 * Unlike openDb(), this deliberately performs no bootstrap, schema migration,
 * or seed writes. `readonly` is the actual SQLite open mode; query_only is
 * defense in depth in case this connection is ever passed to write-oriented
 * shared code by mistake.
 */
export function openReadonlyDb(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

// ─── Monitor params ───────────────────────────────────────────────────────────

/** List all monitor params (bark-monitor tuning), ordered by param_id. */
export function listMonitorParams(db) {
  return db.prepare(`
    SELECT param_id AS paramId, name, current_value AS currentValue, default_value AS defaultValue,
           min_value AS minValue, max_value AS maxValue, description, updated_at AS updatedAt
    FROM monitor_params ORDER BY param_id
  `).all();
}

/** Map of paramId -> currentValue, consumed by Goblin live and offline analysis. */
export function getMonitorParamsMap(db) {
  const map = {};
  for (const row of listMonitorParams(db)) map[row.paramId] = row.currentValue;
  return map;
}

/**
 * Update one monitor param's current_value, enforcing its min/max range.
 * Throws if the param doesn't exist or the value is out of range.
 * Returns the updated row.
 */
export function setMonitorParam(db, paramId, value) {
  const row = db.prepare("SELECT min_value AS minValue, max_value AS maxValue FROM monitor_params WHERE param_id = ?").get(paramId);
  if (!row) {
    throw new Error(`unknown monitor param: ${paramId}`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("value must be a finite number");
  }
  if (row.minValue != null && value < row.minValue) {
    throw new Error(`value must be >= ${row.minValue}`);
  }
  if (row.maxValue != null && value > row.maxValue) {
    throw new Error(`value must be <= ${row.maxValue}`);
  }
  db.prepare("UPDATE monitor_params SET current_value = ?, updated_at = ? WHERE param_id = ?")
    .run(value, new Date().toISOString(), paramId);
  return listMonitorParams(db).find(p => p.paramId === paramId);
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

/**
 * Insert a sample only when its deterministic id is not present. Returns true
 * for the request that created the row, allowing callers to populate related
 * records exactly once even when requests overlap.
 */
export function insertSampleIfAbsent(db, entry) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO samples
      (id, filename, audio_path, waveform_path, label, date, datetime_local, duration_sec, status, diary_id, created_at, updated_at)
    VALUES
      (@id, @filename, @audioPath, @waveformPath, @label, @date, @datetimeLocal, @durationSec, 'active', @diaryId, @createdAt, @updatedAt)
    ON CONFLICT(id) DO NOTHING
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
    createdAt: now,
    updatedAt: now,
  });
  return info.changes === 1;
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

/** Fetch the direct whole-recording note for an unlinked diary clip. */
export function getDiaryNote(db, diaryId) {
  return db.prepare(`
    SELECT id, diary_id AS diaryId, label,
           created_at AS createdAt, updated_at AS updatedAt
    FROM diary_notes WHERE diary_id = ?
  `).get(diaryId);
}

/** Create or replace one direct whole-recording diary note. */
export function upsertDiaryNote(db, diaryId, label) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO diary_notes (diary_id, label, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(diary_id) DO UPDATE SET
      label = excluded.label,
      updated_at = excluded.updated_at
  `).run(diaryId, label, now, now);
  return getDiaryNote(db, diaryId);
}

/** Delete a direct diary note after moving it onto a linked sample. */
export function deleteDiaryNote(db, diaryId) {
  db.prepare("DELETE FROM diary_notes WHERE diary_id = ?").run(diaryId);
}

// ─── Diary entries ───────────────────────────────────────────────────────────

/**
 * Insert or update a diary entry row. `entry` shape:
 *   { id, filename, audioPath, waveformPath, label, date, time,
 *     datetimeLocal, durationSec, trimStartMs?, trimStopMs?, kind,
 *     sourceWavPath?, sourceWavEtag? }
 */
export function upsertDiaryEntry(db, entry) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT created_at FROM diary_entries WHERE id = ?").get(entry.id);

  db.prepare(`
    INSERT INTO diary_entries
      (id, filename, audio_path, waveform_path, label, date, time,
       datetime_local, duration_sec, trim_start_ms, trim_stop_ms, kind,
       source_wav_path, source_wav_etag,
       created_at, updated_at)
    VALUES
      (@id, @filename, @audioPath, @waveformPath, @label, @date, @time,
       @datetimeLocal, @durationSec, @trimStartMs, @trimStopMs, @kind,
       @sourceWavPath, @sourceWavEtag,
       @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      filename       = excluded.filename,
      audio_path     = excluded.audio_path,
      waveform_path  = excluded.waveform_path,
      label          = excluded.label,
      date           = excluded.date,
      time           = excluded.time,
      datetime_local = excluded.datetime_local,
      duration_sec   = excluded.duration_sec,
      trim_start_ms  = COALESCE(diary_entries.trim_start_ms, excluded.trim_start_ms),
      trim_stop_ms   = COALESCE(diary_entries.trim_stop_ms, excluded.trim_stop_ms),
      kind           = excluded.kind,
      source_wav_path = COALESCE(excluded.source_wav_path, diary_entries.source_wav_path),
      source_wav_etag = COALESCE(excluded.source_wav_etag, diary_entries.source_wav_etag),
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
    trimStartMs: entry.trimStartMs ?? null,
    trimStopMs: entry.trimStopMs ?? null,
    kind: entry.kind ?? 'audio',
    sourceWavPath: entry.sourceWavPath ?? null,
    sourceWavEtag: entry.sourceWavEtag ?? null,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
  });
}

/** List diary entries oldest first, optionally within inclusive date bounds. */
export function listDiaryEntries(db, { startDate = null, endDate = null } = {}) {
  const filters = [];
  const params = {};
  if (startDate) {
    filters.push("d.date >= @startDate");
    params.startDate = startDate;
  }
  if (endDate) {
    filters.push("d.date <= @endDate");
    params.endDate = endDate;
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  return db.prepare(`
    SELECT d.id, d.filename, d.audio_path AS audioPath, d.waveform_path AS waveformPath,
           d.label, d.date, d.time, d.datetime_local AS datetimeLocal,
           d.duration_sec AS durationSec,
           d.trim_start_ms AS trimStartMs, d.trim_stop_ms AS trimStopMs,
           d.approved, d.kind,
           d.source_wav_path AS sourceWavPath, d.source_wav_etag AS sourceWavEtag,
           s.id AS sampleId, s.audio_path AS sampleAudioPath
    FROM diary_entries d
    LEFT JOIN samples s ON s.diary_id = d.id AND s.status = 'active'
    ${where}
    ORDER BY d.datetime_local ASC
  `).all(params);
}

/** Return the newest diary date, or null when the diary is empty. */
export function getLatestDiaryDate(db) {
  return db.prepare("SELECT MAX(date) AS date FROM diary_entries").get().date ?? null;
}

/**
 * Summarize audio diary entries by date within inclusive bounds.
 *
 * Disturbed time uses the persisted trim when it is valid and otherwise the
 * complete recording duration. Bark counts include only hit timestamps inside
 * that same visible range, matching the report UI's historical calculation.
 * Dates without audio entries are filled by the API layer.
 */
export function listDiarySummaryByDate(db, { startDate, endDate }) {
  const rows = db.prepare(`
    WITH audio_entries AS (
      SELECT
        d.id,
        d.date,
        CASE
          WHEN typeof(d.trim_start_ms) = 'integer'
            AND typeof(d.trim_stop_ms) = 'integer'
            AND d.trim_start_ms >= 0
            AND d.trim_stop_ms > d.trim_start_ms
            AND d.trim_stop_ms <= MAX(0, ROUND(d.duration_sec * 1000))
          THEN d.trim_start_ms
          ELSE 0
        END AS visible_start_ms,
        CASE
          WHEN typeof(d.trim_start_ms) = 'integer'
            AND typeof(d.trim_stop_ms) = 'integer'
            AND d.trim_start_ms >= 0
            AND d.trim_stop_ms > d.trim_start_ms
            AND d.trim_stop_ms <= MAX(0, ROUND(d.duration_sec * 1000))
          THEN d.trim_stop_ms
          ELSE MAX(0, ROUND(d.duration_sec * 1000))
        END AS visible_stop_ms
      FROM diary_entries d
      WHERE d.kind = 'audio'
        AND d.date >= @startDate
        AND d.date <= @endDate
    )
    SELECT
      e.date,
      COUNT(*) AS records,
      SUM(e.visible_stop_ms - e.visible_start_ms) AS disturbedTimeMs,
      SUM((
        SELECT COUNT(*)
        FROM json_each(
          CASE WHEN json_valid(h.timestamps) THEN h.timestamps ELSE '[]' END
        ) AS hit
        WHERE hit.type IN ('integer', 'real')
          AND CAST(hit.value AS REAL) >= e.visible_start_ms / 1000.0
          AND CAST(hit.value AS REAL) < e.visible_stop_ms / 1000.0
      )) AS barks
    FROM audio_entries e
    LEFT JOIN hit_metadata h ON h.clip_id = e.id
    GROUP BY e.date
    ORDER BY e.date ASC
  `).all({ startDate, endDate });

  return rows.map((row) => ({
    date: row.date,
    records: Number(row.records) || 0,
    disturbedTimeSec: (Number(row.disturbedTimeMs) || 0) / 1000,
    barks: Number(row.barks) || 0,
  }));
}

/** Fetch a single diary entry by id, or undefined. */
export function getDiaryEntry(db, id) {
  return db.prepare(`
    SELECT d.id, d.filename, d.audio_path AS audioPath, d.waveform_path AS waveformPath,
           d.label, d.date, d.time, d.datetime_local AS datetimeLocal,
           d.duration_sec AS durationSec,
           d.trim_start_ms AS trimStartMs, d.trim_stop_ms AS trimStopMs,
           d.approved, d.kind,
           d.source_wav_path AS sourceWavPath, d.source_wav_etag AS sourceWavEtag,
           d.created_at AS createdAt, d.updated_at AS updatedAt,
           s.id AS sampleId, s.audio_path AS sampleAudioPath
    FROM diary_entries d
    LEFT JOIN samples s ON s.diary_id = d.id AND s.status = 'active'
    WHERE d.id = ?
  `).get(id);
}

/** Persist or clear the non-destructive playback bounds for a diary entry. */
export function setDiaryTrim(db, id, { trimStartMs = null, trimStopMs = null } = {}) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE diary_entries
    SET trim_start_ms = ?, trim_stop_ms = ?, updated_at = ?
    WHERE id = ?
  `).run(trimStartMs, trimStopMs, now, id);
  return result.changes === 1 ? getDiaryEntry(db, id) : undefined;
}

/** Set or clear the server-generated approval timestamp for a diary entry. */
export function setDiaryApproved(db, id, isApproved) {
  const now = new Date().toISOString();
  const approved = isApproved ? now : null;
  const result = db.prepare(`
    UPDATE diary_entries
    SET approved = ?, updated_at = ?
    WHERE id = ?
  `).run(approved, now, id);
  return result.changes === 1 ? getDiaryEntry(db, id) : undefined;
}

/**
 * List whole-recording note annotations attached either directly to a diary
 * clip or through its linked active training sample. Results use one public
 * shape so clients do not need to know which persistence path owns the note.
 */
export function listDiaryCommentAnnotations(db, {
  startDate = null,
  endDate = null,
  diaryId = null,
} = {}) {
  const filters = [];
  const params = {};
  if (startDate) {
    filters.push("d.date >= @startDate");
    params.startDate = startDate;
  }
  if (endDate) {
    filters.push("d.date <= @endDate");
    params.endDate = endDate;
  }
  if (diaryId) {
    filters.push("d.id = @diaryId");
    params.diaryId = diaryId;
  }
  const suffix = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  const sampleNotes = db.prepare(`
    SELECT a.id, s.diary_id AS diaryId, a.sample_id AS sampleId,
           a.start_sec AS startSec, a.end_sec AS endSec,
           a.label, a.source, a.created_at AS createdAt,
           'sample' AS scope
    FROM annotations a
    JOIN samples s ON s.id = a.sample_id AND s.status = 'active'
    JOIN diary_entries d ON d.id = s.diary_id
    WHERE a.source = 'note' AND a.start_sec = 0 AND a.end_sec = 0${suffix}
  `).all(params);

  const directNotes = db.prepare(`
    SELECT n.id, n.diary_id AS diaryId, NULL AS sampleId,
           0 AS startSec, 0 AS endSec,
           n.label, 'note' AS source, n.created_at AS createdAt,
           'diary' AS scope
    FROM diary_notes n
    JOIN diary_entries d ON d.id = n.diary_id
    WHERE 1 = 1${suffix}
  `).all(params);

  return [...sampleNotes, ...directNotes].sort((a, b) => (
    a.diaryId.localeCompare(b.diaryId)
    || a.scope.localeCompare(b.scope)
    || a.id - b.id
  ));
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
export function upsertHitMetadata(db, clipId, {
  timestamps,
  confidences,
  loudnesses,
  paddingS,
  windowS,
  modelTrainedAt = null,
  analysisSettings = {},
  analysisTrigger = "automatic",
}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hit_metadata
      (clip_id, timestamps, confidences, loudnesses, padding_s, window_s,
       model_trained_at, analysis_settings, analysis_trigger, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(clip_id) DO UPDATE SET
      timestamps        = excluded.timestamps,
      confidences       = excluded.confidences,
      loudnesses        = excluded.loudnesses,
      padding_s         = excluded.padding_s,
      window_s          = excluded.window_s,
      model_trained_at  = excluded.model_trained_at,
      analysis_settings = excluded.analysis_settings,
      analysis_trigger  = excluded.analysis_trigger,
      created_at        = excluded.created_at
  `).run(
    clipId,
    JSON.stringify(timestamps ?? []),
    JSON.stringify(confidences ?? []),
    JSON.stringify(loudnesses ?? []),
    paddingS ?? 0,
    windowS ?? 1.5,
    modelTrainedAt,
    JSON.stringify(analysisSettings),
    analysisTrigger,
    now,
  );
}

/** Convert a hit_metadata query row into the API response shape. */
function parseHitMetadataRow(row) {
  return {
    clipId: row.clipId,
    date: row.date ?? null,
    timestamps: JSON.parse(row.timestamps),
    confidences: JSON.parse(row.confidences),
    loudnesses: JSON.parse(row.loudnesses),
    paddingS: row.paddingS,
    windowS: row.windowS,
    modelTrainedAt: row.modelTrainedAt,
    analysisSettings: JSON.parse(row.analysisSettings),
    analysisTrigger: row.analysisTrigger,
    createdAt: row.createdAt,
  };
}

/** Fetch hit metadata for a clip, parsing the JSON arrays. Returns null if not found. */
export function getHitMetadata(db, clipId) {
  const row = db.prepare(
    `SELECT h.clip_id AS clipId, d.date, h.timestamps, h.confidences, h.loudnesses,
            h.padding_s AS paddingS, h.window_s AS windowS,
            h.model_trained_at AS modelTrainedAt,
            h.analysis_settings AS analysisSettings,
            h.analysis_trigger AS analysisTrigger,
            h.created_at AS createdAt
     FROM hit_metadata h
     LEFT JOIN diary_entries d ON d.id = h.clip_id
     WHERE h.clip_id = ?`
  ).get(clipId);
  if (!row) return null;
  return parseHitMetadataRow(row);
}

/**
 * List one stable, 1-based page of hit metadata.
 * Date bounds are inclusive and refer to the linked diary recording date.
 */
export function listHitMetadataPage(db, {
  startDate = null,
  endDate = null,
  page = 1,
  pageSize = 1000,
} = {}) {
  const filters = [];
  const filterParams = {};
  if (startDate) {
    filters.push("d.date >= @startDate");
    filterParams.startDate = startDate;
  }
  if (endDate) {
    filters.push("d.date <= @endDate");
    filterParams.endDate = endDate;
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const { totalRecords } = db.prepare(`
    SELECT COUNT(*) AS totalRecords
    FROM hit_metadata h
    LEFT JOIN diary_entries d ON d.id = h.clip_id
    ${where}
  `).get(filterParams);

  const rows = db.prepare(`
    SELECT h.clip_id AS clipId, d.date, h.timestamps, h.confidences, h.loudnesses,
           h.padding_s AS paddingS, h.window_s AS windowS,
           h.model_trained_at AS modelTrainedAt,
           h.analysis_settings AS analysisSettings,
           h.analysis_trigger AS analysisTrigger,
           h.created_at AS createdAt
    FROM hit_metadata h
    LEFT JOIN diary_entries d ON d.id = h.clip_id
    ${where}
    ORDER BY h.id ASC
    LIMIT @pageSize OFFSET @offset
  `).all({
    ...filterParams,
    pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    items: rows.map(parseHitMetadataRow),
    totalRecords,
  };
}

/** Delete a hit_metadata row by clip_id. No-op if not found. */
export function deleteHitMetadataRow(db, clipId) {
  db.prepare("DELETE FROM hit_metadata WHERE clip_id = ?").run(clipId);
}

// ─── Recording data quality ─────────────────────────────────────────────────

function parseDataQualityRow(row) {
  if (!row) return null;
  return {
    recordId: row.recordId,
    recordingStartedAt: row.recordingStartedAt,
    recordingEndedAt: row.recordingEndedAt,
    durationS: row.durationS,
    xrunCount: row.xrunCount,
    inputOverflowCount: row.inputOverflowCount,
    inputUnderflowCount: row.inputUnderflowCount,
    outputOverflowCount: row.outputOverflowCount,
    outputUnderflowCount: row.outputUnderflowCount,
    otherXrunCount: row.otherXrunCount,
    errors: JSON.parse(row.errors),
    errorsTruncated: row.errorsTruncated,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function upsertDataQuality(db, recordId, quality) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO data_quality
      (record_id, recording_started_at, recording_ended_at, duration_s,
       xrun_count, input_overflow_count, input_underflow_count,
       output_overflow_count, output_underflow_count, other_xrun_count,
       errors, errors_truncated, created_at, updated_at)
    VALUES
      (@recordId, @recordingStartedAt, @recordingEndedAt, @durationS,
       @xrunCount, @inputOverflowCount, @inputUnderflowCount,
       @outputOverflowCount, @outputUnderflowCount, @otherXrunCount,
       @errors, @errorsTruncated, @createdAt, @updatedAt)
    ON CONFLICT(record_id) DO UPDATE SET
      recording_started_at   = excluded.recording_started_at,
      recording_ended_at     = excluded.recording_ended_at,
      duration_s             = excluded.duration_s,
      xrun_count             = excluded.xrun_count,
      input_overflow_count   = excluded.input_overflow_count,
      input_underflow_count  = excluded.input_underflow_count,
      output_overflow_count  = excluded.output_overflow_count,
      output_underflow_count = excluded.output_underflow_count,
      other_xrun_count       = excluded.other_xrun_count,
      errors                 = excluded.errors,
      errors_truncated       = excluded.errors_truncated,
      updated_at             = excluded.updated_at
  `).run({
    recordId,
    recordingStartedAt: quality.recordingStartedAt,
    recordingEndedAt: quality.recordingEndedAt,
    durationS: quality.durationS,
    xrunCount: quality.xrunCount,
    inputOverflowCount: quality.inputOverflowCount,
    inputUnderflowCount: quality.inputUnderflowCount,
    outputOverflowCount: quality.outputOverflowCount,
    outputUnderflowCount: quality.outputUnderflowCount,
    otherXrunCount: quality.otherXrunCount,
    errors: JSON.stringify(quality.errors),
    errorsTruncated: quality.errorsTruncated,
    createdAt: now,
    updatedAt: now,
  });
}

export function getDataQuality(db, recordId) {
  return parseDataQualityRow(db.prepare(`
    SELECT record_id AS recordId,
           recording_started_at AS recordingStartedAt,
           recording_ended_at AS recordingEndedAt,
           duration_s AS durationS,
           xrun_count AS xrunCount,
           input_overflow_count AS inputOverflowCount,
           input_underflow_count AS inputUnderflowCount,
           output_overflow_count AS outputOverflowCount,
           output_underflow_count AS outputUnderflowCount,
           other_xrun_count AS otherXrunCount,
           errors, errors_truncated AS errorsTruncated,
           created_at AS createdAt, updated_at AS updatedAt
    FROM data_quality WHERE record_id = ?
  `).get(recordId));
}

/** List one newest-first page of recording quality, optionally by UTC date. */
export function listDataQualityPage(db, {
  startDate = null,
  endDate = null,
  page = 1,
  pageSize = 1000,
} = {}) {
  const filters = [];
  const params = {};
  if (startDate) {
    filters.push("recording_started_at >= @startTimestamp");
    params.startTimestamp = `${startDate}T00:00:00.000Z`;
  }
  if (endDate) {
    filters.push("recording_started_at < @endTimestamp");
    const exclusiveEnd = new Date(`${endDate}T00:00:00.000Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    params.endTimestamp = exclusiveEnd.toISOString();
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const { totalRecords } = db.prepare(`
    SELECT COUNT(*) AS totalRecords FROM data_quality ${where}
  `).get(params);
  const rows = db.prepare(`
    SELECT record_id AS recordId,
           recording_started_at AS recordingStartedAt,
           recording_ended_at AS recordingEndedAt,
           duration_s AS durationS,
           xrun_count AS xrunCount,
           input_overflow_count AS inputOverflowCount,
           input_underflow_count AS inputUnderflowCount,
           output_overflow_count AS outputOverflowCount,
           output_underflow_count AS outputUnderflowCount,
           other_xrun_count AS otherXrunCount,
           errors, errors_truncated AS errorsTruncated,
           created_at AS createdAt, updated_at AS updatedAt
    FROM data_quality
    ${where}
    ORDER BY recording_started_at DESC, record_id DESC
    LIMIT @pageSize OFFSET @offset
  `).all({
    ...params,
    pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items: rows.map(parseDataQualityRow), totalRecords };
}

export function deleteDataQualityRow(db, recordId) {
  db.prepare("DELETE FROM data_quality WHERE record_id = ?").run(recordId);
}

/** Move quality metadata with a recording identity change. */
export function moveDataQualityRecord(db, oldRecordId, newRecordId) {
  if (oldRecordId === newRecordId) return;
  const quality = getDataQuality(db, oldRecordId);
  if (!quality) return;
  db.transaction(() => {
    upsertDataQuality(db, newRecordId, quality);
    deleteDataQualityRow(db, oldRecordId);
  })();
}
