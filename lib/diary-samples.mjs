import path from "path";
import { SAMPLE_LABELS } from "./sample-labels.mjs";

const SAMPLE_LABEL_SET = new Set(SAMPLE_LABELS);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Derive the MinIO key of a diary entry's archived, uncompressed source WAV:
 * it mirrors the diary audio path, except that it lives below
 * uncompressed-uploads-archive/ (cfg.archivePrefix) instead of audio/
 * (cfg.audioPrefix), and is always the original .wav.
 */
export function archiveSourceKeyForEntry(entry, cfg) {
  const audioPath = typeof entry?.audioPath === "string" ? entry.audioPath : "";
  if (!audioPath.startsWith(cfg.audioPrefix)) {
    throw new Error(`diary audio path must be below ${cfg.audioPrefix}`);
  }

  const relativeAudioPath = audioPath.slice(cfg.audioPrefix.length);
  if (!relativeAudioPath || path.posix.basename(relativeAudioPath) === relativeAudioPath) {
    throw new Error("diary audio path must include year/month directories");
  }
  const sourceRelativePath = relativeAudioPath.replace(/\.[^.\/]+$/, ".wav");
  if (sourceRelativePath === relativeAudioPath) {
    throw new Error("diary audio path must have a file extension");
  }

  return `${cfg.archivePrefix}${sourceRelativePath}`;
}

/**
 * Return the canonical source key plus the legacy short-recorder key when it
 * can be reconstructed. Older ingest releases normalized the diary filename
 * but archived short-form uploads under names such as "7 Jun at 21-54.wav".
 */
export function archiveSourceKeyCandidatesForEntry(entry, cfg) {
  const canonical = archiveSourceKeyForEntry(entry, cfg);
  const candidates = [canonical];
  if (canonical.endsWith(".wav")) candidates.push(`${canonical.slice(0, -4)}.WAV`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00$/.exec(entry?.datetimeLocal ?? "");
  if (!match) return candidates;

  const [, year, month, day, hour, minute] = match;
  const monthName = MONTH_NAMES[Number(month) - 1];
  if (!monthName) return candidates;
  const label = typeof entry?.label === "string" ? entry.label.trim() : "";
  const filename = `${Number(day)} ${monthName} at ${hour}-${minute}${label ? ` ${label}` : ""}.wav`;
  const legacy = `${cfg.archivePrefix}${year}/${month}/${filename}`;
  if (!candidates.includes(legacy)) candidates.push(legacy);
  candidates.push(`${legacy.slice(0, -4)}.WAV`);
  return candidates;
}

/**
 * Build the MinIO keys used when a diary recording is turned back into a
 * training sample. The archived source mirrors the diary audio path, except
 * that it lives below uncompressed-uploads-archive/ and is the original WAV.
 */
export function buildDiarySampleMove(entry, requestedLabel, cfg) {
  const label = typeof requestedLabel === "string"
    ? requestedLabel.trim().toLowerCase()
    : "";
  if (!SAMPLE_LABEL_SET.has(label)) {
    throw new Error(`label must be one of: ${SAMPLE_LABELS.join(", ")}`);
  }

  const sourceKey = archiveSourceKeyForEntry(entry, cfg);

  const datetimeMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(entry?.datetimeLocal ?? "");
  if (!datetimeMatch) {
    throw new Error("diary entry must have a full local timestamp");
  }
  const [, date, hh, mm, ss] = datetimeMatch;
  const filename = `${date} ${hh}-${mm}-${ss} SAMPLE ${label}.wav`;

  return {
    label,
    filename,
    sourceKey,
    destinationKey: `${cfg.samplesPrefix}${label}/${filename}`,
  };
}
