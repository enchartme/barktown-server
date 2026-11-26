import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { startTestServer } from './helpers/test-server.mjs';
import { openDb, upsertDiaryEntry, getHitMetadata } from '../lib/db.mjs';

async function until(read, check) {
  for (let tries = 0; tries < 150; tries++) {
    const value = await read();
    if (check(value)) return value;
    await setTimeout(20);
  }
  throw new Error('Timed out waiting for test progress');
}

test('private day job rejects duplicate and single work, publishes progress and leaves other features available', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-day-api-'));
  const dbPath = path.join(tmp, 'test.db');
  const db = openDb(dbPath);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  function seed(id, date = '2026-11-22') {
    upsertDiaryEntry(db, { id, filename: `${id}.mp3`, audioPath: `audio/${id}.mp3`,
      label: 'bark', date, time: '12:00', datetimeLocal: `${date}T12:00:00`,
      durationSec: 10, kind: 'audio', sourceWavPath: `uncompressed-uploads-archive/${id}.wav` });
  }
  seed('a'); seed('b'); seed('missing'); seed('other-day', '2026-11-21');
  const responses = [];
  const settings = [];
  const analyzer = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* read upload */ }
    settings.push(JSON.parse(req.headers['x-barktown-monitor-settings']));
    responses.push(res);
  });
  await new Promise(resolve => analyzer.listen(0, '127.0.0.1', resolve));
  t.after(() => { analyzer.closeAllConnections(); analyzer.close(); });
  const env = { NODE_OPTIONS: `--import=${new URL('./fixtures/reanalysis-minio.mjs', import.meta.url).pathname}`,
    REANALYZE_URL: `http://127.0.0.1:${analyzer.address().port}`, REANALYZE_CONCURRENCY: '1' };
  const privateApi = await startTestServer({ dbPath, mode: 'private', env });
  t.after(() => privateApi.stop());
  const publicApi = await startTestServer({ dbPath, mode: 'public', env });
  t.after(() => publicApi.stop());
  const getStatus = () => fetch(`${privateApi.baseUrl}/api/reanalysis`).then(r => r.json());
  const post = (route, body) => fetch(`${privateApi.baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const route of ['/api/reanalysis', '/api/diary/reanalyze-day']) {
    const response = await fetch(`${publicApi.baseUrl}${route}`, { method: route.endsWith('day') ? 'POST' : 'GET' });
    assert.equal(response.status, 404);
  }
  assert.equal((await post('/api/diary/reanalyze-day', { date: '2026-02-30' })).status, 400);
  const accepted = await post('/api/diary/reanalyze-day', { date: '2026-11-22' });
  assert.equal(accepted.status, 202);
  await until(getStatus, s => s.currentIds.includes('a'));
  await until(async () => responses.length, n => n === 1);
  for (const [route, body] of [
    ['/api/diary/reanalyze-day', { date: '2026-11-21' }],
    ['/api/diary/auto-approve-day', { date: '2026-11-22' }],
    ['/api/diary/b/reanalyze', {}], ['/api/samples/anything/reanalyze', {}],
  ]) assert.equal((await post(route, body)).status, 409, route);
  // Reads, unrelated private edits, and another writer (the ingestion pattern) work during scoring.
  assert.equal((await fetch(`${publicApi.baseUrl}/api/diary`)).status, 200);
  assert.equal((await fetch(`${privateApi.baseUrl}/api/diary/b/approved`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }),
  })).status, 200);
  seed('new-upload');
  const settingsResponse = await fetch(`${privateApi.baseUrl}/api/monitor-params/candidate_threshold`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: .88 }),
  });
  assert.equal(settingsResponse.status, 200);
  responses[0].setHeader('Content-Type', 'application/json');
  responses[0].end(JSON.stringify({ timestamps: [3], confidences: [.99], loudnesses: [1],
    model_trained_at: null, analysis_trigger: 'manual', analysis_settings: { classifier: {}, monitor: {} } }));
  const progress = await until(getStatus, s => s.completed === 1 && s.currentIds.includes('b'));
  assert.equal(progress.active, true);
  assert.equal(progress.skipped, 1);
  assert.deepEqual(getHitMetadata(db, 'a').timestamps, [3]);
  await until(async () => responses.length, n => n === 2);
  assert.deepEqual(settings[0], settings[1], 'day settings remain consistent after a concurrent settings edit');
  responses[1].writeHead(503, { 'Content-Type': 'application/json' });
  responses[1].end(JSON.stringify({ error: 'test scoring failure' }));
  const done = await until(getStatus, s => !s.active);
  assert.equal(done.completed, 2);
  assert.equal(done.failed, 1);
  assert.equal(done.errors[0].id, 'b');
  assert.deepEqual(done.currentIds, []);
  assert.equal(getHitMetadata(db, 'new-upload'), null, 'new uploads are outside the day snapshot');
  assert.equal((await post('/api/diary/unknown/reanalyze', {})).status, 404, 'lock released after failure');
});
