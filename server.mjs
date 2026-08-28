#!/usr/bin/env node
/**
 * barktown-server — public read-only HTTP API over the Barktown database.
 *
 * This is the public entry point. server-private.mjs imports the same route
 * implementation in private mode, so every business endpoint belongs to
 * exactly one of the two processes.
 *
 * This runs as a separate process from ingest-service.mjs (which also
 * writes to the database on new uploads). SQLite's WAL mode + a busy
 * timeout (lib/db.mjs) support multiple writers/readers across processes.
 *
 * Public mode exposes only anonymous GET routes and opens SQLite read-only.
 * Private mode exposes mutations and operator-only reads over Tailscale.
 *
 * ─── Configuration ─────────────────────────────────────────
 *
 *  DB_PATH    Local SQLite database file   (default: ./data/barktown.db)
 *  PUBLIC_API_HOST    Public bind interface   (default: 127.0.0.1)
 *  PUBLIC_API_PORT    Public port             (default: 8091)
 *  PRIVATE_API_HOST   Private bind interface  (default: legacy API_HOST)
 *  PRIVATE_API_PORT   Private port            (default: legacy API_PORT, then 8090)
 *
 * ─── Running ───────────────────────────────────────────────────
 *
 *   node server.mjs
 *   npm run server
 */

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import fs from "fs";
import os from "os";
import path from "path";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { buildConfig } from "./lib/config.mjs";
import { createClient, copyObject, removeObject, saveJson, loadJson, download, upload, listObjects } from "./lib/minio.mjs";
import { canonicalizeAutoDetectionId, parseSampleFilename } from "./lib/filenames.mjs";
import {
  availableSourceWavPath,
  buildDiarySampleMove,
  sourceWavKeyCandidatesForEntry,
} from "./lib/diary-samples.mjs";
import { runReanalyzeScript } from "./lib/reanalyze.mjs";
import { trimBoundsAroundHits } from "./lib/diary-trim.mjs";
import {
  createReanalysisLimiter,
  ReanalysisAlreadyRunningError,
} from "./lib/reanalysis-limiter.mjs";
import {
  openDb, openReadonlyDb, getSample, listSamples, listAnnotations, listAllAnnotations, exportSamplesIndexJson,
  deleteSampleRow, renameSampleTransaction,
  getAnnotation, insertAnnotation, updateAnnotation, deleteAnnotationRow,
  listDiaryEntries, getLatestDiaryDate, listDiarySummaryByDate, getDiaryEntry, setDiaryTrim, deleteDiaryEntryRow,
  listDiaryCommentAnnotations, getDiaryNote, upsertDiaryNote, deleteDiaryNote,
  upsertHitMetadata, getHitMetadata, listHitMetadataPage, deleteHitMetadataRow,
  upsertSample, insertSampleIfAbsent,
  listMonitorParams, getMonitorParamsMap, setMonitorParam,
} from "./lib/db.mjs";
import { log, warn, err } from "./lib/log.mjs";
import { generateWaveform } from "./lib/audio.mjs";
import { hitMetadataReviewFragments } from "./lib/hit-annotations.mjs";

const CFG = buildConfig();
const API_MODE = process.env.BARKTOWN_API_MODE ?? "public";
if (API_MODE !== "public" && API_MODE !== "private") {
  throw new Error(`BARKTOWN_API_MODE must be "public" or "private", received: ${API_MODE}`);
}
const isPublicApi = API_MODE === "public";
const db = isPublicApi ? openReadonlyDb(CFG.dbPath) : openDb(CFG.dbPath);
const mc = createClient(CFG.minio);
const reanalysisLimiter = isPublicApi
  ? null
  : createReanalysisLimiter({ concurrency: CFG.reanalyze.concurrency });

const app = Fastify({ logger: false });
const corsMethods = isPublicApi
  ? ["GET", "HEAD", "OPTIONS"]
  : ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
await app.register(cors, { origin: true, methods: corsMethods });

if (isPublicApi) {
  // The public API is a live, filtered database view. Keep Cloudflare and
  // browsers from turning it into an independently invalidated data store.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
}

// Disabled registrars intentionally do nothing. This keeps all route logic in
// one implementation while making route ownership explicit and non-overlapping.
const publicApi = {
  get: (...args) => isPublicApi && app.get(...args),
};
const privateApi = {
  get: (...args) => !isPublicApi && app.get(...args),
  post: (...args) => !isPublicApi && app.post(...args),
  put: (...args) => !isPublicApi && app.put(...args),
  patch: (...args) => !isPublicApi && app.patch(...args),
  delete: (...args) => !isPublicApi && app.delete(...args),
};

/** Regenerate training-samples-index.json in MinIO from the current DB contents.
 * Best-effort: the DB is the source of truth, and ingest-service.mjs regenerates
 * this file on every upload anyway, so a transient MinIO failure here shouldn't
 * fail a mutation that has already been committed to the database. */
async function refreshSamplesIndex() {
  try {
    await saveJson(mc, CFG.bucket, CFG.samplesIndexKey, exportSamplesIndexJson(db));
  } catch (e) {
    warn(`failed to refresh ${CFG.samplesIndexKey} in MinIO: ${e.message}`);
  }
}

/**
 * Validate annotation fields. Returns an error string, or null if valid.
 *
 * Annotations double as two things, distinguished by `source`:
 *  - fragment labels (source: "manual"/"model"): startSec < endSec, label is
 *    a training-sample category or the non-trainable "review" state.
 *  - time-coded notes (source: "note"): a point in time (startSec === endSec
 *    is allowed), label holds the freeform note text.
 */
