import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig } from '../lib/config.mjs';
import { parseFilename } from '../lib/filenames.mjs';
import { openDb, upsertDiaryEntry, getDiaryEntry, getDiaryNote, upsertDiaryNote, getHitMetadata,
  replaceHistoricalDiaryEntry, setDiaryApproved, listDiaryEntries, saveReanalysisResult,
  deleteHitMetadataRow, upsertHitMetadata } from '../lib/db.mjs';
import { historicalArchiveKey, archiveHistoricalRecording, availableRecordingSource,
  localTimestampAtOffset, planHistoricalClips } from '../lib/historical-recordings.mjs';

const cfg = buildConfig();
const filename = '2023-05-31 23-59-00 barks at car.m4a';
const entry = { ...parseFilename(filename), filename, audioPath: `audio/2023/05/${filename}`,
  waveformPath: 'waveforms/old.json', durationSec: 7200, kind: 'audio' };
const settings = { padding_s: 1.5, max_clip_s: 30 };
test('text recordings remain eligible for historical archiving', () => {
  const keys = new Set([entry.audioPath]);
  const note = { ...entry, kind: 'note', durationSec: 0.5 };
  assert.equal(availableRecordingSource(note, cfg, keys), entry.audioPath);
  assert.equal(availableRecordingSource(note, cfg, new Set([historicalArchiveKey(note, cfg)])), historicalArchiveKey(note, cfg));
});
function payload() {
  return { timestamps: [61.5, 63, 100, 101.5], confidences: [.95, .96, .97, .98], loudnesses: [1, 2, 3, 4],
    multilabel_scores: [{ bark: .1 }, { bark: .2 }, { bark: .3 }, { bark: .4 }], window_s: 1.5,
    analysis_settings: { analysis_mode: 'historical_stream_replay', events: [
      { start_ts: 61.5, end_ts: 63, hit_start_index: 0, hit_stop_index: 2 }, { start_ts: 100, end_ts: 101.5, hit_start_index: 2, hit_stop_index: 4 },
    ] } };
}

test('historical sources preserve dated names and are available without a WAV', async () => {
  const key = `historical-recordings-archive/2023/05/${filename}`;
  assert.equal(historicalArchiveKey(entry, cfg), key);
  assert.equal(availableRecordingSource(entry, cfg, new Set([entry.audioPath])), entry.audioPath);
  assert.equal(availableRecordingSource(entry, cfg, new Set([key])), key);
  let copied = 0;
  const objects = new Map([[entry.audioPath, { etag: 'original', size: 123 }]]);
  const operations = { stat: async key => objects.get(key), copy: async (from, to) => {
    copied++; objects.set(to, objects.get(from));
  } };
  await archiveHistoricalRecording(entry, cfg, operations);
  await archiveHistoricalRecording(entry, cfg, operations);
  assert.equal(copied, 1, 'retry reuses the same original archive');
  objects.set(entry.audioPath, { etag: 'changed', size: 123 });
  await assert.rejects(archiveHistoricalRecording(entry, cfg, operations), /different original/);
  await archiveHistoricalRecording(entry, cfg, { ...operations, sameContent: async () => true });
  assert.equal(copied, 1, 'equivalent multipart ETags do not require another copy');
});

test('clip clocks use filename local time, padding, and month rollover with aligned metadata', () => {
  assert.equal(localTimestampAtOffset('2023-12-31T23:59:59', 2), '2024-01-01T00:00:01');
  // Clock arithmetic must not depend on DST transitions in the host timezone.
  assert.equal(localTimestampAtOffset('2023-03-26T01:59:59', 2), '2023-03-26T02:00:01');
  const clips = planHistoricalClips({ ...entry, datetimeLocal: '1999-01-01T00:00:00' }, cfg, payload(), 7200, settings);
  assert.equal(clips[0].datetimeLocal, '2023-06-01T00:00:00');
  assert.equal(clips[0].audioPath, 'audio/2023/06/2023-06-01 00-00-00 -A-.mp3');
  assert.equal(clips[0].sourceWavPath, 'uncompressed-uploads-archive/2023/06/2023-06-01 00-00-00 -A-.wav');
  assert.deepEqual(clips[0].hitMetadata.timestamps, [1.5, 3]);
  assert.deepEqual(clips[0].hitMetadata.confidences, [.95, .96]);
  assert.deepEqual(clips[1].hitMetadata.multilabelScores, [{ bark: .3 }, { bark: .4 }]);
  assert.equal(clips[0].hitMetadata.analysisSettings.source_recording.clip_start_s, 60);
  assert.deepEqual(clips[0].sourceRecording, {
    type: 'historical', filename, datetimeLocal: '2023-05-31T23:59:00',
    durationSec: 7200, clipStartSec: 60, clipStopSec: 64.5,
  });
  const capped = payload();
  capped.analysis_settings.events = [{ start_ts: 1, end_ts: 100, hit_start_index: 0, hit_stop_index: 4 }];
  const [clip] = planHistoricalClips(entry, cfg, capped, 7200, settings);
  assert.equal(clip.durationSec, 30, 'match uploader final size cap, retaining the tail');
  assert.ok(clip.hitMetadata.timestamps.every(ts => ts >= 0 && ts <= 30));
  assert.throws(() => planHistoricalClips(entry, cfg, { ...payload(), analysis_settings: {} }, 7200, settings), /deploy Goblin first/);
});

