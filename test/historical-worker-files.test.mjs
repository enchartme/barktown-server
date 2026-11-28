import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyMountedHistoricalSource, writeMountedHistoricalFile, commitWhenStagedFilesVisible, mountedObjectPath } from '../lib/historical-worker-files.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'barktown-mounted-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bucketRoot = path.join(root, 'bucket');
  await fs.mkdir(bucketRoot);
  const bytes = Buffer.from('complete historical source');
  const ticket = { archiveKey: 'historical-recordings-archive/2026/01/source.m4a',
    entry: { audioPath: 'audio/2026/01/source.m4a' }, archive: { size: bytes.length }, original: { size: bytes.length } };
  async function expose(key, data = bytes) {
    const file = mountedObjectPath(bucketRoot, key);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
  }
  return { bucketRoot, ticket, destination: path.join(root, 'local-source.m4a'), bytes, expose };
}

test('a cached mount can read the original while the freshly archived object is invisible', async t => {
  const f = await fixture(t); await f.expose(f.ticket.entry.audioPath);
  const key = await copyMountedHistoricalSource(f);
  assert.equal(key, f.ticket.entry.audioPath);
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
});

test('a visible archive is preferred and an incomplete archive falls back to the original', async t => {
  const f = await fixture(t); await f.expose(f.ticket.archiveKey); await f.expose(f.ticket.entry.audioPath);
  assert.equal(await copyMountedHistoricalSource(f), f.ticket.archiveKey);
  await f.expose(f.ticket.archiveKey, Buffer.from('partial'));
  assert.equal(await copyMountedHistoricalSource(f), f.ticket.entry.audioPath);
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
});

test('source visibility is retried without restarting the worker', async t => {
  const f = await fixture(t); let clock = 0, waits = 0;
  const key = await copyMountedHistoricalSource({ ...f, timeoutMs: 10, intervalMs: 2, now: () => clock,
    sleep: async ms => { clock += ms; waits++; await f.expose(f.ticket.archiveKey); } });
  assert.equal(key, f.ticket.archiveKey); assert.equal(waits, 1);
});

test('a missing source stops after a bounded wait and never reads an unavailable original', async t => {
  const f = await fixture(t); let clock = 0;
  f.ticket.original = null;
  await f.expose(f.ticket.entry.audioPath);
  await assert.rejects(copyMountedHistoricalSource({ ...f, timeoutMs: 5, intervalMs: 2,
    now: () => clock, sleep: async ms => { clock += ms; } }), /Timed out waiting for the mount/);
  assert.equal(clock, 5);
});

test('permission and local disk errors stop immediately rather than being mistaken for mount lag', async t => {
  const f = await fixture(t); await f.expose(f.ticket.archiveKey);
  for (const code of ['EACCES', 'EPERM', 'ENOSPC']) {
    let waits = 0;
    await assert.rejects(copyMountedHistoricalSource({ ...f,
      copyFile: async () => { throw Object.assign(new Error('Cannot copy'), { code }); },
      onWait: () => waits++ }), error => error.code === code);
    assert.equal(waits, 0);
  }
});

test('commit waits for mounted staging uploads to become visible without changing the manifest', async () => {
  let calls = 0, clock = 0;
  const expected = { replacementIds: ['clip'] };
  const result = await commitWhenStagedFilesVisible(async () => {
    if (++calls < 3) throw Object.assign(new Error('Missing or incomplete staged file: staged.wav'), { statusCode: 409 });
    return expected;
  }, { timeoutMs: 10, intervalMs: 2, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(result, expected); assert.equal(calls, 3); assert.equal(clock, 4);
});

test('commit refuses actual integrity errors and bounds the staging visibility wait', async () => {
  for (const message of ['Checksum mismatch: staged.wav', 'Source object changed: original.m4a', 'Event object already exists: clip.mp3']) {
    let calls = 0;
    await assert.rejects(commitWhenStagedFilesVisible(async () => {
      calls++; throw Object.assign(new Error(message), { statusCode: 409 });
    }), error => error.message === message);
    assert.equal(calls, 1);
  }
  let clock = 0;
  const pending = Object.assign(new Error('Missing or incomplete staged file: staged.wav'), { statusCode: 409 });
  await assert.rejects(commitWhenStagedFilesVisible(async () => { throw pending; }, {
    timeoutMs: 5, intervalMs: 2, now: () => clock, sleep: async ms => { clock += ms; },
  }), error => error === pending);
  assert.equal(clock, 5);
});

test('mount paths stay inside the bucket', () => {
  for (const key of ['../secret', '/etc/passwd', 'audio/../secret', 'audio\\secret']) {
    assert.throws(() => mountedObjectPath('/bucket', key), /Invalid bucket-relative path/);
  }
});

test('mounted staging retries permission errors during mkdir, copy and rename', async t => {
  for (const operation of ['mkdir', 'copyFile', 'rename']) await t.test(operation, async () => {
    let clock = 0, attempts = 0, renamed = false;
    const messages = [];
    await writeMountedHistoricalFile('/local/clip.wav', '/bucket/staging/0.wav', {
      timeoutMs: 10, intervalMs: 2, now: () => clock,
      sleep: async ms => { clock += ms; }, onWait: message => messages.push(message),
      mkdir: async () => {}, copyFile: async () => {}, rename: async () => { renamed = true; },
      [operation]: async (...args) => {
        if (++attempts <= 2) throw Object.assign(new Error('Transient mount denial'), { code: attempts === 1 ? 'EACCES' : 'EPERM' });
        if (operation === 'rename') {
          assert.match(args[0], /0\.wav\.\d+\.tmp$/);
          assert.equal(args[1], '/bucket/staging/0.wav');
          renamed = true;
        }
      },
    });
    assert.equal(attempts, 3); assert.equal(clock, 4); assert.equal(renamed, true);
    assert.equal(messages.length, 2);
  });
});

test('mounted staging bounds permission retries and propagates other write errors immediately', async () => {
  for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'ENOENT']) {
    let clock = 0, renames = 0;
    const failure = Object.assign(new Error('Cannot write staging file'), { code });
    await assert.rejects(writeMountedHistoricalFile('/local/clip.wav', '/bucket/staging/0.wav', {
      timeoutMs: 5, intervalMs: 2, now: () => clock, sleep: async ms => { clock += ms; },
      mkdir: async () => {}, copyFile: async () => { throw failure; }, rename: async () => { renames++; },
    }), error => error === failure);
    assert.equal(clock, ['EACCES', 'EPERM'].includes(code) ? 5 : 0);
    assert.equal(renames, 0);
  }
});
