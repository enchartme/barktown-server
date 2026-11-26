import { randomUUID } from 'node:crypto';
import { runBulkReanalysis } from './bulk-reanalyze.mjs';

export class ReanalysisBusyError extends Error {
  constructor() {
    super('Re-analysis is already in progress. Wait for it to finish.');
  }
}

/** One process-wide reservation for all private re-analysis entry points. */
export function createReanalysisJobs() {
  const instanceId = randomUUID();
  let job = null;
  let revision = 0;
  const snapshot = () => ({ active: false, instanceId, revision, ...job,
    errors: (job?.errors ?? []).map(error => ({ ...error })),
    currentIds: [...(job?.currentIds ?? [])] });
  function reserve(details) {
    if (job?.active) throw new ReanalysisBusyError();
    job = { id: randomUUID(), active: true, completed: 0, failed: 0, skipped: 0,
      errors: [], currentIds: new Set(), ...details };
    revision++;
  }
  function finish() {
    job.active = false;
    job.currentIds.clear();
    revision++;
  }
  return {
    snapshot,
    progress(recordId, details) {
      if (job?.active && job.currentIds.has(recordId)) {
        Object.assign(job, details);
        revision++;
      }
    },
    startRecord(recordId, operation) {
      reserve({ kind: 'historical', recordId, total: 1, currentIds: new Set([recordId]) });
      void (async () => {
        try {
          const result = await operation();
          if (result?.error) throw new Error(result.error);
          Object.assign(job, result);
        } catch (error) {
          job.failed = 1;
          job.errors.push({ id: recordId, error: error.message });
        } finally { job.completed = 1; finish(); }
      })();
      return snapshot();
    },
    async run(recordId, operation) {
      reserve({ kind: 'single', recordId, total: 1, currentIds: new Set([recordId]) });
      try {
        const result = await operation();
        job.completed = 1;
        if (result?.error) {
          job.failed = 1;
          job.errors.push({ id: recordId, error: result.error });
        }
        return result;
      } catch (error) {
        job.failed = 1;
        throw error;
      } finally { finish(); }
    },
    startDay(date, prepare, analyze, concurrency = 1) {
      reserve({ kind: 'day', date, total: 0, preparing: true, replacementIds: [], replacementDates: [] });
      // Reserve synchronously, then detach work from the initiating HTTP request.
      void (async () => {
        try {
          const { entries, skipped = 0 } = await prepare();
          job.total = entries.length;
          job.skipped = skipped;
          job.preparing = false;
          revision++;
          await runBulkReanalysis(entries, {
            concurrency, analyze,
            onStart: ({ entry }) => { job.currentIds.add(entry.id); revision++; },
            onFinish: ({ entry, status, reason, value }) => {
              job.currentIds.delete(entry.id);
              job.completed++;
              if (status === 'fulfilled') {
                job.replacementIds.push(...(value?.replacementIds ?? []));
                job.replacementDates = [...new Set([...job.replacementDates, ...(value?.replacementDates ?? [])])];
              }
              if (status === 'rejected') {
                job.failed++;
                job.errors.push({ id: entry.id, error: reason?.message ?? String(reason) });
              }
              revision++;
            },
          });
        } catch (error) {
          job.errors.push({ error: error.message });
          job.failed++;
        } finally {
          job.preparing = false;
          finish();
        }
      })();
      return snapshot();
    },
  };
}
