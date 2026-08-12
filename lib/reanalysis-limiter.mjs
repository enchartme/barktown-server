/** Raised when the same diary record already has queued or running work. */
export class ReanalysisAlreadyRunningError extends Error {
  constructor(recordId) {
    super(`re-analysis is already queued or running for ${recordId}`);
    this.name = "ReanalysisAlreadyRunningError";
    this.recordId = recordId;
  }
}

/**
 * Serialize expensive analyses globally while rejecting duplicate record IDs.
 * Distinct records wait FIFO; a record remains reserved while queued.
 */
export function createReanalysisLimiter() {
  const scheduledRecordIds = new Set();
  let previousGate = Promise.resolve();

  return {
    async run(recordId, operation) {
      if (scheduledRecordIds.has(recordId)) {
        throw new ReanalysisAlreadyRunningError(recordId);
      }
      scheduledRecordIds.add(recordId);

      const waitForTurn = previousGate;
      let releaseTurn;
      previousGate = new Promise(resolve => { releaseTurn = resolve; });

      await waitForTurn;
      try {
        return await operation();
      } finally {
        scheduledRecordIds.delete(recordId);
        releaseTurn();
      }
    },

    isScheduled(recordId) {
      return scheduledRecordIds.has(recordId);
    },
  };
}