test('replacement commits all clips and notes atomically and rolls back on identity conflict', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-history-db-'));
  const db = openDb(path.join(tmp, 'test.db'));
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  upsertDiaryEntry(db, entry);
  upsertDiaryNote(db, entry.id, 'operator comment');
  const clips = planHistoricalClips(entry, cfg, payload(), 7200, settings);
  upsertDiaryEntry(db, clips[1]);
  assert.throws(() => replaceHistoricalDiaryEntry(db, entry, clips), /already exists/);
  assert.ok(getDiaryEntry(db, entry.id));
  assert.equal(getDiaryEntry(db, clips[0].id), undefined, 'earlier insert rolled back');
  db.prepare('DELETE FROM diary_entries WHERE id = ?').run(clips[1].id);
  setDiaryApproved(db, entry.id, true);
  replaceHistoricalDiaryEntry(db, entry, clips);
  assert.equal(getDiaryEntry(db, entry.id), undefined);
  assert.equal(getDiaryEntry(db, clips[0].id).approved, null);
  assert.deepEqual(getHitMetadata(db, clips[0].id).timestamps, [1.5, 3]);
  assert.match(getDiaryNote(db, clips[0].id).label, /barks at car\noperator comment/);
  const expected = clips[0].sourceRecording;
  assert.deepEqual(getDiaryEntry(db, clips[0].id).sourceRecording, expected);
  deleteHitMetadataRow(db, clips[0].id);
  assert.deepEqual(getDiaryEntry(db, clips[0].id).sourceRecording, expected, 'origin survives deleting all hits');
  saveReanalysisResult(db, clips[0].id, {
    timestamps: [2], confidences: [.99], loudnesses: [1],
    analysisSettings: { analysis_mode: 'deterministic_window_reclassification' }, analysisTrigger: 'manual',
  });
  upsertDiaryEntry(db, { ...clips[0], sourceRecording: null });
  assert.deepEqual(getDiaryEntry(db, clips[0].id).sourceRecording, expected, 're-analysis and stale index imports retain origin');
  upsertDiaryEntry(db, { ...clips[0], sourceRecording: { type: 'incorrect replacement' } });
  assert.deepEqual(listDiaryEntries(db).find(e => e.id === clips[0].id).sourceRecording, expected, 'routine upserts cannot replace origin');
  const reopened = openDb(path.join(tmp, 'test.db'));
  try { assert.deepEqual(getDiaryEntry(reopened, clips[0].id).sourceRecording, expected); }
  finally { reopened.close(); }
});

test('schema migration backfills historical origin without guessing missing or malformed provenance', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-history-migration-'));
  const dbPath = path.join(tmp, 'test.db');
  let db = openDb(dbPath);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const [clip] = planHistoricalClips(entry, cfg, payload(), 7200, settings);
  upsertDiaryEntry(db, { ...clip, sourceRecording: null });
  upsertHitMetadata(db, clip.id, clip.hitMetadata);
  for (const [id, analysisSettings] of [
    ['plain', {}], ['incomplete', { analysis_mode: 'historical_stream_replay' }],
    ['malformed', { analysis_mode: 'historical_stream_replay', source_recording: {
      filename, datetime_local: entry.datetimeLocal, clip_start_s: -1, clip_stop_s: 2, duration_s: 7200,
    } }],
  ]) {
    upsertDiaryEntry(db, { ...entry, id });
    upsertHitMetadata(db, id, { timestamps: [], analysisSettings });
  }
  db.exec('ALTER TABLE diary_entries DROP COLUMN source_recording');
  db.close();
  db = openDb(dbPath);
  assert.deepEqual(getDiaryEntry(db, clip.id).sourceRecording, clip.sourceRecording);
  for (const id of ['plain', 'incomplete', 'malformed']) assert.equal(getDiaryEntry(db, id).sourceRecording, null);
  // Startup must never replace an existing record origin using later hit data.
  upsertHitMetadata(db, clip.id, { ...clip.hitMetadata, analysisSettings: {
    ...clip.hitMetadata.analysisSettings,
    source_recording: { ...clip.hitMetadata.analysisSettings.source_recording, filename: 'different.aac' },
  } });
  db.close();
  db = openDb(dbPath);
  assert.deepEqual(getDiaryEntry(db, clip.id).sourceRecording, clip.sourceRecording);
});
