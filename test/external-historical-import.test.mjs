import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer } from './helpers/test-server.mjs';
import { openDb, upsertDiaryEntry, getDiaryEntry, getHitMetadata, getDiaryNote, upsertDiaryNote } from '../lib/db.mjs';
import { parseFilename } from '../lib/filenames.mjs';
import { planHistoricalClips } from '../lib/historical-recordings.mjs';
import { historicalStagingFiles } from '../lib/historical-media.mjs';

const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const waveform = () => ({ version: 2, channels: 1, bits: 16, sample_rate: 16000,
  samples_per_pixel: 160, length: 450, data: Array(900).fill(0) });
function replay(settings, empty = false) {
  return { timestamps: empty ? [] : [4, 5.5], confidences: empty ? [] : [.95, .98], loudnesses: empty ? [] : [1, 2],
    padding_s: 0, window_s: settings.inference_window_s, model_trained_at: null, analysis_trigger: 'manual',
    analysis_settings: { classifier: {}, monitor: settings, analysis_mode: 'historical_stream_replay',
      events: empty ? [] : [{ start_ts: 4, end_ts: 5.5, hit_start_index: 0, hit_stop_index: 2 }] } };
}
async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-external-import-'));
  const store = path.join(tmp, 'bucket'); fs.mkdirSync(store);
  const dbPath = path.join(tmp, 'db.sqlite');
  const db = openDb(dbPath);
  const binary = path.join(tmp, 'audio-tool');
  fs.writeFileSync(binary, `#!${process.execPath}
    const fs = require('fs'); const path = require('path'); const args = process.argv.slice(2);
    if (args.includes('-version') || args.includes('--version')) { console.log('test codec'); process.exit(0); }
    if (args.includes('-show_format')) {
      const file = args.at(-1); const source = path.basename(file) === 'source.wav';
      const wrong = fs.existsSync(path.join(process.env.HISTORICAL_TEST_STORE, 'wrong-duration'));
      console.log(JSON.stringify({format:{duration:source ? 8 : wrong ? 99 : 4.5},
        streams:[{codec_type:'audio',codec_name:file.endsWith('.mp3') ? 'mp3':'pcm_s16le',sample_rate:'16000',channels:1}]}));
    } else if(args.includes('--bits')) {
      fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify(${JSON.stringify(waveform())}));
    } else fs.copyFileSync(args[args.indexOf('-i')+1], args.at(-1));
  `, { mode: 0o755 });
  const analyzer = path.join(tmp, 'analyze.mjs');
  fs.writeFileSync(analyzer, `import fs from 'node:fs';
    const args = process.argv.slice(2);
    const settings = JSON.parse(args[args.indexOf('--monitor-settings-json')+1]);
    if(args[args.indexOf('--workers')+1] !== '3') throw new Error('Expected three local workers');
    if(args[args.indexOf('--mode')+1] !== 'replay') throw new Error('Expected replay');
    fs.appendFileSync(${JSON.stringify(path.join(tmp, 'analysis-count'))}, 'scored\\n');
    console.log(JSON.stringify((${replay.toString()})(settings)));
  `);
  const env = { NODE_OPTIONS: `--import=${new URL('./fixtures/historical-minio.mjs', import.meta.url).pathname}`,
    HISTORICAL_TEST_STORE: store, FFMPEG_BIN: binary, FFPROBE_BIN: binary, AUDIOWAVEFORM_BIN: binary,
    REANALYZE_PYTHON_BIN: process.execPath, REANALYZE_SCRIPT_PATH: analyzer,
    REANALYZE_URL: 'http://this-must-not-be-used.invalid', REANALYZE_TIMEOUT_MS: '10000' };
  let privateApi = await startTestServer({ dbPath, mode: 'private', env });
  const publicApi = await startTestServer({ dbPath, mode: 'public', env });
  t.after(async () => {
    await publicApi.stop(); await privateApi.stop(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  });
  function seed(filename = '2023-05-31 23-59-59 barks.m4a') {
    const entry = { ...parseFilename(filename), filename, audioPath: `audio/2023/05/${filename}`,
      waveformPath: `waveforms/2023/05/${parseFilename(filename).id}.json`, durationSec: 8, kind: 'audio' };
    upsertDiaryEntry(db, entry);
    for (const key of [entry.audioPath, entry.waveformPath]) {
      fs.mkdirSync(path.dirname(path.join(store, key)), { recursive: true });
      fs.writeFileSync(path.join(store, key), 'original source bytes');
    }
    return entry;
  }
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const api = (route, body) => request(privateApi.baseUrl + route, body);
  async function begin(entry, tuning = {}) {
    const response = await api(`/api/diary/${entry.id}/historical-import`, { requestId: randomUUID(), ...tuning });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  function stage(ticket, empty = false) {
    const payload = replay(ticket.monitorSettings, empty);
    const clips = planHistoricalClips(ticket.entry, ticket.mediaConfig, payload, 8, ticket.monitorSettings);
    const files = historicalStagingFiles(ticket.id, clips).map(file => {
      const bytes = file.extension === 'json' ? JSON.stringify(waveform()) : 'test media bytes';
      fs.mkdirSync(path.dirname(path.join(store, file.stagingKey)), { recursive: true });
      fs.writeFileSync(path.join(store, file.stagingKey), bytes);
      return { key: file.key, stagingKey: file.stagingKey, size: Buffer.byteLength(bytes), sha256: sha(bytes) };
    });
    return { payload, durationSec: 8, sourceSha256: sha(fs.readFileSync(path.join(store, ticket.archiveKey))), files };
  }
  return { tmp, store, db, env, seed, begin, stage, api, publicApi,
    privateUrl: () => privateApi.baseUrl,
    restart: async () => { await privateApi.stop(); privateApi = await startTestServer({ dbPath, mode: 'private', env }); } };
}

test('external import verifies and publishes media, preserves notes and retries a committed ticket after API restart', async t => {
  const f = await setup(t);
  const entry = f.seed(); upsertDiaryNote(f.db, entry.id, 'A diary note');
  const ticket = await f.begin(entry, { candidateThreshold: .8 });
  assert.equal(ticket.monitorSettings.candidate_threshold, .8);
  const manifest = f.stage(ticket);
  const route = `/api/historical-imports/${ticket.id}/commit`;
  assert.equal((await fetch(f.publicApi.baseUrl + route, { method: 'POST' })).status, 404);
  const result = await f.api(route, manifest);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.replacementIds.length, 1);
  assert.deepEqual(result.body.replacementDates, ['2023-06-01']);
  assert.equal(getDiaryEntry(f.db, entry.id), undefined);
  const clip = getDiaryEntry(f.db, result.body.replacementIds[0]);
  assert.equal(clip.datetimeLocal, '2023-06-01T00:00:01');
  assert.deepEqual(getHitMetadata(f.db, clip.id).timestamps, [1.5, 3]);
  assert.equal(getDiaryNote(f.db, clip.id).label, 'barks\nA diary note');
  assert.ok(fs.existsSync(path.join(f.store, ticket.archiveKey)));
  assert.equal(fs.existsSync(path.join(f.store, entry.audioPath)), false);
  for (const file of manifest.files) {
    assert.ok(fs.existsSync(path.join(f.store, file.key)));
    assert.equal(fs.existsSync(path.join(f.store, file.stagingKey)), false);
    const metadata = JSON.parse(fs.readFileSync(path.join(f.store, '.metadata', file.key)));
    assert.match(metadata['Content-Type'], /^(audio\/wav|audio\/mpeg|application\/json)$/);
  }
  await f.restart();
  assert.deepEqual((await f.api(route, manifest)).body, result.body);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM diary_entries').get().count, 1);
});

