import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReanalysisJob } from '../lib/reanalysis-job-client.mjs';

const accepted = { id: 'job', instanceId: 'server', recordId: 'original', kind: 'historical', active: true };
const done = { ...accepted, active: false, completed: 1, failed: 0, replacementIds: ['clip'] };
const options = { sleep: async () => {} };

test('waits for the matching asynchronous job and returns its event clips', async () => {
  const states = [{ ...accepted, stage: 'analyzing' }, done];
  assert.deepEqual(await waitForReanalysisJob(accepted, 'original', async () => states.shift(), options), done);
  assert.equal(states.length, 0);
});

test('failed, lost, restarted, malformed and disconnected jobs stop further bulk work', async () => {
  for (const state of [
    { ...done, failed: 1, errors: [{ error: 'decode failed' }] },
    { ...done, instanceId: 'restarted' }, { ...done, id: 'another job' },
    { ...done, completed: 0 }, {},
  ]) {
    await assert.rejects(waitForReanalysisJob(accepted, 'original', async () => state, options), error => error.stopBulk === true);
  }
  await assert.rejects(waitForReanalysisJob(accepted, 'original', async () => { throw new Error('disconnected'); }, options),
    error => error.stopBulk && /disconnected/.test(error.message));
  await assert.rejects(waitForReanalysisJob({}, 'original', async () => done, options), /Invalid.*acceptance/);
});
