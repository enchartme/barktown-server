import path from 'node:path';
import { parseFilename } from './filenames.mjs';
import { sourceWavKeyCandidatesForEntry } from './diary-samples.mjs';

/** Preserve the dated path and original extension in the historical archive. */
export function historicalArchiveKey(entry, cfg) {
  if (!entry.audioPath?.startsWith(cfg.audioPrefix)) return null;
  const relative = entry.audioPath.slice(cfg.audioPrefix.length);
  if (!/^\d{4}\/\d{2}\/[^/]+\.(aac|m4a)$/i.test(relative)) return null;
  return `${cfg.historicalArchivePrefix}${relative}`;
}

export function sourceRecordingCandidates(entry, cfg) {
  const historical = historicalArchiveKey(entry, cfg);
  if (historical) return [historical, entry.audioPath];
  return sourceWavKeyCandidatesForEntry(entry, cfg);
}

export function isHistoricalRecording(entry, cfg) {
  return historicalArchiveKey(entry, cfg) !== null;
}

export function availableRecordingSource(entry, cfg, keys) {
  return sourceRecordingCandidates(entry, cfg).find(key => keys.has(key)) ?? null;
}

/** Archive once. Refuse to overwrite a different original at the same dated key. */
export async function archiveHistoricalRecording(entry, cfg, { stat, copy, sameContent }) {
  const archiveKey = historicalArchiveKey(entry, cfg);
  const archived = await stat(archiveKey);
  const original = historicalArchiveKey(entry, cfg) ? await stat(entry.audioPath) : null;
  if (archived && original) {
    const matches = archived.size === original.size && (archived.etag === original.etag
      || (sameContent && await sameContent(entry.audioPath, archiveKey)));
    if (!matches) throw new Error('Historical archive already contains a different original recording');
  }
  if (!archived) {
    if (!original) throw new Error('Original historical recording is unavailable');
    await copy(entry.audioPath, archiveKey);
    const saved = await stat(archiveKey);
    if (!saved || saved.size !== original.size) throw new Error('Could not verify the historical archive copy');
  }
  return { archiveKey, original };
}

export function historicalMp3Metadata(entry, cfg, sourceKey) {
  return {
    title: entry.label || `Bark recording ${entry.datetimeLocal}`,
    date: entry.date, datetime: entry.datetimeLocal,
    location: cfg.recordingLocation, direction: cfg.recordingDirection,
    artist: cfg.recordingArtist, album: cfg.recordingAlbum, copyright: cfg.recordingCopyright,
    appUrl: cfg.barktownUrl ? `${cfg.barktownUrl}/#${entry.id}` : undefined,
    originalFilename: path.posix.basename(sourceKey),
  };
}

/** Add elapsed audio time to a local wall-clock timestamp, without timezone conversion. */
export function localTimestampAtOffset(datetimeLocal, seconds) {
  const millis = Date.parse(`${datetimeLocal}Z`);
  if (!Number.isFinite(millis) || !Number.isFinite(seconds)
      || new Date(millis).toISOString().slice(0, 19) !== datetimeLocal) throw new Error('Invalid recording timestamp');
  return new Date(millis + Math.round(seconds * 1000)).toISOString().slice(0, 19);
}

export function planHistoricalClips(entry, cfg, payload, durationSec, monitorSettings) {
  const source = parseFilename(entry.filename);
  if (!source) throw new Error('Historical recording requires a timestamped filename');
  const events = payload.analysis_settings?.events;
  if (payload.analysis_settings?.analysis_mode !== 'historical_stream_replay' || !Array.isArray(events)) {
    throw new Error('Analyzer does not support historical stream replay; deploy Goblin first');
  }
  const padding = monitorSettings.padding_s;
  let previousEnd = -1;
  let nextHit = 0;
  const ids = new Set();
  const clips = events.map(event => {
    if (!Number.isInteger(event.hit_start_index) || !Number.isInteger(event.hit_stop_index)
        || event.hit_start_index !== nextHit || event.hit_stop_index < nextHit
        || event.hit_stop_index > payload.timestamps.length) throw new Error('Analyzer produced invalid event hit indices');
    nextHit = event.hit_stop_index;
    if (!Number.isFinite(event.start_ts) || !Number.isFinite(event.end_ts)
        || event.start_ts < 0 || event.end_ts < event.start_ts || event.end_ts > durationSec
        || event.start_ts < previousEnd) throw new Error('Analyzer produced invalid event intervals');
    previousEnd = event.end_ts;
    const stop = Math.min(durationSec, event.end_ts + padding);
    const start = Math.max(0, event.start_ts - padding, stop - monitorSettings.max_clip_s);
    if (stop <= start) throw new Error('Analyzer produced an empty event clip');
    const datetimeLocal = localTimestampAtOffset(source.datetimeLocal, start);
    const stem = `${datetimeLocal.replace('T', ' ').replaceAll(':', '-')} -A-`;
    const filename = `${stem}.mp3`;
    const identity = parseFilename(filename);
    if (ids.has(identity.id) || identity.id === entry.id) throw new Error('Historical event filenames collide');
    ids.add(identity.id);
    const folder = `${identity.date.slice(0, 4)}/${identity.date.slice(5, 7)}/`;
    const indices = payload.timestamps.slice(event.hit_start_index, event.hit_stop_index)
      .map((ts, index) => ({ ts, index: event.hit_start_index + index }))
      .filter(({ ts }) => ts >= start && ts <= stop);
    const { hit_start_index, hit_stop_index, ...eventInfo } = event;
    return {
      ...identity, filename, start, stop, durationSec: stop - start, kind: 'audio',
      audioPath: `${cfg.audioPrefix}${folder}${filename}`,
      waveformPath: `${cfg.waveformPrefix}${folder}${identity.id}.json`,
      sourceWavPath: `${cfg.archivePrefix}${folder}${stem}.wav`,
      sourceRecording: {
        type: 'historical', filename: entry.filename, datetimeLocal: source.datetimeLocal,
        durationSec, clipStartSec: start, clipStopSec: stop,
      },
      hitMetadata: {
        timestamps: indices.map(({ ts }) => Math.round((ts - start) * 1000) / 1000),
        confidences: indices.map(({ index }) => payload.confidences[index]),
        loudnesses: indices.map(({ index }) => payload.loudnesses[index]),
        multilabelScores: payload.multilabel_scores ? indices.map(({ index }) => payload.multilabel_scores[index]) : null,
        paddingS: Math.max(0, event.start_ts - start), windowS: payload.window_s,
        modelTrainedAt: payload.model_trained_at ?? null, analysisTrigger: 'manual',
        analysisSettings: { ...payload.analysis_settings,
          events: [{ ...eventInfo, start_ts: event.start_ts - start, end_ts: event.end_ts - start }],
          source_recording: { filename: entry.filename, datetime_local: source.datetimeLocal,
            clip_start_s: start, clip_stop_s: stop, duration_s: durationSec },
        },
      },
    };
  });
  if (nextHit !== payload.timestamps.length) throw new Error('Analyzer left hits unassigned to an event');
  return clips;
}
