import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { CopySourceOptions, CopyDestinationOptions } from 'minio';
import { archiveHistoricalRecording, isHistoricalRecording, planHistoricalClips } from './historical-recordings.mjs';
import { historicalStagingFiles } from './historical-media.mjs';
import { copyObject, removeObject, loadJson, saveJson } from './minio.mjs';
import { runAudioCommand } from './audio.mjs';
import { getDiaryEntry, replaceHistoricalDiaryEntry, saveReanalysisResult } from './db.mjs';

function fail(message, statusCode = 409) {
  throw Object.assign(new Error(message), { statusCode });
}
const fingerprint = entry => JSON.stringify(entry && [entry.id, entry.filename, entry.audioPath,
  entry.waveformPath, entry.label, entry.date, entry.time, entry.datetimeLocal, entry.durationSec,
  entry.kind, entry.sampleId, entry.sourceWavPath, entry.sourceRecording]);
const objectSnapshot = stat => stat ? { size: stat.size, etag: stat.etag } : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The Pi owns durable tickets, publication and the final SQLite transaction. */
export function createExternalHistoricalImports({ db, cfg, mc, stat, validate, warn }) {
  db.exec(`CREATE TABLE IF NOT EXISTS external_historical_imports (
    id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, manifest TEXT, result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  function get(id) {
    const row = db.prepare('SELECT * FROM external_historical_imports WHERE id = ?').get(id);
    if (!row) return null;
    return { id, ...JSON.parse(row.snapshot), manifest: row.manifest && JSON.parse(row.manifest),
      result: row.result && JSON.parse(row.result) };
  }
  async function checksum(key) {
    const hash = createHash('sha256');
    for await (const chunk of await mc.getObject(cfg.bucket, key)) hash.update(chunk);
    return hash.digest('hex');
  }
  async function begin(entryId, monitorSettings, requestId = randomUUID()) {
    if (typeof requestId !== 'string' || !uuid.test(requestId)) fail('requestId must be a UUID v4', 400);
    const previous = get(requestId);
    if (previous) {
      if (previous.entry.id !== entryId || !isDeepStrictEqual(previous.monitorSettings, monitorSettings)) {
        fail('This requestId belongs to a different import or monitor settings');
      }
      return previous;
    }
    const entry = getDiaryEntry(db, entryId);
    if (!entry) fail('Recording not found', 404);
    if (!isHistoricalRecording(entry, cfg) || entry.sampleId) fail('Expected an unlinked historical AAC/M4A recording');
    const { archiveKey, original } = await archiveHistoricalRecording(entry, cfg, {
      stat, copy: (from, to) => copyObject(mc, cfg.bucket, from, to),
      sameContent: async (left, right) => await checksum(left) === await checksum(right),
    });
    const mediaConfig = Object.fromEntries(['audioPrefix', 'waveformPrefix', 'archivePrefix',
      'wavVolumeBoostPct', 'wavMp3Bitrate', 'recordingLocation', 'recordingDirection',
      'recordingArtist', 'recordingAlbum', 'recordingCopyright', 'barktownUrl'].map(key => [key, cfg[key]]));
    const snapshot = { entry, archiveKey, original: objectSnapshot(original),
      archive: objectSnapshot(await stat(archiveKey)), monitorSettings, mediaConfig };
    db.prepare('INSERT INTO external_historical_imports (id, snapshot) VALUES (?, ?)')
      .run(requestId, JSON.stringify(snapshot));
    return get(requestId);
  }
  async function assertSource(job) {
    if (fingerprint(getDiaryEntry(db, job.entry.id)) !== fingerprint(job.entry)) {
      fail('Historical recording changed while the Mac was processing it');
    }
    for (const [key, expected] of [[job.entry.audioPath, job.original], [job.archiveKey, job.archive]]) {
      if (!isDeepStrictEqual(objectSnapshot(await stat(key)), expected)) fail(`Source object changed: ${key}`);
    }
  }
  async function verifyMedia(file, descriptor, clip, directory) {
    const before = await stat(file.stagingKey);
    if (!before || before.size !== descriptor.size) fail(`Missing or incomplete staged file: ${file.stagingKey}`);
    const destination = path.join(directory, `verify.${file.extension}`);
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(await mc.getObject(cfg.bucket, file.stagingKey), new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > descriptor.size) return callback(new Error('Staged file grew during verification'));
        hash.update(chunk); callback(null, chunk);
      },
    }), fs.createWriteStream(destination));
    if (size !== descriptor.size || hash.digest('hex') !== descriptor.sha256) fail(`Checksum mismatch: ${file.stagingKey}`);
    if (file.extension === 'json') {
      const waveform = JSON.parse(await fsp.readFile(destination, 'utf8'));
      const valid = waveform.version === 2 && waveform.channels === 1 && waveform.bits === 16
        && waveform.sample_rate === 16000 && Number.isInteger(waveform.samples_per_pixel) && waveform.samples_per_pixel > 0
        && Number.isInteger(waveform.length) && waveform.length > 0 && Array.isArray(waveform.data)
        && waveform.data.length === waveform.length * 2
        && waveform.data.every((value, index, values) => Number.isInteger(value) && value >= -32768
          && value <= 32767 && (index % 2 || value <= values[index + 1]));
      const duration = waveform.length * waveform.samples_per_pixel / waveform.sample_rate;
      if (!valid || Math.abs(duration - clip.durationSec) > waveform.samples_per_pixel / 16000 + .05) {
        fail(`Invalid waveform or waveform duration: ${file.stagingKey}`);
      }
    } else {
      const probe = JSON.parse(await runAudioCommand(cfg.ffprobeBin,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', destination], { timeoutMs: 30000 }));
      const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
      const expectedCodec = file.extension === 'wav' ? 'pcm_s16le' : 'mp3';
      const duration = Number(probe.format?.duration);
      if (audio?.codec_name !== expectedCodec || Number(audio.channels) !== 1
          || Number(audio.sample_rate) !== 16000 || !Number.isFinite(duration)
          || Math.abs(duration - clip.durationSec) > (file.extension === 'wav' ? .002 : .2)) {
        fail(`Invalid audio format or duration: ${file.stagingKey}`);
      }
    }
    if (!isDeepStrictEqual(objectSnapshot(await stat(file.stagingKey)), objectSnapshot(before))) {
      fail(`Staged file changed during verification: ${file.stagingKey}`);
    }
    return before;
  }
  async function finishCleanup(job, clips) {
    const warnings = [];
    if (clips.length) {
      for (const key of [job.entry.audioPath, job.entry.waveformPath].filter(Boolean)) {
        try { await removeObject(mc, cfg.bucket, key); }
        catch (error) { warnings.push(`Cleanup of ${key}: ${error.message}`); }
      }
      try {
        const index = await loadJson(mc, cfg.bucket, cfg.indexKey, []);
        const replacedIds = new Set([job.entry.id, ...clips.map(clip => clip.id)]);
        await saveJson(mc, cfg.bucket, cfg.indexKey, [
          ...index.filter(entry => !replacedIds.has(entry.id)),
          ...clips.map(clip => getDiaryEntry(db, clip.id)).filter(Boolean),
        ].sort((left, right) => left.datetimeLocal.localeCompare(right.datetimeLocal)));
      } catch (error) { warnings.push(`Fallback index: ${error.message}`); }
    }
    for (const file of historicalStagingFiles(job.id, clips)) {
      try { await removeObject(mc, cfg.bucket, file.stagingKey); }
      catch (error) { warnings.push(`Staging cleanup: ${error.message}`); }
    }
    for (const message of warnings) warn(message);
    return { ...job.result, ...(warnings.length ? { cleanupWarnings: warnings } : {}) };
  }
  async function commit(id, body) {
    const job = get(id);
    if (!job) fail('Import ticket not found', 404);
    // A lost response or API restart can be retried with the same ticket.
    const acceptedDigest = job.result ? job.manifest?.sha256 : job.manifest && digest(job.manifest);
    if (acceptedDigest && digest(body) !== acceptedDigest) fail('This ticket already has a different commit manifest');
    if (job.result) {
      return finishCleanup(job, job.result.replacementIds.map(id => ({ id })));
    }
    const { payload, durationSec, sourceSha256, files } = body ?? {};
    const error = validate(payload);
    if (error) fail(error, 400);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? '')) {
      fail('Expected a positive decoded duration and the source SHA-256', 400);
    }
    if (!isDeepStrictEqual(payload.analysis_settings.monitor, job.monitorSettings)
        || payload.window_s !== job.monitorSettings.inference_window_s || payload.padding_s !== 0) {
      fail('Replay must use the monitor settings frozen in the import ticket', 400);
    }
    if (payload.timestamps.some((ts, index) => ts > durationSec || (index && ts < payload.timestamps[index - 1]))) {
      fail('Replay timestamps must be ordered and within the source recording', 400);
    }
    let clips;
    try { clips = planHistoricalClips(job.entry, job.mediaConfig, payload, durationSec, job.monitorSettings); }
    catch (error) { fail(error.message, 400); }
    const expected = historicalStagingFiles(id, clips);
    if (!Array.isArray(files) || files.length !== expected.length || expected.some((file, index) => {
      const descriptor = files[index];
      return descriptor?.key !== file.key || descriptor?.stagingKey !== file.stagingKey
        || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0
        || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '');
    })) fail('File manifest does not match the server-computed clip paths', 400);
    await assertSource(job);
    // A mounted upload can be queued on the workstation. Check visibility
    // before hashing the full archived source on each readiness retry.
    for (const [index, file] of expected.entries()) {
      const staged = await stat(file.stagingKey);
      if (!staged || staged.size !== files[index].size) fail(`Missing or incomplete staged file: ${file.stagingKey}`);
    }
    if (await checksum(job.archiveKey) !== sourceSha256) fail('The Mac processed a different source file');
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'barktown-verify-import-'));
    try {
      const verified = [];
      for (const [index, file] of expected.entries()) {
        if (getDiaryEntry(db, clips[file.clipIndex].id)) fail(`Diary event already exists: ${clips[file.clipIndex].id}`);
        verified.push(await verifyMedia(file, files[index], clips[file.clipIndex], directory));
        const existing = await stat(file.key);
        if (existing && (!job.manifest || existing.size !== files[index].size
            || await checksum(file.key) !== files[index].sha256)) fail(`Event object already exists: ${file.key}`);
      }
      // Persist publication intent before touching final keys. A retry after a
      // crash may reuse only this ticket's exact, already verified bytes.
      if (!job.manifest) db.prepare('UPDATE external_historical_imports SET manifest = ? WHERE id = ?')
        .run(JSON.stringify(body), id);
      const publishedObjects = [];
      for (const [index, file] of expected.entries()) {
        const existing = await stat(file.key);
        if (existing) {
          if (!job.manifest || existing.size !== files[index].size
              || await checksum(file.key) !== files[index].sha256) fail(`Event object already exists: ${file.key}`);
        } else {
          await mc.copyObject(new CopySourceOptions({ Bucket: cfg.bucket, Object: file.stagingKey,
            MatchETag: verified[index].etag }), new CopyDestinationOptions({ Bucket: cfg.bucket,
            Object: file.key, MetadataDirective: 'REPLACE', Headers: { 'Content-Type': file.contentType } }));
        }
        const published = await stat(file.key);
        if (!published || published.size !== files[index].size) fail(`Published file is missing or incomplete: ${file.key}`);
        publishedObjects.push({ key: file.key, snapshot: objectSnapshot(published) });
        if (file.extension === 'wav') clips[file.clipIndex].sourceWavEtag = published.etag;
      }
      await assertSource(job);
      for (const file of publishedObjects) {
        if (!isDeepStrictEqual(objectSnapshot(await stat(file.key)), file.snapshot)) {
          fail(`Published file changed before database commit: ${file.key}`);
        }
      }
      const result = { importId: id, replacementIds: clips.map(clip => clip.id),
        replacementDates: [...new Set(clips.map(clip => clip.date))],
        ...(!clips.length ? { message: 'No confirmed events; original recording retained.' } : {}) };
      db.transaction(() => {
        if (fingerprint(getDiaryEntry(db, job.entry.id)) !== fingerprint(job.entry)) fail('Original recording changed before commit');
        if (clips.length) replaceHistoricalDiaryEntry(db, job.entry, clips);
        else saveReanalysisResult(db, job.entry.id, {
          timestamps: [], confidences: [], loudnesses: [], paddingS: 0, windowS: payload.window_s,
          modelTrainedAt: payload.model_trained_at, analysisSettings: payload.analysis_settings,
          analysisTrigger: 'manual', multilabelScores: payload.multilabel_scores ?? null,
        });
        // Keep a small durable receipt rather than a second permanent copy of
        // every score already stored in hit_metadata.
        db.prepare('UPDATE external_historical_imports SET result = ?, manifest = ? WHERE id = ?')
          .run(JSON.stringify(result), JSON.stringify({ sha256: digest(body) }), id);
      })();
      return finishCleanup({ ...job, result }, clips);
    } finally { await fsp.rm(directory, { recursive: true, force: true }); }
  }
  return { begin, get, commit };
}
