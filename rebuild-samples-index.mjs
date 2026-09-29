#!/usr/bin/env node
/**
 * barktown -- rebuild training-samples-index.json
 *
 * Scans training-samples/ in MinIO, reads duration for each WAV,
 * checks for an existing waveform in training-samples-waveforms/,
 * and writes a fresh training-samples-index.json.
 *
 * Nothing is deleted or moved. Safe to run any time.
 *
 * Usage:
 *   node rebuild-samples-index.mjs
 *   npm run rebuild-samples-index
 */

import * as Minio from "minio";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Readable } from "stream";

// --- Load .env ---------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath   = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
}

// --- Config ------------------------------------------------------------------

const CFG = {
  minio: {
    endPoint:  process.env.MINIO_ENDPOINT   ?? "localhost",
    port:      parseInt(process.env.MINIO_PORT ?? "9000", 10),
    useSSL:    (process.env.MINIO_USE_SSL   ?? "false") === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
  },
  bucket:            process.env.MINIO_BUCKET   ?? "barktown",
  samplesPrefix:     "training-samples/",
  samplesWavePrefix: "training-samples-waveforms/",
  samplesIndexKey:   "training-samples-index.json",
  ffprobeBin:        process.env.FFPROBE_BIN    ?? "ffprobe",
};

const mc = new Minio.Client(CFG.minio);

// --- Filename pattern --------------------------------------------------------
// Expected: YYYY-MM-DD HH-MM-SS SAMPLE <label>.wav

const SAMPLE_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2}) SAMPLE ([a-z]+)\.wav$/i;

function parseSampleFilename(filename) {
  const match = SAMPLE_FILENAME_RE.exec(filename);
  if (!match) return null;
  const [, datePart, hh, mm, ss, label] = match;
  const datetimeLocal = `${datePart}T${hh}:${mm}:${ss}`;
  const stem = filename.slice(0, -".wav".length);
  const id   = stem
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/, "");
  return { date: datePart, datetimeLocal, label: label.toLowerCase(), id };
}

// --- Helpers -----------------------------------------------------------------

function ts()      { return new Date().toISOString(); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
function err(...a) { console.error(`[${ts()}] ERROR`, ...a); }

async function listObjects(prefix) {
  return new Promise((resolve, reject) => {
    const objects = [];
    const stream  = mc.listObjectsV2(CFG.bucket, prefix, true);
    stream.on("data",  o  => objects.push(o));
    stream.on("end",   () => resolve(objects));
    stream.on("error", reject);
  });
}

function getDuration(filePath) {
  const r = spawnSync(
    CFG.ffprobeBin,
    ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) return 0;
  try {
    return parseFloat(JSON.parse(r.stdout).format?.duration ?? "0");
  } catch { return 0; }
}

async function uploadBuffer(data, objectKey) {
  const buf    = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const stream = Readable.from(buf);
  await mc.putObject(CFG.bucket, objectKey, stream, buf.length, { "Content-Type": "application/json" });
}

function generateWaveform(audioPath, outPath) {
  const r = spawnSync(
    process.env.AUDIOWAVEFORM_BIN ?? "audiowaveform",
    ["-i", audioPath, "-o", outPath, "--pixels-per-second", "100", "--bits", "16"],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    console.warn(`audiowaveform failed: ${r.stderr?.trim() || r.error?.message}`);
    return false;
  }
  return true;
}

// --- Main --------------------------------------------------------------------

async function main() {
  log("Rebuilding training-samples-index.json");
  log(`  MinIO : ${CFG.minio.useSSL ? "https" : "http"}://${CFG.minio.endPoint}:${CFG.minio.port}`);
  log(`  bucket: ${CFG.bucket}`);

  if (!(await mc.bucketExists(CFG.bucket))) {
    err(`Bucket "${CFG.bucket}" does not exist.`);
    process.exit(1);
  }

  // List all WAV files under training-samples/
  const allObjects = await listObjects(CFG.samplesPrefix);
  const wavFiles   = allObjects.filter(
    o => !o.name.endsWith("/") && o.name.toLowerCase().endsWith(".wav") && o.size > 0
  );
  log(`Found ${wavFiles.length} WAV file(s) in ${CFG.samplesPrefix}`);

  // Build a Set of existing waveform object keys for fast lookup
  const waveObjects  = await listObjects(CFG.samplesWavePrefix);
  const waveKeySet   = new Set(waveObjects.map(o => o.name));

  const entries = [];
  let skipped   = 0;

  for (const obj of wavFiles) {
    const filename = path.basename(obj.name);
    const parsed   = parseSampleFilename(filename);

    if (!parsed) {
      log(`  SKIP  "${filename}" — filename does not match pattern`);
      skipped++;
      continue;
    }

    const { date, datetimeLocal, label, id } = parsed;

    // Check for a pre-existing waveform — but always regenerate so we get 16-bit precision
    const waveKey = `${CFG.samplesWavePrefix}${label}/${id}.json`;
    let waveformPath = null;

    // Download to a temp file to read duration and generate waveform
    const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-rebuild-"));
    const tmpWav     = path.join(tmpDir, filename);
    const tmpWaveform = path.join(tmpDir, `${id}.json`);
    let durationSec = 0;
    try {
      await mc.fGetObject(CFG.bucket, obj.name, tmpWav);
      durationSec = getDuration(tmpWav);
      if (generateWaveform(tmpWav, tmpWaveform)) {
        await uploadBuffer(fs.readFileSync(tmpWaveform), waveKey);
        waveformPath = waveKey;
      } else {
        log(`  WARN  waveform generation failed for "${filename}"`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    entries.push({
      id, filename,
      audioPath: obj.name,
      waveformPath,
      date, datetimeLocal, label,
      durationSec: parseFloat(durationSec.toFixed(3)),
    });

    log(`  OK    ${label}  ${datetimeLocal}  ${durationSec.toFixed(1)}s${waveformPath ? "  waveform OK" : "  no waveform"}`);
  }

  // waveKeySet no longer needed — remove unused variable warning
  void waveKeySet;

  entries.sort((a, b) => a.datetimeLocal.localeCompare(b.datetimeLocal));

  await uploadBuffer(JSON.stringify(entries, null, 2) + "\n", CFG.samplesIndexKey);

  log(`Done. Wrote ${entries.length} entries to ${CFG.samplesIndexKey} (${skipped} skipped).`);
}

main().catch(e => { err(e); process.exit(1); });
