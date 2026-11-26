import { setTimeout } from 'node:timers/promises';

/** A detached job must be positively identified and completed before another POST. */
export async function waitForReanalysisJob(accepted, recordId, readStatus, {
  sleep = () => setTimeout(1000), onProgress = () => {},
} = {}) {
  try {
    if (!accepted?.id || !accepted.instanceId || accepted.recordId !== recordId || accepted.kind !== 'historical') {
      throw new Error('Invalid historical job acceptance');
    }
    let job = accepted;
    for (;;) {
      if (job?.id !== accepted.id || job.instanceId !== accepted.instanceId || job.recordId !== recordId) {
        throw new Error('Job status changed or the private API restarted; completion cannot be confirmed');
      }
      onProgress(job);
      if (job.active === false) {
        if (job.failed || job.errors?.length) throw new Error(job.errors?.[0]?.error ?? 'Historical import failed');
        if (job.completed !== 1) throw new Error('Job ended without confirmed completion');
        return job;
      }
      if (job.active !== true) throw new Error('Invalid job progress response');
      await sleep();
      job = await readStatus();
    }
  } catch (error) {
    error.stopBulk = true;
    throw error;
  }
}