function validateAnnotationInput({ startSec, endSec, label }, durationSec) {
  if (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0) {
    return "startSec must be a non-negative number";
  }
  if (typeof endSec !== "number" || !Number.isFinite(endSec) || endSec < startSec) {
    return "endSec must be a number greater than or equal to startSec";
  }
  if (typeof durationSec === "number" && durationSec > 0 && endSec > durationSec + 0.25) {
    return `endSec (${endSec}) exceeds sample duration (${durationSec})`;
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    return "label is required";
  }
  return null;
}

/**
 * Validate a hit-metadata payload (own submissions from barktown-goblin, or
 * the JSON produced by Goblin's tools/analyze_wav.py). Returns an error string, or
 * null if valid.
 */
function validateHitMetadataPayload(payload, { requireProvenance = false } = {}) {
  const {
    timestamps,
    confidences,
    loudnesses,
    padding_s: paddingS,
    window_s: windowS,
    model_trained_at: modelTrainedAt,
    analysis_settings: analysisSettings,
    analysis_trigger: analysisTrigger,
  } = payload ?? {};
  if (!Array.isArray(timestamps) || !Array.isArray(confidences) || !Array.isArray(loudnesses)) {
    return "timestamps, confidences and loudnesses must be arrays";
  }
  const n = timestamps.length;
  if (confidences.length !== n || loudnesses.length !== n) {
    return "timestamps, confidences and loudnesses must have the same length";
  }
  if (!timestamps.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    return "timestamps must be non-negative finite numbers";
  }
  if (!confidences.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) {
    return "confidences must be numbers in [0, 1]";
  }
  if (!loudnesses.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    return "loudnesses must be non-negative finite numbers";
  }
  if (paddingS !== undefined && (typeof paddingS !== "number" || !Number.isFinite(paddingS) || paddingS < 0)) {
    return "padding_s must be a non-negative finite number";
  }
  if (windowS !== undefined && (typeof windowS !== "number" || !Number.isFinite(windowS) || windowS <= 0)) {
    return "window_s must be a positive finite number";
  }
  if (
    modelTrainedAt !== undefined
    && modelTrainedAt !== null
    && (
      typeof modelTrainedAt !== "string"
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(modelTrainedAt)
      || Number.isNaN(Date.parse(modelTrainedAt))
    )
  ) {
    return "model_trained_at must be null or an ISO-8601 timestamp with a timezone";
  }
  if (
    analysisSettings !== undefined
    && (
      analysisSettings === null
      || typeof analysisSettings !== "object"
      || Array.isArray(analysisSettings)
    )
  ) {
    return "analysis_settings must be a JSON object";
  }
  if (
    analysisTrigger !== undefined
    && analysisTrigger !== "automatic"
    && analysisTrigger !== "manual"
  ) {
    return "analysis_trigger must be automatic or manual";
  }
  if (requireProvenance) {
    if (!Object.prototype.hasOwnProperty.call(payload, "model_trained_at")) {
      return "model_trained_at is required from the offline analyzer";
    }
    if (
      !analysisSettings
      || typeof analysisSettings.classifier !== "object"
      || analysisSettings.classifier === null
      || Array.isArray(analysisSettings.classifier)
      || typeof analysisSettings.monitor !== "object"
      || analysisSettings.monitor === null
      || Array.isArray(analysisSettings.monitor)
    ) {
      return "analysis_settings must contain classifier and monitor objects";
    }
    if (analysisTrigger !== "manual") {
      return "analysis_trigger from the offline analyzer must be manual";
    }
  }
  return null;
}

const MAX_HIT_METADATA_PAGE_SIZE = 1000;

/** Return true only for a real calendar date formatted as YYYY-MM-DD. */
function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validate optional inclusive date bounds shared by list endpoints. */
function dateBoundsError(startDate, endDate) {
  if (startDate !== undefined && !isIsoDate(startDate)) {
    return "startDate must be a valid date in YYYY-MM-DD format";
  }
  if (endDate !== undefined && !isIsoDate(endDate)) {
    return "endDate must be a valid date in YYYY-MM-DD format";
  }
  if (startDate && endDate && startDate > endDate) {
    return "startDate must be earlier than or equal to endDate";
  }
  return null;
}

const SUMMARY_MAX_DAYS = 3660;

function diarySummaryBoundsError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    return "startDate and endDate are required";
  }
  const boundsError = dateBoundsError(startDate, endDate);
  if (boundsError) return boundsError;

  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const days = Math.floor((end - start) / 86_400_000) + 1;
  return days > SUMMARY_MAX_DAYS
    ? `summary period cannot exceed ${SUMMARY_MAX_DAYS} days`
    : null;
}

