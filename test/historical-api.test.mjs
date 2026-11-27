import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { startTestServer } from './helpers/test-server.mjs';
import { parseFilename } from '../lib/filenames.mjs';
import { openDb, upsertDiaryEntry, getDiaryEntry, getHitMetadata, deleteHitMetadataRow, saveReanalysisResult,
  setMonitorParam, getMonitorParamsMap } from '../lib/db.mjs';

async function until(read, check) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (check(value)) return value;
    await setTimeout(20);
  }
  throw new Error('Timed out waiting for historical import');
}

test('historical UI request archives, replays and publishes clips; upload failure retains original and rolls back', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-historical-api-'));
  const store = path.join(tmp, 'store'); fs.mkdirSync(store);
  const dbPath = path.join(tmp, 'db.sqlite');
  const db = openDb(dbPath);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  function seed(filename) {
    const entry = { ...parseFilename(filename), filename, audioPath: `audio/2023/05/${filename}`, durationSec: 7200, kind: 'audio' };
    entry.waveformPath = `waveforms/2023/05/${entry.id}.json`;
    upsertDiaryEntry(db, entry);
    fs.mkdirSync(path.dirname(path.join(store, entry.audioPath)), { recursive: true });
    fs.writeFileSync(path.join(store, entry.audioPath), 'original compressed audio');
    fs.mkdirSync(path.dirname(path.join(store, entry.waveformPath)), { recursive: true });
    fs.writeFileSync(path.join(store, entry.waveformPath), JSON.stringify({ data: [-100, 100], original: true }));
    return entry;
  }
  const first = seed('2023-05-31 23-59-00 barks at car.aac');
  setMonitorParam(db, 'upload_min_score', .99);
  // Fake codecs exercise real command execution, arguments, and storage sequencing.
  const binary = path.join(tmp, 'audio-tool');
  fs.writeFileSync(binary, `#!${process.execPath}
    const fs = require('fs'); const args = process.argv.slice(2);
    fs.appendFileSync(process.env.HISTORICAL_TEST_LOG, JSON.stringify(args) + '\\n');
    if (args.includes('-i') && args[args.indexOf('-i')+1].includes('no-stream')) {
      console.error('Output file #0 does not contain any stream'); process.exit(1);
    }
    if (args.includes('-show_format')) console.log(JSON.stringify({format:{duration:7200}}));
    else if(args.includes('--bits')) fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({data:[0,1]}));
    else fs.copyFileSync(args[args.indexOf('-i')+1], args.at(-1));
  `, { mode: 0o755 });
  let release, received = 0, failAnalysis = false, noEvents = false;
  const analyzer = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume uploaded source */ }
    received++;
    assert.equal(req.headers['x-barktown-analysis-mode'], 'replay');
    assert.equal(req.headers['x-barktown-workers'], '3');
    const settings = JSON.parse(req.headers['x-barktown-monitor-settings']);
    assert.equal(settings.silence_gap_s, 120);
    assert.equal(settings.confirmation_hits, 4);
    assert.equal(settings.padding_s, 1.5);
    assert.equal(settings.upload_min_score, 0, 'per-run zero overrides the live .99 peak gate');
    if (received === 1) await new Promise(resolve => { release = resolve; });
    res.setHeader('Content-Type', 'application/json');
    if (failAnalysis) { res.writeHead(502); res.end(JSON.stringify({ error: 'Scoring failed' })); return; }
    res.end(JSON.stringify({ timestamps: noEvents ? [] : [61.5, 63, 100, 101.5], confidences: noEvents ? [] : [.95, .96, .97, .98], loudnesses: noEvents ? [] : [1, 2, 3, 4],
      padding_s: 0, window_s: 1.5, model_trained_at: null, analysis_trigger: 'manual',
      analysis_settings: { classifier: {}, monitor: settings, analysis_mode: 'historical_stream_replay',
        events: noEvents ? [] : [
          { start_ts: 61.5, end_ts: 63, hit_start_index: 0, hit_stop_index: 2 },
          { start_ts: 100, end_ts: 101.5, hit_start_index: 2, hit_stop_index: 4 },
        ] } }));
  });
  await new Promise(resolve => analyzer.listen(0, '127.0.0.1', resolve));
  t.after(() => { analyzer.closeAllConnections(); analyzer.close(); });
  const env = { NODE_OPTIONS: `--import=${new URL('./fixtures/historical-minio.mjs', import.meta.url).pathname}`,
    HISTORICAL_TEST_STORE: store, HISTORICAL_TEST_LOG: path.join(tmp, 'commands.jsonl'),
    FFMPEG_BIN: binary, FFPROBE_BIN: binary, AUDIOWAVEFORM_BIN: binary,
    REANALYZE_URL: `http://127.0.0.1:${analyzer.address().port}`,
    REANALYZE_CONCURRENCY: '3', REANALYZE_WORKERS_PER_JOB: '3' };
  const privateApi = await startTestServer({ dbPath, mode: 'private', env }); t.after(() => privateApi.stop());
  const publicApi = await startTestServer({ dbPath, mode: 'public', env }); t.after(() => publicApi.stop());
  const post = (id, uploadMinScore = 0) => fetch(`${privateApi.baseUrl}/api/diary/${id}/reanalyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadMinScore }),
  });
  const status = () => fetch(`${privateApi.baseUrl}/api/reanalysis`).then(r => r.json());
  const listed = await fetch(`${publicApi.baseUrl}/api/diary`).then(r => r.json());
  assert.equal(listed.find(e => e.id === first.id).reanalyzable, true);
  assert.equal(listed.find(e => e.id === first.id).reanalysisMode, 'historical');
  for (const value of [-1, 1.1, 'any', null]) assert.equal((await post(first.id, value)).status, 400);
  assert.equal((await post(first.id)).status, 202);
  await until(() => received, n => n === 1);
  assert.ok(fs.existsSync(path.join(store, first.audioPath.replace('audio/', 'historical-recordings-archive/'))));
  assert.ok(getDiaryEntry(db, first.id), 'original remains visible until publication');
  assert.ok(fs.existsSync(path.join(store, first.waveformPath)), 'original waveform remains available during inference');
  assert.equal((await post(first.id)).status, 409);
  release();
  const done = await until(status, s => !s.active);
  assert.equal(done.failed, 0, JSON.stringify(done.errors));
  assert.equal(done.replacementIds.length, 2);
  assert.deepEqual(done.replacementDates, ['2023-06-01']);
  const clip = getDiaryEntry(db, done.replacementIds[0]);
  assert.equal(clip.datetimeLocal, '2023-06-01T00:00:00');
  assert.deepEqual(getHitMetadata(db, clip.id).timestamps, [1.5, 3]);
  const sourceRecording = {
    type: 'historical', filename: first.filename, datetimeLocal: first.datetimeLocal,
    durationSec: 7200, clipStartSec: 60, clipStopSec: 64.5,
  };
  const publicClip = async () => (await fetch(`${publicApi.baseUrl}/api/diary`).then(r => r.json())).find(e => e.id === clip.id);
  assert.deepEqual((await publicClip()).sourceRecording, sourceRecording);
  assert.equal((await publicClip()).reanalysisMode, 'windows', 'persistent origin does not replay the original file again');
  deleteHitMetadataRow(db, clip.id);
  assert.deepEqual((await publicClip()).sourceRecording, sourceRecording);
  saveReanalysisResult(db, clip.id, {
    timestamps: [2], confidences: [.99], loudnesses: [1],
    analysisSettings: { analysis_mode: 'deterministic_window_reclassification' }, analysisTrigger: 'manual',
  });
  assert.deepEqual((await publicClip()).sourceRecording, sourceRecording);
  const fallback = JSON.parse(fs.readFileSync(path.join(store, 'index.json'), 'utf8'));
  assert.deepEqual(fallback.find(e => e.id === clip.id).sourceRecording, sourceRecording);
  assert.ok(fs.existsSync(path.join(store, clip.audioPath)));
  assert.ok(fs.existsSync(path.join(store, clip.sourceWavPath)));
  for (const id of done.replacementIds) {
    const event = getDiaryEntry(db, id);
    assert.notEqual(event.waveformPath, first.waveformPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, event.waveformPath), 'utf8')), { data: [0, 1] },
      'each clip publishes a newly generated waveform');
    assert.equal(fallback.find(e => e.id === id).waveformPath, event.waveformPath);
  }
  assert.equal(fs.existsSync(path.join(store, first.audioPath)), false);
  assert.equal(fs.existsSync(path.join(store, first.waveformPath)), false, 'old full-recording waveform is deleted after publication');
  assert.equal(fallback.some(e => e.waveformPath === first.waveformPath), false);
  assert.equal(getDiaryEntry(db, first.id), undefined);
  const commands = fs.readFileSync(env.HISTORICAL_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const mp3 = commands.find(args => args.includes('libmp3lame'));
  assert.ok(mp3.includes('title=barks at car'));
  assert.ok(mp3.includes('comment=Recorded: 2023-06-01T00:00:00 local time  Listen: https://barktown.enchart.me/#2023-06-01_00-00-00_-A-  Source: 2023-05-31 23-59-00 barks at car.aac'));
  const failed = seed('2023-05-30 12-00-00 test.m4a');
  // Fail the second clip after the first clip's waveform has been published.
  fs.writeFileSync(path.join(store, 'fail-upload'), 'audio/2023/05/2023-05-30 12-01-38 -A-.mp3');
  assert.equal((await post(failed.id)).status, 202);
  const failedJob = await until(status, s => !s.active);
  assert.equal(failedJob.failed, 1);
  assert.match(failedJob.errors[0].error, /Simulated upload failure/);
  assert.ok(getDiaryEntry(db, failed.id));
  assert.ok(fs.existsSync(path.join(store, failed.audioPath)));
  assert.ok(fs.existsSync(path.join(store, failed.waveformPath)), 'failed imports retain the original waveform');
  assert.equal(fs.existsSync(path.join(store, 'uncompressed-uploads-archive/2023/05/2023-05-30 12-01-00 -A-.wav')), false);
  assert.equal(fs.existsSync(path.join(store, 'waveforms/2023/05/2023-05-30_12-01-00_-A-.json')), false,
    'rollback removes the already published first clip waveform');
  fs.rmSync(path.join(store, 'fail-upload'));
  failAnalysis = true;
  assert.equal((await post(failed.id)).status, 202);
  assert.equal((await until(status, s => !s.active)).failed, 1);
  assert.ok(getDiaryEntry(db, failed.id));
  assert.ok(fs.existsSync(path.join(store, failed.waveformPath)), 'inference failure retains the original waveform');
  failAnalysis = false; noEvents = true;
  assert.equal((await post(failed.id)).status, 202);
  const empty = await until(status, s => !s.active);
  assert.equal(empty.failed, 0);
  assert.match(empty.message, /No confirmed events/);
  assert.ok(getDiaryEntry(db, failed.id));
  assert.ok(fs.existsSync(path.join(store, failed.waveformPath)), 'zero-event imports retain the original waveform for review');

  seed('2023-05-29 12-00-00 first.aac');
  seed('2023-05-29 15-00-00 second.m4a');
  const beforeBulk = received;
  const bulk = await fetch(`${privateApi.baseUrl}/api/diary/reanalyze-day`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2023-05-29', uploadMinScore: 0 }),
  });
  assert.equal(bulk.status, 202);
  const bulkDone = await until(status, s => !s.active);
  assert.equal(bulkDone.failed, 0, JSON.stringify(bulkDone.errors));
  assert.equal(bulkDone.completed, 2);
  assert.equal(received - beforeBulk, 2, 'each historical bulk recording requests three workers');
  const short = seed('2023-05-28 12-00-00 no-stream.aac');
  const following = seed('2023-05-28 15-00-00 following.m4a');
  const beforeShort = received;
  const shortBatch = await fetch(`${privateApi.baseUrl}/api/diary/reanalyze-day`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2023-05-28', uploadMinScore: 0 }),
  });
  assert.equal(shortBatch.status, 202);
  const shortDone = await until(status, s => !s.active);
  assert.equal(shortDone.failed, 0, JSON.stringify(shortDone.errors));
  assert.equal(shortDone.completed, 2, 'a streamless file does not stop the batch');
  assert.equal(received - beforeShort, 1, 'only the following audio is analyzed');
  const note = getDiaryEntry(db, short.id);
  assert.equal(note.kind, 'note');
  assert.equal(note.label, short.label);
  assert.equal(note.datetimeLocal, short.datetimeLocal);
  assert.equal(note.waveformPath, null);
  assert.equal(note.durationSec, 0);
  assert.ok(getDiaryEntry(db, following.id));
  assert.equal(fs.readFileSync(path.join(store, short.audioPath), 'utf8'), 'original compressed audio');
  assert.equal(fs.readFileSync(path.join(store, short.audioPath.replace('audio/', 'historical-recordings-archive/')), 'utf8'), 'original compressed audio');
  const notes = await fetch(`${publicApi.baseUrl}/api/diary`).then(r => r.json());
  assert.equal(notes.find(e => e.id === short.id).reanalyzable, false);
  const updatedIndex = JSON.parse(fs.readFileSync(path.join(store, 'index.json'), 'utf8'));
  assert.equal(updatedIndex.find(e => e.id === short.id).kind, 'note');
  assert.equal(getMonitorParamsMap(db).upload_min_score, .99, 'single and day overrides leave live settings unchanged');
});
