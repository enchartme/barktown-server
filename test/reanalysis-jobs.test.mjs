import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createReanalysisJobs, ReanalysisBusyError } from '../lib/reanalysis-jobs.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('day reservation rejects all competing work even during preparation, and tracks real in-flight records', async () => {
  const jobs = createReanalysisJobs();
  const prep = deferred(), a = deferred(), b = deferred();
  const accepted = jobs.startDay('2026-11-22', () => prep.promise,
    entry => entry.id === 'a' ? a.promise : b.promise, 2);
  assert.equal(accepted.preparing, true);
  await assert.rejects(jobs.run('sample:x', () => {}), ReanalysisBusyError);
  assert.throws(() => jobs.startDay('2026-11-21', () => {}, () => {}), ReanalysisBusyError);
  prep.resolve({ entries: [{ id: 'a' }, { id: 'b' }], skipped: 1 });
  await setImmediate();
  assert.deepEqual(jobs.snapshot().currentIds, ['a', 'b']);
  a.resolve();
  await setImmediate();
  assert.equal(jobs.snapshot().completed, 1);
  assert.equal(jobs.snapshot().active, true);
  assert.deepEqual(jobs.snapshot().currentIds, ['b']);
  await assert.rejects(jobs.run('different-day-record', () => {}), ReanalysisBusyError);
  b.resolve();
  await setImmediate();
  assert.equal(jobs.snapshot().active, false);
  assert.equal(jobs.snapshot().completed, 2);
  assert.equal(jobs.snapshot().skipped, 1);
  await jobs.run('sample:x', async () => 'ok');
});

test('record failures do not stop the day and preparation failures release the lock', async () => {
  const jobs = createReanalysisJobs();
  const seen = [];
  jobs.startDay('2026-11-22', async () => ({ entries: [{ id: 'bad' }, { id: 'good' }] }), async entry => {
    seen.push(entry.id);
    if (entry.id === 'bad') throw new Error('scoring failed');
  });
  await setImmediate();
  assert.deepEqual(seen, ['bad', 'good']);
  assert.equal(jobs.snapshot().completed, 2);
  assert.equal(jobs.snapshot().failed, 1);
  assert.deepEqual(jobs.snapshot().errors, [{ id: 'bad', error: 'scoring failed' }]);
  jobs.startDay('2026-11-22', async () => { throw new Error('storage unavailable'); }, () => {});
  await setImmediate();
  assert.equal(jobs.snapshot().active, false);
  assert.equal(jobs.snapshot().preparing, false);
  assert.equal(jobs.snapshot().errors[0].error, 'storage unavailable');
  await jobs.run('single', () => {});
});

test('single recording jobs lock diary, sample and day work and release on errors', async () => {
  const jobs = createReanalysisJobs();
  const gate = deferred();
  const run = jobs.run('clip', () => gate.promise);
  assert.deepEqual(jobs.snapshot().currentIds, ['clip']);
  await assert.rejects(jobs.run('sample:clip', () => {}), ReanalysisBusyError);
  assert.throws(() => jobs.startDay('2026-11-22', () => {}, () => {}), ReanalysisBusyError);
  gate.resolve();
  await run;
  await assert.rejects(jobs.run('broken', () => { throw new Error('failed'); }), /failed/);
  assert.equal(jobs.snapshot().active, false);
  await jobs.run('retry', () => {});
});