function completeDiarySummaryPeriod(startDate, endDate, populatedDays) {
  const populatedByDate = new Map(populatedDays.map((day) => [day.date, day]));
  const days = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);

  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    days.push(populatedByDate.get(date) ?? {
      date,
      records: 0,
      disturbedTimeSec: 0,
      barks: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const totals = days.reduce((sum, day) => ({
    records: sum.records + day.records,
    disturbedTimeSec: sum.disturbedTimeSec + day.disturbedTimeSec,
    barks: sum.barks + day.barks,
  }), { records: 0, disturbedTimeSec: 0, barks: 0 });

  return { startDate, endDate, days, totals };
}

/** Parse a positive integer query field, returning null when invalid. */
function parsePositiveInteger(value, defaultValue, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

/** Build a relative link while preserving the active date range and page size. */
function hitMetadataPageLink({ startDate, endDate, page, pageSize }) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  return `/api/hit-metadata?${params}`;
}

// Detection-tuning fields accepted by POST /api/diary/:id/reanalyze, and the
// range each must fall within (mirrors the monitor_params DB constraints).
const REANALYZE_TUNING_FIELDS = {
  candidateThreshold: { paramId: "candidate_threshold", min: 0, max: 1 },
  hitRefractoryS:     { paramId: "hit_refractory_s", min: 0 },
  inferenceWindowS:   { paramId: "inference_window_s", min: 0.1 },
  scoreIntervalS:     { paramId: "score_interval_s", min: 0.05 },
};

/** Validate optional detection-tuning overrides. Returns an error string, or null if valid. */
function validateReanalyzeTuning(body) {
  for (const [field, { min, max }] of Object.entries(REANALYZE_TUNING_FIELDS)) {
    const value = body?.[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
      const range = max !== undefined ? `[${min}, ${max}]` : `>= ${min}`;
      return `${field} must be a number ${range}`;
    }
  }
  return null;
}

/** Stat an object, returning null only for a genuine not-found response. */
async function statObjectIfExists(objectKey) {
  try {
    return await mc.statObject(CFG.bucket, objectKey);
  } catch (e) {
    if (e.code === "NoSuchKey" || e.code === "NotFound") return null;
    throw e;
  }
}

/** Resolve the first currently existing WAV source for one diary entry. */
async function findSourceWav(entry) {
  for (const candidate of sourceWavKeyCandidatesForEntry(entry, CFG)) {
    const stat = await statObjectIfExists(candidate);
    if (stat) return { objectKey: candidate, stat };
  }
  return null;
}

/** Ensure a training sample has a published waveform before exposing its DB row. */
async function ensureSampleWaveform({ sourceWaveformKey, audioKey, waveformKey, sampleId }) {
  if (await statObjectIfExists(waveformKey)) return;

  if (sourceWaveformKey && await statObjectIfExists(sourceWaveformKey)) {
    await copyObject(mc, CFG.bucket, sourceWaveformKey, waveformKey);
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-sample-waveform-"));
    try {
      const tmpAudio = path.join(tmpDir, path.basename(audioKey));
      const tmpWaveform = path.join(tmpDir, `${sampleId}.json`);
      await download(mc, CFG.bucket, audioKey, tmpAudio);
      if (!generateWaveform(CFG.audiowaveformBin, tmpAudio, tmpWaveform, 16, 50)) {
        throw new Error("audiowaveform failed");
      }
      await upload(mc, CFG.bucket, tmpWaveform, waveformKey, "application/json");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  if (!await statObjectIfExists(waveformKey)) {
    throw new Error(`waveform was not published: ${waveformKey}`);
  }
}

/** Add a live reanalyzable indication without exposing internal MinIO paths. */
function publicDiaryEntry(entry, availableKeys, annotations = []) {
  const sourcePath = availableSourceWavPath(entry, CFG, availableKeys);
  const { sourceWavPath, sourceWavEtag, sampleAudioPath, ...publicEntry } = entry;
  return { ...publicEntry, reanalyzable: sourcePath !== null, annotations };
}

function annotationsByDiaryId(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const annotations = grouped.get(row.diaryId) ?? [];
    annotations.push(row);
    grouped.set(row.diaryId, annotations);
  }
  return grouped;
}

/** List current WAV keys using two prefix scans rather than one stat per row. */
async function listAvailableSourceWavKeys() {
  const prefixes = [CFG.archivePrefix, CFG.samplesPrefix];
  const results = await Promise.allSettled(
    prefixes.map(prefix => listObjects(mc, CFG.bucket, prefix)),
  );
  const available = new Set();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const object of result.value) {
        if (/\.wav$/i.test(object.name)) available.add(object.name);
      }
    } else {
      warn(`could not list re-analysis sources below ${prefixes[index]}: ${result.reason?.message ?? result.reason}`);
    }
  });
  return available;
}

app.get("/health", async () => ({ ok: true }));

// Public, non-sensitive recording context used to describe generated reports.
publicApi.get("/api/recording-context", async () => ({
  album: CFG.recordingAlbum,
  location: CFG.recordingLocation,
  direction: CFG.recordingDirection,
  copyright: CFG.recordingCopyright,
}));

// ─── Diary entries ───────────────────────────────────────────────────────────────

// Lightweight bootstrap for date-bounded clients such as the report view.
publicApi.get("/api/diary/latest-date", async () => ({ date: getLatestDiaryDate(db) }));

// Additive report metrics for every date in one inclusive period. This keeps
// hit filtering and persisted-trim semantics on the database side so clients
// do not need to download and aggregate hit metadata just to show totals.
publicApi.get("/api/diary-summary", async (req, reply) => {
  const { startDate, endDate } = req.query ?? {};
  const boundsError = diarySummaryBoundsError(startDate, endDate);
  if (boundsError) {
    reply.code(400);
    return { error: boundsError };
  }

  const populatedDays = listDiarySummaryByDate(db, { startDate, endDate });
  return completeDiarySummaryPeriod(startDate, endDate, populatedDays);
});

