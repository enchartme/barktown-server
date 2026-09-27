/** Raised when the same diary record already has queued or running work. */
export class ReanalysisAlreadyRunningError extends Error {
  constructor(recordId) {
    super(`re-analysis is already queued or running for ${recordId}`);
    this.name = "ReanalysisAlreadyRunningError";
    this.recordId = recordId;
  }
}

/**
 * Bound expensive analyses by weighted CPU slots while rejecting duplicate
 * record IDs. Distinct records wait FIFO; a record remains reserved while
 * queued. Interactive jobs can reserve the full budget while bulk jobs use one.
 */
export function createReanalysisLimiter({ concurrency = 1 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("re-analysis concurrency must be a positive integer");
  }

  const scheduledRecordIds = new Set();
  const waiting = [];
  let activeCount = 0;
  let activeSlots = 0;

  const validateSlots = (slots) => {
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > concurrency) {
      throw new TypeError(`re-analysis slots must be an integer in [1, ${concurrency}]`);
    }
  };

  const start = (slots) => {
    activeSlots += slots;
    activeCount++;
  };

  const drain = () => {
    while (waiting.length > 0) {
      const next = waiting[0];
      if (activeSlots + next.slots > concurrency) return;
      waiting.shift();
      start(next.slots);
      next.resolve();
    }
  };

  const acquire = async (slots) => {
    if (waiting.length === 0 && activeSlots + slots <= concurrency) {
      start(slots);
      return;
    }
    await new Promise(resolve => waiting.push({ slots, resolve }));
  };

  const release = (slots) => {
    activeSlots -= slots;
    activeCount--;
    drain();
  };

  return {
    async run(recordId, operation, { slots = 1 } = {}) {
      validateSlots(slots);
      if (scheduledRecordIds.has(recordId)) {
        throw new ReanalysisAlreadyRunningError(recordId);
      }
      scheduledRecordIds.add(recordId);

      await acquire(slots);
      try {
        return await operation();
      } finally {
        scheduledRecordIds.delete(recordId);
        release(slots);
      }
    },

    isScheduled(recordId) {
      return scheduledRecordIds.has(recordId);
    },

    get activeCount() {
      return activeCount;
    },

    get activeSlots() {
      return activeSlots;
    },

    get pendingCount() {
      return waiting.length;
    },
  };
}
