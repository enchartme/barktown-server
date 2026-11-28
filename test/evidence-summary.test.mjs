import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertDiaryEntry, upsertHitMetadata, getEvidenceSummary } from '../lib/db.mjs';

test('corpus facts include all diary rows and full duration only where barks were detected', () => {
  const db = openDb(':memory:');
  try {
    assert.deepEqual(getEvidenceSummary(db), {
      firstDate: null, records: 0, barks: 0, recordedTimeBarkingSec: 0,
    });
    const entries = [
      { id: 'text', date: '2021-02-03', kind: 'text', durationSec: 0 },
      { id: 'empty', date: '2022-02-03', kind: 'text', durationSec: 0 },
      { id: 'audio-note', date: '2023-02-03', kind: 'audio', durationSec: 60 },
      { id: 'no-barks', date: '2024-02-03', kind: 'audio', durationSec: 120 },
      { id: 'historical', date: '2025-02-03', kind: 'audio', durationSec: 180.25,
        trimStartMs: 2000, trimStopMs: 6000 },
      { id: 'recent', date: '2026-09-03', kind: 'audio', durationSec: 10 },
    ];
    for (const entry of entries) {
      upsertDiaryEntry(db, { filename: entry.id, audioPath: '', label: '',
        time: '12:00', datetimeLocal: `${entry.date}T12:00:00`, ...entry });
    }
    for (const [id, timestamps] of [
      ['no-barks', []], ['historical', [1, 3, 7]], ['recent', [2]], ['orphan', [1, 2]],
    ]) {
      upsertHitMetadata(db, id, {
        timestamps, confidences: timestamps.map(() => 0.99),
        loudnesses: timestamps.map(() => 1), paddingS: 1.5, windowS: 1.5,
      });
    }
    assert.deepEqual(getEvidenceSummary(db), {
      firstDate: '2021-02-03', records: 6, barks: 4, recordedTimeBarkingSec: 190.25,
    });
  } finally {
    db.close();
  }
});
