/** Raised when the same diary record already has queued or running work. */
export class ReanalysisAlreadyRunningError extends Error {
  constructor(recordId) {
    super(`re-analysis is already queued or running for ${recordId}`);
    this.name = "ReanalysisAlreadyRunningError";
    this.recordId = recordId;
  }
}

/**
 * Bound expensive analyses globally while rejecting duplicate record IDs.
 * Distinct records wait FIFO; a record remains reserved while queued.
 */
export function createReanalysisLimiter({ concurrency = 1 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("re-analysis concurrency must be a positive integer");
  }

  const scheduledRecordIds = new Set();
  const waiting = [];
  let activeCount = 0;

  const acquire = async () => {
    if (activeCount < concurrency) {
      activeCount++;
      return;
    }
    await new Promise(resolve => waiting.push(resolve));
  };

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else activeCount--;
  };

  return {
    async run(recordId, operation) {
      if (scheduledRecordIds.has(recordId)) {
        throw new ReanalysisAlreadyRunningError(recordId);
      }
      scheduledRecordIds.add(recordId);

      await acquire();
      try {
        return await operation();
      } finally {
        scheduledRecordIds.delete(recordId);
        release();
      }
    },

    isScheduled(recordId) {
      return scheduledRecordIds.has(recordId);
    },

    get activeCount() {
      return activeCount;
    },

    get pendingCount() {
      return waiting.length;
    },
  };
}
