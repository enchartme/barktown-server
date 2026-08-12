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
    source_wav_path TEXT,
    source_wav_etag TEXT,
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
  // Idempotent migration: add diary_id cross-link to samples.
  try { db.exec("ALTER TABLE samples ADD COLUMN diary_id TEXT"); } catch {}
  seedMonitorParams(db);
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
 *     datetimeLocal, durationSec, kind, sourceWavPath?, sourceWavEtag? }
 */
export function upsertDiaryEntry(db, entry) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT created_at FROM diary_entries WHERE id = ?").get(entry.id);

  db.prepare(`
    INSERT INTO diary_entries
      (id, filename, audio_path, waveform_path, label, date, time,
       datetime_local, duration_sec, kind, source_wav_path, source_wav_etag,
       created_at, updated_at)
    VALUES
      (@id, @filename, @audioPath, @waveformPath, @label, @date, @time,
       @datetimeLocal, @durationSec, @kind, @sourceWavPath, @sourceWavEtag,
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
    kind: entry.kind ?? 'audio',
    sourceWavPath: entry.sourceWavPath ?? null,
    sourceWavEtag: entry.sourceWavEtag ?? null,
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
           d.source_wav_path AS sourceWavPath, d.source_wav_etag AS sourceWavEtag,
           s.id AS sampleId, s.audio_path AS sampleAudioPath
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
           d.source_wav_path AS sourceWavPath, d.source_wav_etag AS sourceWavEtag,
           d.created_at AS createdAt, d.updated_at AS updatedAt,
           s.id AS sampleId, s.audio_path AS sampleAudioPath
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