test('external import refuses missing, corrupt, misplaced and wrong-duration media without changing the diary', async t => {
  const mutations = {
    missing: (f, body) => fs.unlinkSync(path.join(f.store, body.files[0].stagingKey)),
    corrupt: (f, body) => fs.writeFileSync(path.join(f.store, body.files[0].stagingKey), 'different bytes!'),
    misplaced: (_f, body) => { body.files[0].key = 'audio/2099/wrong.wav'; },
    settings: (_f, body) => { body.payload.analysis_settings.monitor.candidate_threshold = .01; },
    duration: f => fs.writeFileSync(path.join(f.store, 'wrong-duration'), '1'),
    waveform: (f, body) => {
      const file = body.files[2]; const bytes = JSON.stringify({ ...waveform(), channels: 2 });
      fs.writeFileSync(path.join(f.store, file.stagingKey), bytes);
      file.sha256 = sha(bytes); file.size = Buffer.byteLength(bytes);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await setup(t); const entry = f.seed(); const ticket = await f.begin(entry); const body = f.stage(ticket);
    mutate(f, body);
    const result = await f.api(`/api/historical-imports/${ticket.id}/commit`, body);
    assert.ok([400, 409].includes(result.status), JSON.stringify(result));
    assert.ok(getDiaryEntry(f.db, entry.id));
    assert.ok(fs.existsSync(path.join(f.store, entry.audioPath)));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM diary_entries').get().count, 1);
  });
});