// List diary entries, ordered by datetime (oldest first). Date bounds are inclusive.
publicApi.get("/api/diary", async (req, reply) => {
  const { startDate, endDate } = req.query ?? {};
  const boundsError = dateBoundsError(startDate, endDate);
  if (boundsError) {
    reply.code(400);
    return { error: boundsError };
  }

  const [entries, availableKeys, commentAnnotations] = await Promise.all([
    Promise.resolve(listDiaryEntries(db, { startDate, endDate })),
    listAvailableSourceWavKeys(),
    Promise.resolve(listDiaryCommentAnnotations(db, { startDate, endDate })),
  ]);
  const commentsByDiaryId = annotationsByDiaryId(commentAnnotations);
  return entries.map(entry => publicDiaryEntry(
    entry,
    availableKeys,
    commentsByDiaryId.get(entry.id) ?? [],
  ));
});

// Bulk hit metadata. Date bounds are inclusive and filter on diary_entries.date.
// Rows without a linked diary entry are included only when no date bound is used.
publicApi.get("/api/hit-metadata", async (req, reply) => {
  const { startDate, endDate } = req.query ?? {};
  const page = parsePositiveInteger(req.query?.page, 1);
  const pageSize = parsePositiveInteger(req.query?.pageSize, MAX_HIT_METADATA_PAGE_SIZE, MAX_HIT_METADATA_PAGE_SIZE);

  const boundsError = dateBoundsError(startDate, endDate);
  if (boundsError) {
    reply.code(400);
    return { error: boundsError };
  }
  if (page === null) {
    reply.code(400);
    return { error: "page must be a positive integer" };
  }
  if (pageSize === null) {
    reply.code(400);
    return { error: `pageSize must be an integer between 1 and ${MAX_HIT_METADATA_PAGE_SIZE}` };
  }

  const { items, totalRecords } = listHitMetadataPage(db, { startDate, endDate, page, pageSize });
  const totalPages = Math.ceil(totalRecords / pageSize);
  const hasNextPage = page * pageSize < totalRecords;
  const hasPreviousPage = page > 1;
  const linkParams = { startDate, endDate, pageSize };
  const links = {
    self: hitMetadataPageLink({ ...linkParams, page }),
    next: hasNextPage ? hitMetadataPageLink({ ...linkParams, page: page + 1 }) : null,
    previous: hasPreviousPage ? hitMetadataPageLink({ ...linkParams, page: page - 1 }) : null,
  };

  const linkHeader = [];
  if (links.next) linkHeader.push(`<${links.next}>; rel="next"`);
  if (links.previous) linkHeader.push(`<${links.previous}>; rel="prev"`);
  if (linkHeader.length) reply.header("Link", linkHeader.join(", "));

  return {
    items,
    pagination: {
      page,
      pageSize,
      returnedRecords: items.length,
      totalRecords,
      totalPages,
      hasNextPage,
      hasPreviousPage,
      nextPage: hasNextPage ? page + 1 : null,
      isLastPage: !hasNextPage,
      complete: !hasNextPage,
    },
    links,
  };
});

// Get a single diary entry.
publicApi.get("/api/diary/:id", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }
  let source;
  try {
    source = await findSourceWav(entry);
  } catch (e) {
    warn(`could not inspect re-analysis source for ${entry.id}: ${e.message}`);
  }
  const available = new Set(source ? [source.objectKey] : []);
  const annotations = listDiaryCommentAnnotations(db, { diaryId: entry.id });
  return publicDiaryEntry(entry, available, annotations);
});

// Create or replace the whole-recording comment through one diary-centric
// endpoint. Linked clips keep the note on their training sample; unlinked
// clips use diary_notes and expose the same annotation shape to clients.
privateApi.put("/api/diary/:id/comment", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }

  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!label) {
    reply.code(400);
    return { error: "label is required" };
  }

  if (entry.sampleId) {
    const existing = listAnnotations(db, entry.sampleId).find(annotation => (
      annotation.source === "note"
      && annotation.startSec === 0
      && annotation.endSec === 0
    ));
    if (existing) {
      updateAnnotation(db, existing.id, { label });
    } else {
      insertAnnotation(db, entry.sampleId, {
        startSec: 0,
        endSec: 0,
        label,
        source: "note",
      });
    }
  } else {
    upsertDiaryNote(db, entry.id, label);
  }

  return listDiaryCommentAnnotations(db, { diaryId: entry.id });
});

// Store playback/visualization bounds without modifying the source audio.
// A null/null pair is the canonical representation of the full recording.
privateApi.patch("/api/diary/:id/trim", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }

  const { trimStartMs, trimStopMs } = req.body ?? {};
  if (trimStartMs === null && trimStopMs === null) {
    const updated = setDiaryTrim(db, entry.id);
    return { trimStartMs: updated.trimStartMs, trimStopMs: updated.trimStopMs };
  }

  const durationMs = Math.max(0, Math.round(entry.durationSec * 1000));
  if (!Number.isInteger(trimStartMs) || !Number.isInteger(trimStopMs)) {
    reply.code(400);
    return { error: "trimStartMs and trimStopMs must be integer milliseconds" };
  }
  if (trimStartMs < 0 || trimStopMs <= trimStartMs || trimStopMs > durationMs) {
    reply.code(400);
    return { error: `trim bounds must satisfy 0 <= trimStartMs < trimStopMs <= ${durationMs}` };
  }

  const fullRecording = trimStartMs === 0 && trimStopMs === durationMs;
  const updated = setDiaryTrim(db, entry.id, fullRecording
    ? {}
    : { trimStartMs, trimStopMs });
  return { trimStartMs: updated.trimStartMs, trimStopMs: updated.trimStopMs };
});

// Get hit metadata for a diary clip (timestamps, confidences, loudnesses per bark hit).
// Returns 404 if no metadata has been submitted for this clip.
publicApi.get("/api/diary/:id/hit-metadata", async (req, reply) => {
  const meta = getHitMetadata(db, req.params.id);
  if (!meta) {
    reply.code(404);
    return { error: "not found" };
  }
  return meta;
});

