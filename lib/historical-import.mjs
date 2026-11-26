import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { download, upload, copyObject, removeObject, loadJson, saveJson } from './minio.mjs';
import { runAudioCommand, getDurationAsync, convertWavToMp3Async, generateWaveformAsync } from './audio.mjs';
import { runReanalyzeScript } from './reanalyze.mjs';
import { getDiaryEntry, replaceHistoricalDiaryEntry, saveReanalysisResult } from './db.mjs';
import { archiveHistoricalRecording, historicalMp3Metadata, planHistoricalClips } from './historical-recordings.mjs';

export async function importHistoricalRecording({ entry, cfg, db, mc, stat, tuning, validate, warn, progress = () => {} }) {
  if (entry.sampleId) throw new Error('Historical recording is linked to a training sample');
  progress({ stage: 'archiving' });
  async function checksum(key) {
    const hash = createHash('sha256');
    const stream = await mc.getObject(cfg.bucket, key);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  }
  const { archiveKey, original } = await archiveHistoricalRecording(entry, cfg, {
    stat, copy: (from, to) => copyObject(mc, cfg.bucket, from, to),
    // Multipart copies may have different ETags despite identical audio bytes.
    sameContent: async (left, right) => await checksum(left) === await checksum(right),
  });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'barktown-historical-'));
  const published = [];
  let committed = false;
  try {
    progress({ stage: 'decoding' });
    const input = path.join(tmp, path.posix.basename(archiveKey));
    const wav = path.join(tmp, 'source.wav');
    await download(mc, cfg.bucket, archiveKey, input);
    await runAudioCommand(cfg.ffmpegBin, ['-v', 'error', '-y', '-i', input,
      '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const duration = await getDurationAsync(cfg.ffprobeBin, wav);
    progress({ stage: 'analyzing' });
    const payload = await runReanalyzeScript(cfg, wav, tuning, { workers: 1, mode: 'replay' });
    const error = validate(payload);
    if (error) throw new Error(`Historical replay produced an invalid payload: ${error}`);
    const clips = planHistoricalClips(entry, cfg, payload, duration, tuning.monitorSettings);
    progress({ stage: 'creating clips', eventTotal: clips.length, eventsCompleted: 0 });
    if (!clips.length) {
      // Retain a visible, reviewable recording if no event passed the live gates.
      saveReanalysisResult(db, entry.id, {
        timestamps: [], confidences: [], loudnesses: [], paddingS: 0, windowS: payload.window_s,
        modelTrainedAt: payload.model_trained_at, analysisSettings: payload.analysis_settings, analysisTrigger: 'manual',
        multilabelScores: payload.multilabel_scores ?? null,
      });
      return { replacementIds: [], message: 'No confirmed events; original recording retained.' };
    }
    // Refuse all collisions before writing any event objects.
    for (const clip of clips) {
      if (getDiaryEntry(db, clip.id)) throw new Error(`Diary event already exists: ${clip.id}`);
      for (const key of [clip.audioPath, clip.waveformPath, clip.sourceWavPath]) {
        if (await stat(key)) throw new Error(`Event object already exists: ${key}`);
      }
    }
    for (const [index, clip] of clips.entries()) {
      const clipWav = path.join(tmp, 'clip.wav');
      const mp3 = path.join(tmp, 'clip.mp3');
      const waveform = path.join(tmp, 'clip.json');
      await runAudioCommand(cfg.ffmpegBin, ['-v', 'error', '-y', '-ss', String(clip.start), '-i', wav,
        '-t', String(clip.durationSec), '-c:a', 'pcm_s16le', clipWav]);
      await convertWavToMp3Async(cfg.ffmpegBin, clipWav, mp3, {
        volumePct: cfg.wavVolumeBoostPct, bitrate: cfg.wavMp3Bitrate,
        metadata: historicalMp3Metadata({ ...clip, label: entry.label }, cfg, archiveKey),
      });
      await generateWaveformAsync(cfg.audiowaveformBin, clipWav, waveform);
      for (const [file, key, type] of [[clipWav, clip.sourceWavPath, 'audio/wav'],
        [mp3, clip.audioPath, 'audio/mpeg'], [waveform, clip.waveformPath, 'application/json']]) {
        published.push(key);
        await upload(mc, cfg.bucket, file, key, type);
      }
      progress({ eventsCompleted: index + 1 });
    }
    const currentOriginal = await stat(entry.audioPath);
    if (original ? (!currentOriginal || currentOriginal.etag !== original.etag || currentOriginal.size !== original.size)
      : Boolean(currentOriginal)) {
      throw new Error('Original recording changed while replay was running');
    }
    replaceHistoricalDiaryEntry(db, entry, clips);
    committed = true;
    // Database readers now see every clip. Only now remove the old public audio.
    for (const key of [entry.audioPath, entry.waveformPath].filter(Boolean)) {
      try { await removeObject(mc, cfg.bucket, key); }
      catch (error) { warn(`Historical import cleanup failed for ${key}: ${error.message}`); }
    }
    try {
      const index = await loadJson(mc, cfg.bucket, cfg.indexKey, []);
      await saveJson(mc, cfg.bucket, cfg.indexKey, [
        ...index.filter(item => item.id !== entry.id),
        ...clips.map(({ hitMetadata, start, stop, ...clip }) => clip),
      ].sort((a, b) => a.datetimeLocal.localeCompare(b.datetimeLocal)));
    } catch (error) { warn(`Historical import could not update fallback index: ${error.message}`); }
    return { replacementIds: clips.map(clip => clip.id), replacementDates: [...new Set(clips.map(clip => clip.date))] };
  } finally {
    if (!committed) {
      for (const key of published.reverse()) {
        try { await removeObject(mc, cfg.bucket, key); }
        catch (error) { warn(`Historical import rollback failed for ${key}: ${error.message}`); }
      }
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