test('external import rejects a changed source or pre-existing final object', async t => {
  for (const change of ['source', 'collision', 'wrong-source-hash']) await t.test(change, async t => {
    const f = await setup(t); const entry = f.seed(); const ticket = await f.begin(entry); const body = f.stage(ticket);
    if (change === 'source') fs.writeFileSync(path.join(f.store, entry.audioPath), 'changed original file');
    else if (change === 'wrong-source-hash') body.sourceSha256 = '0'.repeat(64);
    else {
      fs.mkdirSync(path.dirname(path.join(f.store, body.files[1].key)), { recursive: true });
      fs.writeFileSync(path.join(f.store, body.files[1].key), 'existing audio');
    }
    const result = await f.api(`/api/historical-imports/${ticket.id}/commit`, body);
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.ok(getDiaryEntry(f.db, entry.id));
    if (change === 'collision') assert.equal(fs.readFileSync(path.join(f.store, body.files[1].key), 'utf8'), 'existing audio');
  });
});

test('partial publication resumes after a server restart and zero-event imports retain the original', async t => {
  const f = await setup(t); const entry = f.seed(); const ticket = await f.begin(entry); const body = f.stage(ticket);
  fs.writeFileSync(path.join(f.store, 'fail-copy'), body.files[1].key);
  const route = `/api/historical-imports/${ticket.id}/commit`;
  assert.equal((await f.api(route, body)).status, 500);
  assert.ok(getDiaryEntry(f.db, entry.id));
  assert.ok(fs.existsSync(path.join(f.store, body.files[0].key)), 'verified WAV was published before the simulated crash');
  fs.unlinkSync(path.join(f.store, 'fail-copy')); await f.restart();
  assert.equal((await f.api(route, body)).status, 200);
  const emptyEntry = f.seed('2023-05-30 12-00-00 silence.aac');
  const emptyTicket = await f.begin(emptyEntry); const emptyBody = f.stage(emptyTicket, true);
  const emptyRoute = `/api/historical-imports/${emptyTicket.id}/commit`;
  assert.equal((await f.api(emptyRoute, emptyBody)).status, 200);
  assert.ok(getDiaryEntry(f.db, emptyEntry.id));
  assert.deepEqual(getHitMetadata(f.db, emptyEntry.id).timestamps, []);
  assert.equal((await f.api(emptyRoute, emptyBody)).status, 200);
});

