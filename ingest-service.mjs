#!/usr/bin/env node
/**
 * barktown — MinIO ingest service
 *
 * Watches the `<BUCKET>/upload-here/` prefix for freshly uploaded .m4a / .aac files.
 * For each stable, correctly-named file it:
 *   1. Validates the filename pattern  YYYY-MM-DD HH-MM-SS optional comment.ext
 *   2. Downloads the file to a temp directory
 *   3. Reads duration with ffprobe
 *   4. Generates a waveform JSON with audiowaveform (skipped for very short clips)
 *   5. Uploads waveform to  <BUCKET>/waveforms/YYYY/MM/<id>.json
 *   6. Copies audio to      <BUCKET>/audio/YYYY/MM/<filename>
 *   7. Removes it from      <BUCKET>/upload-here/<filename>
 *   8. Appends the entry to <BUCKET>/index.json
 *
 * Files whose names don't match the pattern are left in /upload-here/ untouched.
 *
 * ─── Configuration ────────────────────────────────────────────────────────────
 *
 * All settings can be overridden with environment variables.
 *
 *  MINIO_ENDPOINT          MinIO host                  (default: localhost)
 *  MINIO_PORT              MinIO port                  (default: 9000)
 *  MINIO_USE_SSL           Use HTTPS?  true/false      (default: false)
 *  MINIO_ACCESS_KEY        Access key                  (default: minioadmin)
 *  MINIO_SECRET_KEY        Secret key                  (default: minioadmin)
 *  MINIO_BUCKET            Bucket name                 (default: barktown)
 *
 *  POLL_INTERVAL_MS        How often to scan /upload-here/  (default: 20000)
 *  STABILITY_DELAY_MS      Idle time before processing (default: 30000)
 *
 *  FFPROBE_BIN             ffprobe binary              (default: ffprobe)
 *  AUDIOWAVEFORM_BIN       audiowaveform binary        (default: audiowaveform)
 *
 *  WAVEFORM_THRESHOLD_SEC  Min duration for waveform   (default: 5)
 *
 * ─── Running ──────────────────────────────────────────────────────────────────
 *
 *   node ingest-service.mjs
 *   npm start
 *
 * As a systemd service, copy barktown-ingest.service to /etc/systemd/system/
 * and edit the Environment lines before enabling it.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import { buildConfig } from "./lib/config.mjs";
import {
  createClient, listObjects, download, upload, copyObject, removeObject,
  loadJson, saveJson,
} from "./lib/minio.mjs";
import { getDuration, convertToWav, convertWavToMp3, generateWaveform } from "./lib/audio.mjs";
import { parseFilename, parseShortFilename, parseSampleFilename } from "./lib/filenames.mjs";
import { openDb, upsertSample, exportSamplesIndexJson, upsertDiaryEntry } from "./lib/db.mjs";
import { log, warn, err } from "./lib/log.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const CFG = buildConfig();

// ─── MinIO client + local database ───────────────────────────────────────────

const mc = createClient(CFG.minio);
const db = openDb(CFG.dbPath);

/** Download index.json, parse, return array. Returns [] if not found. */
async function loadIndex() {
  return loadJson(mc, CFG.bucket, CFG.indexKey, []);
}

/** Write the entries array to index.json in the bucket. */
async function saveIndex(entries) {
  await saveJson(mc, CFG.bucket, CFG.indexKey, entries);
}

/** Regenerate training-samples-index.json in the bucket from the SQLite DB. */
async function saveSamplesIndex() {
  await saveJson(mc, CFG.bucket, CFG.samplesIndexKey, exportSamplesIndexJson(db));
}

// ─── Stability tracking ───────────────────────────────────────────────────────
//
// seenMap: objectKey → { etag, size, stableAt }
// A file is considered "stable" (upload complete) when its etag+size has not
// changed for at least STABILITY_DELAY_MS milliseconds.

const seenMap        = new Map();
const seenSamplesMap = new Map();