// Store hit metadata sent by barktown-goblin immediately after a successful upload.
// The corresponding diary_entries row may not exist yet (ingest service is asynchronous),
// so this is an upsert keyed on clip_id with no FK requirement.
privateApi.post("/api/diary/:id/hit-metadata", async (req, reply) => {
  const payload = req.body ?? {};
  const {
    timestamps,
    confidences,
    loudnesses,
    padding_s: paddingS,
    window_s: windowS,
    model_trained_at: modelTrainedAt,
    analysis_settings: analysisSettings,
    analysis_trigger: analysisTrigger,
  } = payload;

  const error = validateHitMetadataPayload(payload);
  if (error) {
    reply.code(400);
    return { error };
  }

  // Older Goblin versions derived this ID from filenames containing the
  // mutable C/D/W/La/Lm snapshot. Normalize at the API boundary so a rolling
  // deployment cannot reintroduce split identities after the migration.
  const clipId = canonicalizeAutoDetectionId(req.params.id);
  upsertHitMetadata(db, clipId, {
    timestamps,
    confidences,
    loudnesses,
    paddingS: paddingS ?? 0,
    windowS: windowS ?? 1.5,
    modelTrainedAt: modelTrainedAt ?? null,
    analysisSettings: analysisSettings ?? {},
    analysisTrigger: analysisTrigger ?? "automatic",
  });
  reply.code(201);
  return getHitMetadata(db, clipId);
});

// ─── Monitor params (single source of truth for barktown-goblin's bark-monitor
// tuning, also used as this API's reanalyze defaults) ─────────────────────────

// List all monitor params (current + default value, allowed range, description).
privateApi.get("/api/monitor-params", async () => {
  return listMonitorParams(db);
});

// Update one monitor param's current value. barktown-goblin picks this up
// next time its statusd POSTs /monitor-params/fetch (or the monitor process's
// own periodic re-check runs); this route itself only updates the DB.
privateApi.patch("/api/monitor-params/:paramId", async (req, reply) => {
  const { value } = req.body ?? {};
  try {
    const updated = setMonitorParam(db, req.params.paramId, value);
    log(`Updated monitor param ${req.params.paramId} = ${value}`);
    return updated;
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }
});

// Re-analyze a diary clip: re-score its archived, uncompressed source WAV
// with YAMNet + the bark classifier (barktown-goblin's tools/analyze_wav.py)
// and upsert the resulting hit-metadata. Synchronous — the client waits for
// inference to finish (typically a few seconds per minute of audio).
//
// Detection tuning defaults come from the monitor_params DB table (the same
// values barktown-goblin's live monitor uses); optional body fields override
// them for this one run: candidateThreshold, hitRefractoryS,
// inferenceWindowS, scoreIntervalS — all range-validated finite numbers.
privateApi.post("/api/diary/:id/reanalyze", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }

  const tuningError = validateReanalyzeTuning(req.body);
  if (tuningError) {
    reply.code(400);
    return { error: tuningError };
  }
  const monitorParams = getMonitorParamsMap(db);
  const effectiveMonitorSettings = {};
  for (const [bodyField, { paramId }] of Object.entries(REANALYZE_TUNING_FIELDS)) {
    effectiveMonitorSettings[paramId] = req.body?.[bodyField] ?? monitorParams[paramId];
  }
  const tuning = { monitorSettings: effectiveMonitorSettings };

  try {
    return await reanalysisLimiter.run(entry.id, async () => {
      let source;
      try {
        source = await findSourceWav(entry);
      } catch (e) {
        err(`reanalyze: could not inspect source for ${entry.id}: ${e.message}`);
        reply.code(502);
        return { error: `could not inspect archived source in MinIO: ${e.message}` };
      }
      if (!source) {
        reply.code(409);
        return { error: "this diary entry has no currently available source WAV" };
      }

      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "barktown-reanalyze-"));
      const tmpPath = path.join(tmpDir, "source.wav");
      try {
        try {
          await download(mc, CFG.bucket, source.objectKey, tmpPath);
        } catch (e) {
          err(`reanalyze: could not download source "${source.objectKey}" for ${entry.id}: ${e.message}`);
          reply.code(502);
          return { error: `could not read archived source from MinIO: ${e.message}` };
        }

        let payload;
        try {
          payload = await runReanalyzeScript(CFG, tmpPath, tuning);
        } catch (e) {
          err(`reanalyze: scoring failed for ${entry.id}: ${e.message}`);
          reply.code(502);
          return { error: `re-analysis failed: ${e.message}` };
        }

        const validationError = validateHitMetadataPayload(payload, { requireProvenance: true });
        if (validationError) {
          err(`reanalyze: analyze_wav.py produced an invalid payload for ${entry.id}: ${validationError}`);
          reply.code(502);
          return { error: `re-analysis produced an invalid payload: ${validationError}` };
        }

        upsertHitMetadata(db, entry.id, {
          timestamps: payload.timestamps,
          confidences: payload.confidences,
          loudnesses: payload.loudnesses,
          paddingS: typeof payload.padding_s === "number" ? payload.padding_s : 0,
          windowS: typeof payload.window_s === "number" && payload.window_s > 0 ? payload.window_s : 1.5,
          modelTrainedAt: payload.model_trained_at ?? null,
          analysisSettings: payload.analysis_settings ?? {},
          analysisTrigger: "manual",
        });
        // Analysis always runs against the complete archived source. Once its
        // new hits are committed, show 1.5 seconds of context around the first
        // and last hit; no hits (or a fully covered source) means no trim.
        const automaticTrim = trimBoundsAroundHits(payload.timestamps, entry.durationSec);
        const trimmedEntry = setDiaryTrim(db, entry.id, automaticTrim);
        log(`Re-analyzed diary entry ${entry.id}: ${payload.timestamps.length} bark window(s)`);
        reply.code(201);
        return {
          ...getHitMetadata(db, entry.id),
          trimStartMs: trimmedEntry.trimStartMs,
          trimStopMs: trimmedEntry.trimStopMs,
        };
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
    });
  } catch (e) {
    if (e instanceof ReanalysisAlreadyRunningError) {
      reply.code(409);
      return { error: e.message };
    }
    throw e;
  }
});