test('a database failure rolls back every diary and metadata change and permits retry', async t => {
  const f = await setup(t); const entry = f.seed(); const ticket = await f.begin(entry); const body = f.stage(ticket);
  f.db.exec(`CREATE TRIGGER fail_external_metadata BEFORE INSERT ON hit_metadata
    BEGIN SELECT RAISE(ABORT, 'Simulated database failure'); END`);
  const route = `/api/historical-imports/${ticket.id}/commit`;
  assert.equal((await f.api(route, body)).status, 500);
  assert.ok(getDiaryEntry(f.db, entry.id));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM diary_entries').get().count, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM hit_metadata').get().count, 0);
  assert.equal(f.db.prepare('SELECT result FROM external_historical_imports WHERE id = ?').get(ticket.id).result, null);
  assert.ok(fs.existsSync(path.join(f.store, entry.audioPath)));
  f.db.exec('DROP TRIGGER fail_external_metadata');
  assert.equal((await f.api(route, body)).status, 200);
});

test('the Pi rechecks the complete published file set before committing the database', async t => {
  const f = await setup(t); const entry = f.seed(); const ticket = await f.begin(entry); const body = f.stage(ticket);
  fs.writeFileSync(path.join(f.store, 'delete-after-copy'), body.files[0].key);
  const route = `/api/historical-imports/${ticket.id}/commit`;
  const failed = await f.api(route, body);
  assert.equal(failed.status, 409);
  assert.match(failed.body.message ?? failed.body.error, /changed before database commit/);
  assert.ok(getDiaryEntry(f.db, entry.id));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM hit_metadata').get().count, 0);
  fs.unlinkSync(path.join(f.store, 'delete-after-copy'));
  assert.equal((await f.api(route, body)).status, 200);
});

test('Mac CLI supports mounted and S3 buckets, read-only previews and completed checkpoints', async t => {
  for (const mounted of [true, false]) await t.test(mounted ? 'mount' : 'S3', async t => {
    const f = await setup(t); const entry = f.seed();
    const args = ['historical-worker.mjs', '--start-date', '2023-05-31', '--end-date', '2023-05-31',
      '--api-base', f.privateUrl(), '--public-api-base', f.publicApi.baseUrl, '--threshold', '.8',
      '--state-file', path.join(f.tmp, 'checkpoint.json'), ...(mounted ? ['--bucket-root', f.store] : [])];
    const options = { cwd: new URL('..', import.meta.url), env: { ...process.env, ...f.env } };
    const preview = await execute(process.execPath, [...args, '--dry-run'], options);
    assert.match(preview.stdout, /WOULD RUN/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM external_historical_imports').get().count, 0);
    const run = await execute(process.execPath, args, options);
    assert.match(run.stdout, /1 historical source\(s\) committed/);
    assert.equal(getDiaryEntry(f.db, entry.id), undefined);
    const again = await execute(process.execPath, args, options);
    assert.match(again.stdout, /checkpoint are complete/);
    assert.equal(fs.readFileSync(path.join(f.tmp, 'analysis-count'), 'utf8'), 'scored\n');
  });
});

test('Mac CLI recovers a lost commit response without rescoring or duplicating entries', async t => {
  const f = await setup(t); f.seed();
  let drop = true;
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(f.privateUrl() + req.url, { method: req.method,
      ...(req.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (req.url.endsWith('/commit') && drop) { drop = false; req.socket.destroy(); return; }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const args = ['historical-worker.mjs', '2023-05-31', '--api-base', `http://127.0.0.1:${proxy.address().port}`,
    '--public-api-base', f.publicApi.baseUrl, '--state-file', path.join(f.tmp, 'checkpoint.json'), '--bucket-root', f.store];
  const options = { cwd: new URL('..', import.meta.url), env: { ...process.env, ...f.env } };
  await assert.rejects(execute(process.execPath, args, options));
  const resumed = await execute(process.execPath, args, options);
  assert.match(resumed.stdout, /1 historical source\(s\) committed/);
  assert.equal(fs.readFileSync(path.join(f.tmp, 'analysis-count'), 'utf8'), 'scored\n');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM diary_entries').get().count, 1);
});