/** Keys currently being processed — prevents duplicate concurrent work. */
const inProgress        = new Set();
const inProgressSamples = new Set();

function updateSeen(objects) {
  const now      = Date.now();
  const liveKeys = new Set(objects.map(o => o.name));

  for (const key of seenMap.keys()) {
    if (!liveKeys.has(key)) seenMap.delete(key);
  }

  for (const obj of objects) {
    const prev    = seenMap.get(obj.name);
    const changed = !prev || prev.etag !== obj.etag || prev.size !== obj.size;
    if (changed) {
      seenMap.set(obj.name, { etag: obj.etag, size: obj.size, stableAt: now });
    }
  }
}

function stableObjects(objects) {
  const threshold = Date.now() - CFG.stabilityDelayMs;
  return objects.filter(obj => {
    const seen = seenMap.get(obj.name);
    return seen && seen.stableAt <= threshold;
  });
}

// ─── Process one training sample ─────────────────────────────────────────────
//
// Filename expected: YYYY-MM-DD HH-MM-SS SAMPLE <label>.wav
// (produced by barktown-goblin recorder.py)
//
// Object key layout:
//   training-samples/<label>/YYYY-MM-DD HH-MM-SS SAMPLE <label>.wav
//   training-samples-waveforms/<label>/<id>.json
//
// Metadata is stored in SQLite (lib/db.mjs); training-samples-index.json is
// regenerated from the DB after each update for backwards compatibility with
// the barktown client (GoblinPiStatus.svelte), which fetches it directly
// from the public bucket.