// Delete a diary entry: removes the audio + waveform objects from MinIO and
// the DB row. Returns 204 on success.
privateApi.delete("/api/diary/:id", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }

  try {
    await removeObject(mc, CFG.bucket, entry.audioPath);
  } catch (e) {
    warn(`delete diary: could not remove audio object "${entry.audioPath}": ${e.message}`);
  }
  if (entry.waveformPath) {
    try {
      await removeObject(mc, CFG.bucket, entry.waveformPath);
    } catch (e) {
      warn(`delete diary: could not remove waveform object "${entry.waveformPath}": ${e.message}`);
    }
  }

  deleteDiaryEntryRow(db, entry.id);
  deleteHitMetadataRow(db, entry.id);

  // Best-effort: update index.json in MinIO to match.
  try {
    const indexEntries = await loadJson(mc, CFG.bucket, CFG.indexKey, []);
    const filtered = indexEntries.filter(e => e.id !== entry.id);
    if (filtered.length !== indexEntries.length) await saveJson(mc, CFG.bucket, CFG.indexKey, filtered);
  } catch (e) {
    warn(`delete diary: failed to update index.json: ${e.message}`);
  }

  log(`Deleted diary entry ${entry.id}`);
  return reply.code(204).send();
});

// Turn a diary recording into a labeled training sample. This route publishes
// the WAV, waveform, and SQLite row itself; training-samples/ is an output
// prefix and is never watched by the ingest service.
privateApi.post("/api/diary/:id/move-to-samples", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }

  let move;
  try {
    move = buildDiarySampleMove(entry, req.body?.label, CFG);
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }

  const keepInDiary = Boolean(req.body?.keepInDiary);
  const diaryNote = getDiaryNote(db, entry.id);
  const hitMeta = getHitMetadata(db, entry.id);

  // A repeated request may be finishing a partial attempt, so validate the
  // identity but continue through object verification and diary cleanup.
  const existingSample = getSample(db, move.sampleId);
  if (existingSample && existingSample.status !== "active") {
    reply.code(409);
    return { error: `sample id already exists but is inactive: ${existingSample.id}` };
  }
  if (existingSample?.status === "active") {
    if (existingSample.diaryId !== entry.id) {
      reply.code(409);
      return { error: `sample id already belongs to another recording: ${existingSample.id}` };
    }
    if (existingSample.audioPath !== move.destinationKey) {
      reply.code(409);
      return { error: `sample id points at a different audio object: ${existingSample.audioPath}` };
    }
  }

  let sourceStat;
  let destinationStat;
  try {
    [sourceStat, destinationStat] = await Promise.all([
      statObjectIfExists(move.sourceKey),
      statObjectIfExists(move.destinationKey),
    ]);
  } catch (e) {
    err(`move diary to samples: object preflight failed for ${entry.id}: ${e.message}`);
    reply.code(502);
    return { error: `failed to inspect objects in MinIO: ${e.message}` };
  }

  // A destination can already exist after a partially successful request.
  // If the source also remains, only treat it as resumable when both objects
  // have identical content; otherwise protect the existing sample.
  if (sourceStat && destinationStat) {
    if (sourceStat.size !== destinationStat.size || sourceStat.etag !== destinationStat.etag) {
      reply.code(409);
      return { error: `sample destination already exists: ${move.destinationKey}` };
    }
  } else if (!sourceStat && !destinationStat) {
    reply.code(409);
    return { error: `original WAV not found: ${move.sourceKey}` };
  }

  // Publish and verify both durable sample assets before changing SQLite or
  // deleting anything from the diary. A missing diary waveform is regenerated
  // synchronously from the copied source WAV.
  try {
    if (sourceStat && !destinationStat) {
      await copyObject(mc, CFG.bucket, move.sourceKey, move.destinationKey);
    }
    if (!await statObjectIfExists(move.destinationKey)) {
      throw new Error(`sample audio was not published: ${move.destinationKey}`);
    }
    await ensureSampleWaveform({
      sourceWaveformKey: entry.waveformPath,
      audioKey: move.destinationKey,
      waveformKey: move.waveformKey,
      sampleId: move.sampleId,
    });
  } catch (e) {
    err(`move diary to samples: asset publication failed for ${entry.id}: ${e.message}`);
    reply.code(502);
    return { error: `failed to publish sample assets in MinIO: ${e.message}` };
  }

  // Create the sample row only after audio and waveform are both available.
  const parsedSample = parseSampleFilename(move.filename);
  const sampleCreated = insertSampleIfAbsent(db, {
    id: move.sampleId,
    filename: move.filename,
    audioPath: move.destinationKey,
    waveformPath: move.waveformKey,
    label: move.label,
    date: parsedSample.date,
    datetimeLocal: parsedSample.datetimeLocal,
    durationSec: entry.durationSec ?? 0,
    diaryId: entry.id,
  });
  const storedSample = getSample(db, move.sampleId);
  if (!storedSample || storedSample.diaryId !== entry.id) {
    reply.code(409);
    return { error: `sample id already belongs to another recording: ${move.sampleId}` };
  }
  if (!sampleCreated && storedSample.waveformPath !== move.waveformKey) {
    upsertSample(db, { ...storedSample, waveformPath: move.waveformKey });
  }

  // Only the request that created the deterministic sample row may copy
  // annotations; retries then remain idempotent.
  if (sampleCreated && diaryNote) {
    const existingWholeNote = listAnnotations(db, move.sampleId).find(annotation => (
      annotation.source === "note"
      && annotation.startSec === 0
      && annotation.endSec === 0
    ));
    if (existingWholeNote) {
      updateAnnotation(db, existingWholeNote.id, { label: diaryNote.label });
    } else {
      insertAnnotation(db, move.sampleId, {
        startSec: 0,
        endSec: 0,
        label: diaryNote.label,
        source: "note",
      });
    }
    if (keepInDiary) deleteDiaryNote(db, entry.id);
  }
  const reviewFragments = sampleCreated ? hitMetadataReviewFragments(hitMeta) : [];
  if (reviewFragments.length > 0) {
    // timestamps[i] is the end anchor of the detection window, so the
    // fragment starts one padding margin before it.
    for (const fragment of reviewFragments) {
      insertAnnotation(db, move.sampleId, fragment);
    }
    log(`Created ${reviewFragments.length} review annotation(s) for new sample ${move.sampleId}`);
  }
  await refreshSamplesIndex();

  // The sample is now complete and visible. Finish the destructive half of a
  // move last; leftover source objects are harmless and cleanup is retry-safe.
  if (!keepInDiary) {
    deleteDiaryEntryRow(db, entry.id);
    deleteHitMetadataRow(db, entry.id);
    for (const objectKey of new Set([entry.audioPath, entry.waveformPath, move.sourceKey].filter(Boolean))) {
      try {
        await removeObject(mc, CFG.bucket, objectKey);
      } catch (e) {
        warn(`move diary to samples: could not remove source object "${objectKey}": ${e.message}`);
      }
    }
  }

  // Best-effort legacy index maintenance; SQLite is the diary source of truth.
  if (!keepInDiary) {
    try {
      const indexEntries = await loadJson(mc, CFG.bucket, CFG.indexKey, []);
      const filtered = indexEntries.filter(e => e.id !== entry.id);
      if (filtered.length !== indexEntries.length) await saveJson(mc, CFG.bucket, CFG.indexKey, filtered);
    } catch (e) {
      warn(`move diary to samples: failed to update index.json: ${e.message}`);
    }
  }

  log(`${keepInDiary ? 'Copied' : 'Moved'} diary entry ${entry.id} -> ${move.destinationKey}`);
  return {
    sampleId: move.sampleId,
    filename: move.filename,
    audioPath: move.destinationKey,
    waveformPath: move.waveformKey,
    label: move.label,
    alreadyMoved: !sampleCreated,
  };
});

