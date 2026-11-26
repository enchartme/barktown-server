import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { openDb } from '../lib/db.mjs';
import { startTestServer } from './helpers/test-server.mjs';

// Capture wire bytes: fetch() would decompress automatically.
function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end();
  });
}

test('public projection API streams negotiated gzip from MinIO', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'barktown-projection-api-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'test.db');
  const db = openDb(dbPath);
  db.close();
  const file = path.join(directory, 'projection.csv');
  const csv = 'embedding_id,umap_x,umap_y\n' + 'bark/sample_1000-2500:0000,-3.0557,7.2472\n'.repeat(2000);
  await fs.writeFile(file, csv);
  const env = {
    MINIO_BUCKET: 'projection-fixture',
    PROJECTION_TEST_FILE: file,
    NODE_OPTIONS: `--import=${new URL('./fixtures/projection-minio.mjs', import.meta.url).pathname}`,
  };
  const publicApi = await startTestServer({ dbPath, mode: 'public', env });
  t.after(() => publicApi.stop());
  const privateApi = await startTestServer({ dbPath, mode: 'private', env });
  t.after(() => privateApi.stop());
  const url = `${publicApi.baseUrl}/api/training/projection.csv`;

  await t.test('gzip wire response decompresses to the complete CSV with CORS and no-store', async () => {
    const res = await request(url, { 'Accept-Encoding': 'gzip', Origin: 'https://ui.example' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.match(res.headers['content-type'], /^text\/csv; charset=utf-8$/);
    assert.match(res.headers.vary, /accept-encoding/i);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], 'https://ui.example');
    assert.equal(res.headers['content-length'], undefined);
    assert.equal(gunzipSync(res.body).toString(), csv);
    assert.ok(res.body.length < Buffer.byteLength(csv) / 2);
  });

  await t.test('identity, missing encoding, and gzip;q=0 receive plain CSV', async () => {
    for (const headers of [{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'gzip;q=0, identity;q=1' }]) {
      const res = await request(url, headers);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(res.body.toString(), csv);
    }
  });

  await t.test('replaced MinIO object is served on the next request', async () => {
    await fs.writeFile(file, `${csv}bark/new_1000-2500:0000,1.2345,6.7891\n`);
    const res = await request(url, { 'Accept-Encoding': 'gzip' });
    assert.equal(gunzipSync(res.body).toString(), `${csv}bark/new_1000-2500:0000,1.2345,6.7891\n`);
  });

  await t.test('HEAD returns no body and the route is absent from the private API', async () => {
    const head = await request(url, { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal((await request(`${privateApi.baseUrl}/api/training/projection.csv`)).status, 404);
  });

  await t.test('missing objects return 404 and other storage errors return 502', async () => {
    await fs.unlink(file);
    const missing = await request(url);
    assert.equal(missing.status, 404);
    assert.deepEqual(JSON.parse(missing.body), { error: 'training projection not found' });
    await fs.writeFile(`${file}.error`, 'ServiceUnavailable');
    const unavailable = await request(url);
    assert.equal(unavailable.status, 502);
    assert.deepEqual(JSON.parse(unavailable.body), { error: 'training projection storage unavailable' });
  });
});