async function processTrainingSample(obj) {
  const filename  = path.basename(obj.name);
  const objectKey = obj.name;

  if (inProgressSamples.has(objectKey)) return;
  inProgressSamples.add(objectKey);
  log(`[samples] Processing: ${filename}`);

  const parsed = parseSampleFilename(filename);
  if (!parsed) {
    warn(`[samples] Filename does not match pattern — skipping: "${filename}"`);
    inProgressSamples.delete(objectKey);
    return;
  }

  const { date, datetimeLocal, label, id } = parsed;
  const [yyyy, mm] = date.split("-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-sample-"));

  try {
    // Download WAV.
    const tmpWav = path.join(tmpDir, filename);
    await download(mc, CFG.bucket, objectKey, tmpWav);
    log(`[samples]   down: ${filename}`);

    const durationSec = getDuration(CFG.ffprobeBin, tmpWav);
    log(`[samples]   duration: ${durationSec.toFixed(2)}s  label: ${label}`);

    // Waveform (always generated — samples are short enough to be worth it).
    let waveformPath = null;
    if (durationSec >= 1) {
      const waveformFilename = `${id}.json`;
      const tmpWaveform      = path.join(tmpDir, waveformFilename);
      if (generateWaveform(CFG.audiowaveformBin, tmpWav, tmpWaveform, 16, 50)) {
        const waveformKey = `${CFG.samplesWavePrefix}${label}/${waveformFilename}`;
        await upload(mc, CFG.bucket, tmpWaveform, waveformKey, "application/json");
        waveformPath = waveformKey;
        log(`[samples]   wave -> ${waveformKey}`);
      } else {
        warn(`[samples]   waveform skipped (audiowaveform failed)`);
      }
    }

    // Upsert into SQLite, then regenerate training-samples-index.json.
    const entry = {
      id, filename,
      audioPath: objectKey,
      waveformPath,
      date, datetimeLocal, label,
      durationSec: parseFloat(durationSec.toFixed(3)),
    };

    upsertSample(db, entry);
    await saveSamplesIndex();
    log(`[samples]   db + index updated (label=${label})`);

    seenSamplesMap.delete(objectKey);
  } finally {
    inProgressSamples.delete(objectKey);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Poll loop — training samples ────────────────────────────────────────────

let _pollingSamples = false;

async function pollTrainingSamples() {
  if (_pollingSamples) return;
  _pollingSamples = true;
  try {
    let objects;
    try {
      objects = await listObjects(mc, CFG.bucket, CFG.samplesPrefix);
    } catch (e) {
      err(`[samples] listObjects failed: ${e.message}`);
      return;
    }

    const files = objects.filter(o => !o.name.endsWith("/") && o.size > 0);
    if (files.length === 0) return;

    // Stability tracking (reuses the same logic, separate map).
    const now = Date.now();
    const liveKeys = new Set(files.map(o => o.name));
    for (const key of seenSamplesMap.keys()) {
      if (!liveKeys.has(key)) seenSamplesMap.delete(key);
    }
    for (const obj of files) {
      const prev    = seenSamplesMap.get(obj.name);
      const changed = !prev || prev.etag !== obj.etag || prev.size !== obj.size;
      if (changed) seenSamplesMap.set(obj.name, { etag: obj.etag, size: obj.size, stableAt: now });
    }

    const threshold = now - CFG.stabilityDelayMs;
    const ready = files.filter(obj => {
      const seen = seenSamplesMap.get(obj.name);
      return seen && seen.stableAt <= threshold && !inProgressSamples.has(obj.name);
    });
    if (ready.length === 0) return;

    log(`[samples] ${ready.length} stable file(s) ready.`);
    for (const obj of ready) {
      try {
        await processTrainingSample(obj);
      } catch (e) {
        err(`[samples] Failed to process "${obj.name}": ${e.message}`);
      }
    }
  } finally {
    _pollingSamples = false;
  }
}

// ─── Process one file ─────────────────────────────────────────────────────────

async function processFile(obj) {
  const filename  = path.basename(obj.name);
  const objectKey = obj.name;

  if (inProgress.has(objectKey)) {
    return; // already being handled by a concurrent poll tick
  }
  inProgress.add(objectKey);
  log(`Processing: ${filename}`);

  let parsed = parseFilename(filename);
  let destFilename = filename;

  if (!parsed) {
    const shortParsed = parseShortFilename(filename);
    if (shortParsed) {
      const { normalisedFilename, ...rest } = shortParsed;
      parsed = rest;
      destFilename = normalisedFilename;
      log(`  ↻ normalised filename: "${filename}" → "${destFilename}"`);
    }
  }

  if (!parsed) {
    warn(`Filename does not match pattern — leaving in /upload-here/: "${filename}"`);
    inProgress.delete(objectKey);
    return;
  }

  const { date, time, datetimeLocal, label, id } = parsed;
  const [yyyy, mm] = date.split("-");
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-"));

  try {
    // Download.
    const tmpAudio = path.join(tmpDir, filename);
    await download(mc, CFG.bucket, objectKey, tmpAudio);
    log(`  ↓ downloaded`);

    // WAV pre-processing: boost volume, compress to MP3, embed metadata.
    // The converted file replaces tmpAudio for all downstream steps and the
    // destination filename is updated to .mp3.  The original WAV object key
    // is still what gets removed from upload-here/ at the end.
    let processedAudio = tmpAudio;
    let waveformSource = tmpAudio; // waveform is always built from the pre-boost original
    let needsUpload = false; // true → upload local file; false → MinIO copyObject
    let archiveFilename = null;
    let sourceWavPath = null;
    let sourceWavEtag = null;
    if (filename.toLowerCase().endsWith(".wav")) {
      // Archive under the same normalized stem used by the diary audio path.
      // archiveSourceKeyForEntry() can then deterministically derive the WAV
      // key even when the upload arrived with a short voice-recorder name.
      archiveFilename = destFilename.replace(/\.wav$/i, ".wav");
      const mp3Filename = destFilename.replace(/\.wav$/i, ".mp3");
      const tmpMp3      = path.join(tmpDir, mp3Filename);
      const ok = convertWavToMp3(CFG.ffmpegBin, tmpAudio, tmpMp3, {
        volumePct: CFG.wavVolumeBoostPct,
        bitrate:   CFG.wavMp3Bitrate,
        metadata: {
          title:            label || `Bark recording ${datetimeLocal}`,
          date,
          datetime:         datetimeLocal,
          location:         CFG.recordingLocation  || undefined,
          direction:        CFG.recordingDirection || undefined,
          artist:           CFG.recordingArtist    || undefined,
          album:            CFG.recordingAlbum     || undefined,
          copyright:        CFG.recordingCopyright || undefined,
          appUrl:           CFG.barktownUrl ? `${CFG.barktownUrl}/#${id}` : undefined,
          originalFilename: filename,
        },
      });
      if (!ok) throw new Error(`ffmpeg WAV→MP3 failed for "${filename}"`);
      processedAudio = tmpMp3;
      destFilename   = mp3Filename;
      needsUpload    = true;
      log(`  ♻ WAV→MP3 (${CFG.wavVolumeBoostPct}% vol, ${CFG.wavMp3Bitrate}kbps) → "${destFilename}"`);
    }

    // Duration + kind.
    const durationSec = getDuration(CFG.ffprobeBin, processedAudio);
    const kind =
      durationSec < CFG.waveformThreshSec ? "note"
      : "audio";
    log(`  duration: ${durationSec.toFixed(2)}s  kind: ${kind}`);
    // Waveform.
    let waveformPath = null;
    if (kind === "audio") {
      const waveformFilename = `${id}.json`;
      const tmpWaveform      = path.join(tmpDir, waveformFilename);
      // Use the pre-boost original (waveformSource) so volume amplification
      // and MP3 compression artefacts don't distort the waveform shape.
      // If waveformSource is already a WAV, pass it directly — audiowaveform
      // supports WAV natively and resampling to 16 kHz would discard detail
      // and cause all-zero output on quiet recordings at 8-bit resolution.
      // For m4a/aac/mp3 a WAV intermediate is still required.
      let waveformInput = waveformSource;
      if (!/\.wav$/i.test(waveformSource)) {
        const tmpWav = path.join(tmpDir, `${id}.wav`);
        if (!convertToWav(waveformSource, tmpWav)) {
          throw new Error(`ffmpeg WAV conversion failed for "${filename}" — leaving in upload-here/`);
        }
        waveformInput = tmpWav;
      }
      if (!generateWaveform(CFG.audiowaveformBin, waveformInput, tmpWaveform, 16, 50)) {
        throw new Error(`audiowaveform failed for "${filename}" — leaving in upload-here/`);
      }
      const waveformKey = `${CFG.waveformPrefix}${yyyy}/${mm}/${waveformFilename}`;
      await upload(mc, CFG.bucket, tmpWaveform, waveformKey, "application/json");
      waveformPath = waveformKey;
      log(`  ↑ waveform → ${waveformKey}`);
    }

    // Move audio to audio/YYYY/MM/, then remove from upload-here/.
    // WAV→MP3 conversions are uploaded as a new object (different content
    // and key); other formats are copied server-side within MinIO.
    // Original WAV files are moved to archivePrefix instead of deleted.
    const audioKey = `${CFG.audioPrefix}${yyyy}/${mm}/${destFilename}`;
    if (needsUpload) {
      await upload(mc, CFG.bucket, processedAudio, audioKey, "audio/mpeg");
      const archiveKey = `${CFG.archivePrefix}${yyyy}/${mm}/${archiveFilename}`;
      await copyObject(mc, CFG.bucket, objectKey, archiveKey);
      sourceWavPath = archiveKey;
      sourceWavEtag = obj.etag ?? null;
      await removeObject(mc, CFG.bucket, objectKey);
      log(`  ⇒ audio   → ${audioKey}`);
      log(`  ⇒ archive → ${archiveKey}`);
    } else {
      await copyObject(mc, CFG.bucket, objectKey, audioKey);
      await removeObject(mc, CFG.bucket, objectKey);
      log(`  ⇒ audio   → ${audioKey}`);
    }

    // Build entry object (shared between DB upsert and index.json).
    const entry = {
      id, filename: destFilename,
      audioPath: audioKey,
      waveformPath,
      date, time, datetimeLocal, label,
      durationSec: parseFloat(durationSec.toFixed(3)),
      kind,
      sourceWavPath,
      sourceWavEtag,
    };

    // Upsert into SQLite diary_entries (source of truth).
    upsertDiaryEntry(db, entry);
    log(`  ✓ diary DB  (id=${id})`);

    // Also keep index.json in sync for backwards compatibility.
    const entries = await loadIndex();
    const idx = entries.findIndex(e => e.id === id);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
      entries.sort((a, b) => a.datetimeLocal.localeCompare(b.datetimeLocal));
    }
    await saveIndex(entries);
    log(`  ✓ index.json  (${entries.length} entries total)`);

    seenMap.delete(objectKey);
  } finally {
    inProgress.delete(objectKey);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

let _polling = false;

async function poll() {
  if (_polling) {
    log(`Poll skipped — previous poll still running (${inProgress.size} file(s) in progress).`);
    return;
  }
  _polling = true;
  try {
    await _poll();
  } finally {
    _polling = false;
  }
}

async function _poll() {
  let objects;
  try {
    objects = await listObjects(mc, CFG.bucket, CFG.newPrefix);
  } catch (e) {
    err(`listObjects failed: ${e.message}`);
    return;
  }

  // Discard 0-byte objects (failed/partial uploads) — remove silently.
  for (const o of objects) {
    if (!o.name.endsWith("/") && o.size === 0) {
      warn(`Removing 0-byte file (failed upload?): ${path.basename(o.name)}`);
      try { await removeObject(mc, CFG.bucket, o.name); } catch { /* best-effort */ }
      seenMap.delete(o.name);
    }
  }

  const files = objects.filter(o => !o.name.endsWith("/") && o.size > 0);
  if (files.length === 0) return;

  updateSeen(files);

  const ready = stableObjects(files);
  if (ready.length === 0) {
    log(`${files.length} file(s) in /upload-here/ — waiting for stability...`);
    return;
  }

  // Skip files already being processed by a previous (still-running) tick.
  const toProcess = ready.filter(obj => !inProgress.has(obj.name));
  const skipped   = ready.length - toProcess.length;
  if (skipped > 0) log(`${skipped} file(s) already in progress — skipping.`);
  if (toProcess.length === 0) return;

  log(`${toProcess.length} stable file(s) ready.`);

  for (const obj of toProcess) {
    try {
      await processFile(obj);
    } catch (e) {
      err(`Failed to process "${obj.name}": ${e.message}`);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  log("barktown ingest-service starting");
  log(`  MinIO  : ${CFG.minio.useSSL ? "https" : "http"}://${CFG.minio.endPoint}:${CFG.minio.port}`);
  log(`  bucket : ${CFG.bucket}`);
  log(`  db     : ${CFG.dbPath}`);
  log(`  poll   : every ${CFG.pollIntervalMs / 1000}s`);
  log(`  stable : after ${CFG.stabilityDelayMs / 1000}s of no change`);

  try {
    if (!(await mc.bucketExists(CFG.bucket))) {
      err(`Bucket "${CFG.bucket}" does not exist. Create it first.`);
      process.exit(1);
    }
    log(`  connected ✓`);
  } catch (e) {
    err(`Cannot connect to MinIO: ${e.message}`);
    process.exit(1);
  }

  await poll();
  await pollTrainingSamples();
  setInterval(poll, CFG.pollIntervalMs);
  setInterval(pollTrainingSamples, CFG.pollIntervalMs);
}

main().catch(e => { err(e); process.exit(1); });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, closing database...`);
    db.close();
    process.exit(0);
  });
}
