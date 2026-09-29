#!/usr/bin/env node
/**
 * Bulk-migrate active training-sample waveforms to the current resolution.
 *
 * SQLite is the source of truth. The script never discovers samples by
 * scanning object storage and never changes sample rows. It reads every active
 * sample, skips waveform JSON already at the target resolution, regenerates
 * the remainder in place, then republishes the compatibility index from DB.
 *
 * The default is a read-only dry run:
 *   node rebuild-samples-index.mjs
 *   node rebuild-samples-index.mjs --apply
 *   node rebuild-samples-index.mjs --apply --force
 *   node rebuild-samples-index.mjs --apply --limit 100
 */

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import { buildConfig } from "./lib/config.mjs";
import {
  DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
  generateWaveform,
} from "./lib/audio.mjs";
import {
  createClient,
  download,
  loadJson,
  saveJson,
  upload,
} from "./lib/minio.mjs";
import {
  exportSamplesIndexJson,
  listActiveSamples,
  openReadonlyDb,
} from "./lib/db.mjs";

function usage() {
  return [
    "Usage: node rebuild-samples-index.mjs [options]",
    "",
    "Bulk-migrate active training-sample waveforms using SQLite as source of truth.",
    "Without --apply, only report what would change.",
    "",
    "Options:",
    "  --apply       Regenerate and overwrite waveforms that are not at the target resolution",
    "  --force       Regenerate every selected waveform, including matching ones",
    "  --limit N     Inspect at most the first N active samples",
    "  --help        Show this help",
  ].join("\n");
}

export function parseWaveformMigrationArgs(args) {
  const options = {
    apply: false,
    force: false,
    help: false,
    limit: Infinity,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--limit") {
      const value = Number.parseInt(args[++i], 10);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("--limit requires a positive integer");
      }
      options.limit = value;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

/**
 * Read audiowaveform's effective pixels-per-second metadata.
 * Older/alternate writers may expose the direct value; standard
 * audiowaveform JSON derives it from sample_rate / samples_per_pixel.
 */
export function waveformPixelsPerSecond(waveform) {
  if (!waveform || typeof waveform !== "object") return null;
  const direct = Number(
    waveform.pixels_per_second
    ?? waveform.pixelsPerSecond,
  );
  if (Number.isFinite(direct) && direct > 0) return direct;

  const sampleRate = Number(waveform.sample_rate ?? waveform.sampleRate);
  const samplesPerPixel = Number(
    waveform.samples_per_pixel
    ?? waveform.samplesPerPixel,
  );
  if (
    !Number.isFinite(sampleRate)
    || sampleRate <= 0
    || !Number.isFinite(samplesPerPixel)
    || samplesPerPixel <= 0
  ) return null;
  return sampleRate / samplesPerPixel;
}

function isTargetResolution(value, target) {
  return Number.isFinite(value) && Math.abs(value - target) < 0.01;
}

function resolutionDescription(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} px/s` : "unknown resolution";
}

function timestamp() {
  return new Date().toISOString();
}

function log(...values) {
  console.log(`[${timestamp()}]`, ...values);
}

function error(...values) {
  console.error(`[${timestamp()}] ERROR`, ...values);
}

async function readExistingWaveform(mc, cfg, waveformPath) {
  if (!waveformPath) return { waveform: null, readError: null };
  try {
    return {
      waveform: await loadJson(mc, cfg.bucket, waveformPath, null),
      readError: null,
    };
  } catch (readError) {
    return { waveform: null, readError };
  }
}

async function regenerateSampleWaveform(mc, cfg, sample, targetPps) {
  if (!sample.audioPath) throw new Error("sample has no audioPath");
  if (!sample.waveformPath) throw new Error("sample has no waveformPath");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-waveform-migration-"));
  try {
    const extension = path.extname(sample.audioPath) || ".audio";
    const tmpAudio = path.join(tmpDir, `${sample.id}${extension}`);
    const tmpWaveform = path.join(tmpDir, `${sample.id}.json`);
    await download(mc, cfg.bucket, sample.audioPath, tmpAudio);
    if (!generateWaveform(
      cfg.audiowaveformBin,
      tmpAudio,
      tmpWaveform,
      16,
      targetPps,
    )) {
      throw new Error("audiowaveform failed");
    }

    const generated = JSON.parse(fs.readFileSync(tmpWaveform, "utf8"));
    const generatedPps = waveformPixelsPerSecond(generated);
    if (!isTargetResolution(generatedPps, targetPps)) {
      throw new Error(
        `generated waveform reports ${resolutionDescription(generatedPps)}, expected ${targetPps} px/s`,
      );
    }

    // MinIO object replacement is atomic: the existing object remains
    // available until this complete generated file is successfully uploaded.
    await upload(mc, cfg.bucket, tmpWaveform, sample.waveformPath, "application/json");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseWaveformMigrationArgs(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const cfg = buildConfig();
  const targetPps = DEFAULT_WAVEFORM_PIXELS_PER_SECOND;
  const mc = createClient(cfg.minio);
  const db = openReadonlyDb(cfg.dbPath);
  const counts = {
    inspected: 0,
    matching: 0,
    planned: 0,
    updated: 0,
    failed: 0,
  };

  try {
    if (!await mc.bucketExists(cfg.bucket)) {
      throw new Error(`bucket does not exist: ${cfg.bucket}`);
    }

    const allSamples = listActiveSamples(db);
    const samples = allSamples.slice(0, options.limit);
    log(`Training waveform migration to ${targetPps} px/s`);
    log(`Mode: ${options.apply ? "APPLY" : "DRY RUN"}${options.force ? " (force all)" : ""}`);
    log(`Active samples: ${allSamples.length}; inspecting: ${samples.length}`);

    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const prefix = `[${index + 1}/${samples.length}] ${sample.id}`;
      counts.inspected++;

      if (!sample.waveformPath) {
        counts.failed++;
        error(`${prefix}: no waveformPath in SQLite; skipped`);
        continue;
      }

      const { waveform, readError } = await readExistingWaveform(mc, cfg, sample.waveformPath);
      const existingPps = waveformPixelsPerSecond(waveform);
      if (!options.force && isTargetResolution(existingPps, targetPps)) {
        counts.matching++;
        log(`${prefix}: SKIP already ${targetPps} px/s`);
        continue;
      }

      counts.planned++;
      const reason = options.force
        ? "forced"
        : readError
          ? `unreadable waveform: ${readError.message}`
          : waveform
            ? resolutionDescription(existingPps)
            : "missing waveform";

      if (!options.apply) {
        log(`${prefix}: WOULD UPDATE (${reason})`);
        continue;
      }

      try {
        await regenerateSampleWaveform(mc, cfg, sample, targetPps);
        counts.updated++;
        log(`${prefix}: UPDATED from ${reason}`);
      } catch (migrationError) {
        counts.failed++;
        error(`${prefix}: ${migrationError.message}`);
      }
    }

    if (options.apply) {
      await saveJson(
        mc,
        cfg.bucket,
        cfg.samplesIndexKey,
        exportSamplesIndexJson(db),
      );
      log(`Republished ${cfg.samplesIndexKey} from SQLite`);
    }

    log(
      `Done: inspected=${counts.inspected}, matching=${counts.matching}, `
      + `planned=${counts.planned}, updated=${counts.updated}, failed=${counts.failed}`,
    );
    return counts.failed > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (migrationError) => {
      error(migrationError.stack ?? migrationError.message);
      process.exitCode = 1;
    },
  );
}