// Regenerate the waveform for a training sample at a higher pixels-per-second
// resolution, replacing the existing waveform object in MinIO and updating the DB.
privateApi.post("/api/samples/:id/regenerate-waveform", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }

  const ALLOWED_PPS = [20, 50, 100];
  const pps = Number(req.body?.pixelsPerSecond);
  if (!ALLOWED_PPS.includes(pps)) {
    reply.code(400);
    return { error: `pixelsPerSecond must be one of: ${ALLOWED_PPS.join(", ")}` };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-regen-"));
  try {
    const filename = path.basename(sample.audioPath);
    const tmpAudio    = path.join(tmpDir, filename);
    const tmpWaveform = path.join(tmpDir, `${sample.id}.json`);

    await download(mc, CFG.bucket, sample.audioPath, tmpAudio);

    if (!generateWaveform(CFG.audiowaveformBin, tmpAudio, tmpWaveform, 16, pps)) {
      reply.code(500);
      return { error: "audiowaveform failed" };
    }

    const waveformKey = `${CFG.samplesWavePrefix}${sample.label}/${sample.id}.json`;
    await upload(mc, CFG.bucket, tmpWaveform, waveformKey, "application/json");

    upsertSample(db, { ...sample, waveformPath: waveformKey });

    log(`Regenerated waveform for ${sample.id} at ${pps} px/s`);
    return { waveformPath: waveformKey };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Training samples (read-only) ────────────────────────────────────────────

publicApi.get("/api/samples", async (req) => {
  const label = typeof req.query.label === "string" ? req.query.label : undefined;
  return listSamples(db, { label });
});

publicApi.get("/api/samples/:id", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }
  return sample;
});

publicApi.get("/api/samples/:id/annotations", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }
  return listAnnotations(db, req.params.id);
});

// All annotations across all active samples, in one request — for laptop-side
// training export tools (tools/export_fragments.py in barktown-goblin) that
// need to sync the whole corpus without one request per sample.
publicApi.get("/api/annotations", async () => {
  return listAllAnnotations(db);
});

// ─── Training samples (mutating) ─────────────────────────────────────────

