#!/usr/bin/env node
/**
 * barktown-ingest — HTTP API over the training-samples database.
 *
 * Read endpoints: list/get samples and their annotations.
 * Mutating endpoints: delete a sample, rename/move it between categories,
 * and add/edit/delete fragment annotations.
 *
 * This runs as a separate process from ingest-service.mjs (which also
 * writes to the database on new uploads). SQLite's WAL mode + a busy
 * timeout (lib/db.mjs) support multiple writers/readers across processes.
 *
 * No authentication: this is intended to be reachable only over Tailscale
 * (LAN/VLAN), same trust model as barktown-goblin's own status API.
 * Training samples are ephemeral and backed up elsewhere, so open
 * read/write access on the tailnet is an accepted tradeoff for now.
 * Add auth before exposing this beyond the tailnet, or before adding
 * mutating routes for the (non-ephemeral) diary recordings corpus.
 *
 * ─── Configuration ─────────────────────────────────────────
 *
 *  DB_PATH    Local SQLite database file   (default: ./data/barktown.db)
 *  API_HOST   Interface to bind            (default: 127.0.0.1)
 *  API_PORT   Port to listen on            (default: 8090)
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
import { createClient, copyObject, removeObject, saveJson, loadJson, download, upload } from "./lib/minio.mjs";
import { parseSampleFilename } from "./lib/filenames.mjs";
import { buildDiarySampleMove, archiveSourceKeyCandidatesForEntry } from "./lib/diary-samples.mjs";
import { runReanalyzeScript } from "./lib/reanalyze.mjs";
import {
  openDb, getSample, listSamples, listAnnotations, listAllAnnotations, exportSamplesIndexJson,
  deleteSampleRow, renameSampleTransaction,
  getAnnotation, insertAnnotation, updateAnnotation, deleteAnnotationRow,
  listDiaryEntries, getDiaryEntry, deleteDiaryEntryRow,
  upsertHitMetadata, getHitMetadata, listHitMetadataPage, deleteHitMetadataRow,
  upsertSample,
  listMonitorParams, getMonitorParamsMap, setMonitorParam,
} from "./lib/db.mjs";
import { log, warn, err } from "./lib/log.mjs";
import { generateWaveform } from "./lib/audio.mjs";

const CFG = buildConfig();
const db = openDb(CFG.dbPath);
const mc = createClient(CFG.minio);

const app = Fastify({ logger: false });
// @fastify/cors defaults `methods` to "GET,HEAD,POST" — must list the
// mutating verbs explicitly or their preflight (OPTIONS) requests get
// rejected with "CORS Method Not Found", which browsers then report as a
// generic CORS failure on the real PATCH/DELETE request.
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"] });

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
 *    one of the fixed training-sample categories.
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
  candidateThreshold: { min: 0, max: 1 },
  hitRefractoryS:     { min: 0 },
  inferenceWindowS:   { min: 0.1 },
  scoreIntervalS:     { min: 0.05 },
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

app.get("/health", async () => ({ ok: true }));
// ─── Diary entries ───────────────────────────────────────────────────────────────

// List all diary entries, ordered by datetime (oldest first).
app.get("/api/diary", async () => {
  return listDiaryEntries(db);
});

// Bulk hit metadata. Date bounds are inclusive and filter on diary_entries.date.
// Rows without a linked diary entry are included only when no date bound is used.
app.get("/api/hit-metadata", async (req, reply) => {
  const { startDate, endDate } = req.query ?? {};
  const page = parsePositiveInteger(req.query?.page, 1);
  const pageSize = parsePositiveInteger(req.query?.pageSize, MAX_HIT_METADATA_PAGE_SIZE, MAX_HIT_METADATA_PAGE_SIZE);

  if (startDate !== undefined && !isIsoDate(startDate)) {
    reply.code(400);
    return { error: "startDate must be a valid date in YYYY-MM-DD format" };
  }
  if (endDate !== undefined && !isIsoDate(endDate)) {
    reply.code(400);
    return { error: "endDate must be a valid date in YYYY-MM-DD format" };
  }
  if (startDate && endDate && startDate > endDate) {
    reply.code(400);
    return { error: "startDate must be earlier than or equal to endDate" };
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
app.get("/api/diary/:id", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }
  return entry;
});

// Get hit metadata for a diary clip (timestamps, confidences, loudnesses per bark hit).
// Returns 404 if no metadata has been submitted for this clip.
app.get("/api/diary/:id/hit-metadata", async (req, reply) => {
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
app.post("/api/diary/:id/hit-metadata", async (req, reply) => {
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

  upsertHitMetadata(db, req.params.id, {
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
  return getHitMetadata(db, req.params.id);
});

// ─── Monitor params (single source of truth for barktown-goblin's bark-monitor
// tuning, also used as this API's reanalyze defaults) ─────────────────────────

// List all monitor params (current + default value, allowed range, description).
app.get("/api/monitor-params", async () => {
  return listMonitorParams(db);
});

// Update one monitor param's current value. barktown-goblin picks this up
// next time its statusd POSTs /monitor-params/fetch (or the monitor process's
// own periodic re-check runs); this route itself only updates the DB.
app.patch("/api/monitor-params/:paramId", async (req, reply) => {
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
// inferenceWindowS, scoreIntervalS — all positive finite numbers.
app.post("/api/diary/:id/reanalyze", async (req, reply) => {
  const entry = getDiaryEntry(db, req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: "not found" };
  }

  let sourceKeys;
  try {
    sourceKeys = archiveSourceKeyCandidatesForEntry(entry, CFG);
  } catch (e) {
    reply.code(400);
    return { error: e.message };
  }

  const tuningError = validateReanalyzeTuning(req.body);
  if (tuningError) {
    reply.code(400);
    return { error: tuningError };
  }
  const monitorParams = getMonitorParamsMap(db);
  const effectiveMonitorSettings = { ...monitorParams };
  const overrideFields = {
    candidateThreshold: "candidate_threshold",
    hitRefractoryS: "hit_refractory_s",
    inferenceWindowS: "inference_window_s",
    scoreIntervalS: "score_interval_s",
  };
  for (const [bodyField, monitorField] of Object.entries(overrideFields)) {
    if (req.body?.[bodyField] !== undefined) {
      effectiveMonitorSettings[monitorField] = req.body[bodyField];
    }
  }
  const tuning = { monitorSettings: effectiveMonitorSettings };

  const tmpPath = path.join(os.tmpdir(), `reanalyze-${entry.id}-${Date.now()}.wav`);
  try {
    let sourceKey;
    try {
      for (const candidate of sourceKeys) {
        if (await statObjectIfExists(candidate)) {
          sourceKey = candidate;
          break;
        }
      }
      if (!sourceKey) {
        reply.code(502);
        return { error: `archived source not found in MinIO; checked: ${sourceKeys.join(", ")}` };
      }
      await download(mc, CFG.bucket, sourceKey, tmpPath);
    } catch (e) {
      err(`reanalyze: could not locate/download source for ${entry.id}: ${e.message}`);
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
    log(`Re-analyzed diary entry ${entry.id}: ${payload.timestamps.length} bark window(s)`);
    reply.code(201);
    return getHitMetadata(db, entry.id);
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
});

// Delete a diary entry: removes the audio + waveform objects from MinIO and
// the DB row. Returns 204 on success.
app.delete("/api/diary/:id", async (req, reply) => {
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

// Turn a false-positive diary recording into a labeled training sample.
// The sample is copied from the original, uncompressed WAV archive; the
// ingest service will notice the new training-samples/ object, generate its
// waveform, and populate the samples database in its normal poll cycle.
app.post("/api/diary/:id/move-to-samples", async (req, reply) => {
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

  // Keep the diary row until every object operation succeeds. removeObject is
  // idempotent, so a request can safely resume after a partial failure.
  const newParsed = parseSampleFilename(move.filename);
  const sampleWaveformKey = newParsed && entry.waveformPath
    ? `${CFG.samplesWavePrefix}${move.label}/${newParsed.id}.json`
    : null;
  try {
    if (!keepInDiary) {
      await removeObject(mc, CFG.bucket, entry.audioPath);
      if (entry.waveformPath) await removeObject(mc, CFG.bucket, entry.waveformPath);
    }

    if (sourceStat && !destinationStat) {
      await copyObject(mc, CFG.bucket, move.sourceKey, move.destinationKey);
    }
    if (sourceStat && !keepInDiary) await removeObject(mc, CFG.bucket, move.sourceKey);

    // Copy the diary waveform to the training-samples-waveforms path so it
    // is available immediately without waiting for the ingest service.
    if (sampleWaveformKey && entry.waveformPath) {
      try {
        await copyObject(mc, CFG.bucket, entry.waveformPath, sampleWaveformKey);
      } catch (e) {
        warn(`move diary to samples: could not copy waveform for ${entry.id}: ${e.message}`);
      }
    }
  } catch (e) {
    err(`move diary to samples: MinIO mutation failed for ${entry.id}: ${e.message}`);
    reply.code(502);
    return { error: `failed to move recording in MinIO: ${e.message}` };
  }

  if (!keepInDiary) deleteDiaryEntryRow(db, entry.id);

  // Pre-create the sample row and bark fragment annotations so they're
  // available before the ingest service processes the new WAV file.
  // The ingest service will upsert the sample later with the real durationSec.
  const hitMeta = getHitMetadata(db, entry.id);
  if (newParsed) {
    upsertSample(db, {
      id: newParsed.id,
      filename: move.filename,
      audioPath: move.destinationKey,
      waveformPath: sampleWaveformKey,
      label: move.label,
      date: newParsed.date,
      datetimeLocal: newParsed.datetimeLocal,
      durationSec: entry.durationSec ?? 0,
      diaryId: entry.id,
    });
    if (hitMeta && hitMeta.timestamps.length > 0) {
      // timestamps[i] is the *end* anchor of the detection window (see
      // AudioPlayerPanel's hx comment), not the start — so the fragment
      // must end there, with its start pushed back by the padding margin
      // goblin added around the event (config's padding_s).
      for (let i = 0; i < hitMeta.timestamps.length; i++) {
        const endSec = hitMeta.timestamps[i];
        const startSec = Math.max(0, parseFloat((endSec - hitMeta.paddingS).toFixed(3)));
        insertAnnotation(db, newParsed.id, {
          startSec,
          endSec: parseFloat(endSec.toFixed(3)),
          label: "bark",
          source: "model",
        });
      }
      log(`Created ${hitMeta.timestamps.length} bark annotation(s) for new sample ${newParsed.id}`);
    }
  }
  if (!keepInDiary) deleteHitMetadataRow(db, entry.id);

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
    filename: move.filename,
    audioPath: move.destinationKey,
    label: move.label,
  };
});

// Regenerate the waveform for a training sample at a higher pixels-per-second
// resolution, replacing the existing waveform object in MinIO and updating the DB.
app.post("/api/samples/:id/regenerate-waveform", async (req, reply) => {
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

app.get("/api/samples", async (req) => {
  const label = typeof req.query.label === "string" ? req.query.label : undefined;
  return listSamples(db, { label });
});

app.get("/api/samples/:id", async (req, reply) => {
  const sample = getSample(db, req.params.id);
  if (!sample || sample.status !== "active") {
    reply.code(404);
    return { error: "not found" };
  }
  return sample;
});

app.get("/api/samples/:id/annotations", async (req, reply) => {
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
app.get("/api/annotations", async () => {
  return listAllAnnotations(db);
});

// ─── Training samples (mutating) ─────────────────────────────────────────

// Delete a sample: removes the audio + waveform objects from MinIO, the DB
// row (annotations cascade), and regenerates training-samples-index.json.
app.delete("/api/samples/:id", async (req, reply) => {
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
app.patch("/api/samples/:id", async (req, reply) => {
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

app.post("/api/samples/:id/annotations", async (req, reply) => {
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

app.patch("/api/annotations/:annotationId", async (req, reply) => {
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

app.delete("/api/annotations/:annotationId", async (req, reply) => {
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

const port = parseInt(process.env.API_PORT ?? "8090", 10);
const host = process.env.API_HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
  log(`barktown-api listening on http://${host}:${port}`);
  log(`  db: ${CFG.dbPath}`);
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