// Delete a sample: removes the audio + waveform objects from MinIO, the DB
// row (annotations cascade), and regenerates training-samples-index.json.
privateApi.delete("/api/samples/:id", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }

  try {
    await removeObject(mc, CFG.bucket, sample.audioPath);
  } catch (e) {
    warn(`delete: could not remove audio object "${sample.audioPath}": ${e.message}`);
  }
  if (sample.waveformPath) {
    try {
      await removeObject(mc, CFG.bucket, sample.waveformPath);
    } catch (e) {
      warn(`delete: could not remove waveform object "${sample.waveformPath}": ${e.message}`);
    }
  }

  deleteSampleRow(db, sample.id);
  await refreshSamplesIndex();
  log(`Deleted sample ${sample.id}`);

  return reply.code(204).send();
});

// Rename/move a sample to a different category (label). This changes the
// filename (label is embedded in it), the sample id (derived from the
// filename), and the audio/waveform object keys, moving the underlying
// MinIO objects to match.
privateApi.patch("/api/samples/:id", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }

  const newLabel = typeof req.body?.label === "string" ? req.body.label.trim().toLowerCase() : "";
  if (!/^[a-z]+$/.test(newLabel)) {
    reply.code(400);
    return { error: "label must be one or more lowercase letters (a-z)" };
  }
  if (newLabel === sample.label) {
    return sample;
  }

  // Rebuild the filename with the new label, reusing the original timestamp.
  const [datePart, timePart] = sample.datetimeLocal.split("T");
  const newFilename = `${datePart} ${timePart.replace(/:/g, "-")} SAMPLE ${newLabel}.wav`;
  const parsedNew = parseSampleFilename(newFilename);
  if (!parsedNew) {
    reply.code(500);
    return { error: "failed to construct new filename" };
  }

  const newAudioKey = `${CFG.samplesPrefix}${newLabel}/${newFilename}`;
  const newWaveformKey = sample.waveformPath
    ? `${CFG.samplesWavePrefix}${newLabel}/${parsedNew.id}.json`
    : null;

  try {
    await copyObject(mc, CFG.bucket, sample.audioPath, newAudioKey);
    await removeObject(mc, CFG.bucket, sample.audioPath);
    if (sample.waveformPath) {
      await copyObject(mc, CFG.bucket, sample.waveformPath, newWaveformKey);
      await removeObject(mc, CFG.bucket, sample.waveformPath);
    }
  } catch (e) {
    err(`rename: MinIO move failed for ${sample.id}: ${e.message}`);
    reply.code(502);
    return { error: `failed to move objects in MinIO: ${e.message}` };
  }

  renameSampleTransaction(db, sample.id, {
    id: parsedNew.id,
    filename: newFilename,
    audioPath: newAudioKey,
    waveformPath: newWaveformKey,
    label: newLabel,
    date: parsedNew.date,
    datetimeLocal: parsedNew.datetimeLocal,
    durationSec: sample.durationSec,
  });
  await refreshSamplesIndex();
  log(`Renamed sample ${sample.id} -> ${parsedNew.id} (label: ${sample.label} -> ${newLabel})`);

  return getSample(db, parsedNew.id);
});

// ─── Annotations (mutating) ────────────────────────────────────────────────

privateApi.post("/api/samples/:id/annotations", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }

  const { startSec, endSec, label, source } = req.body ?? {};
  const validationError = validateAnnotationInput({ startSec, endSec, label }, sample.durationSec);
  if (validationError) {
    reply.code(400);
    return { error: validationError };
  }

  const annotation = insertAnnotation(db, sample.id, {
    startSec, endSec, label: label.trim(), source: source || "manual",
  });
  reply.code(201);
  return annotation;
});

privateApi.patch("/api/annotations/:annotationId", async (req, reply) => {
  const annotationId = Number(req.params.annotationId);
  const existing = getAnnotation(db, annotationId);
  if (!existing) {
    reply.code(404);
    return { error: "not found" };
  }

  const sample = getSample(db, existing.sampleId);
  const merged = {
    startSec: req.body?.startSec ?? existing.startSec,
    endSec: req.body?.endSec ?? existing.endSec,
    label: req.body?.label ?? existing.label,
  };
  const validationError = validateAnnotationInput(merged, sample?.durationSec);
  if (validationError) {
    reply.code(400);
    return { error: validationError };
  }

  return updateAnnotation(db, annotationId, merged);
});

privateApi.delete("/api/annotations/:annotationId", async (req, reply) => {
  const annotationId = Number(req.params.annotationId);
  const existing = getAnnotation(db, annotationId);
  if (!existing) {
    reply.code(404);
    return { error: "not found" };
  }

  deleteAnnotationRow(db, annotationId);
  return reply.code(204).send();
});

// ─── Entry point ──────────────────────────────────────────────────────────────

const serviceName = isPublicApi ? "barktown-api" : "barktown-api-private";
const port = parseInt(
  isPublicApi
    ? (process.env.PUBLIC_API_PORT ?? "8091")
    : (process.env.PRIVATE_API_PORT ?? process.env.API_PORT ?? "8090"),
  10,
);
const host = isPublicApi
  ? (process.env.PUBLIC_API_HOST ?? "127.0.0.1")
  : (process.env.PRIVATE_API_HOST ?? process.env.API_HOST ?? "127.0.0.1");

try {
  await app.listen({ port, host });
  log(`${serviceName} listening on http://${host}:${port}`);
  log(`  access: ${isPublicApi ? "anonymous read-only" : "Tailnet private"}`);
  log(`  db: ${CFG.dbPath}`);
  if (!isPublicApi) log(`  re-analysis workers: ${CFG.reanalyze.concurrency}`);
} catch (e) {
  err(e);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    log(`${sig} received, shutting down...`);
    await app.close();
    db.close();
    process.exit(0);
  });
}
