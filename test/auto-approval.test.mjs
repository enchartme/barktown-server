import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_APPROVAL_SETTINGS, autoApprovalMetrics, passesAutoApproval, sparseTailTrimBounds } from '../lib/auto-approval.mjs';
import {
  autoApproveDay, getDiaryEntry, getHitMetadata, listApprovalEvents, listSettings, openDb,
  setDiaryApproved, setDiaryTrim, updateFilterSettings, upsertDiaryEntry, upsertHitMetadata, upsertSample,
} from '../lib/db.mjs';

const defaults = Object.fromEntries(AUTO_APPROVAL_SETTINGS.map(row => [row.key, row.value]));
const entry = { id: 'pass', filename: 'pass.mp3', audioPath: 'audio/pass.mp3', date: '2026-11-26',
  time: '12:00', datetimeLocal: '2026-11-26T12:00:00', durationSec: 8, kind: 'audio' };
const metadata = { timestamps: [2, 4], loudnesses: [3, 5], confidences: [1, 1], windowS: 2,
  multilabelScores: [{ bark: .9, wind: .1 }, { yap: 1, background: 0 }] };

test('all four conditions are inclusive and use precise unrounded metrics and actual window duration', () => {
  const metrics = autoApprovalMetrics(entry, metadata);
  assert.equal(metrics.meanLoudness, 4);
  assert.equal(metrics.density, 50);
  assert.ok(Math.abs(metrics.deltaMean - .9) < 1e-12);
  assert.ok(Math.abs(metrics.deltaSigma - .1) < 1e-12);
  assert.equal(passesAutoApproval(metrics, defaults), true);
  for (const [key, value] of [['meanLoudness', 3.999], ['density', 49.999], ['deltaMean', .8999], ['deltaSigma', .1001]]) {
    assert.equal(passesAutoApproval({ ...metrics, [key]: value }, defaults), false, key);
  }
  assert.equal(passesAutoApproval(autoApprovalMetrics(entry, { ...metadata, windowS: 1.5 }), defaults), false);
});

test('AND requires all four conditions and OR accepts each individual condition including sigma', () => {
  const failing = { meanLoudness: 1, density: 0, deltaMean: 0, deltaSigma: 1 };
  const orSettings = { ...defaults, auto_approve_require_all: 0 };
  assert.equal(passesAutoApproval(failing, orSettings), false);
  assert.equal(passesAutoApproval(null, orSettings), false);
  for (const [metric, value] of [['meanLoudness', 4], ['density', 50], ['deltaMean', .9], ['deltaSigma', .1]]) {
    const onePassing = { ...failing, [metric]: value };
    assert.equal(passesAutoApproval(onePassing, orSettings), true, `${metric} alone passes OR`);
    assert.equal(passesAutoApproval(onePassing, defaults), false, `${metric} alone fails AND`);
    const { auto_approve_require_all, ...legacySettings } = defaults;
    assert.equal(passesAutoApproval(onePassing, legacySettings), false, 'missing mode keeps AND');
  }
  const allPassing = autoApprovalMetrics(entry, metadata);
  assert.equal(passesAutoApproval(allPassing, orSettings), true);
  assert.equal(passesAutoApproval(allPassing, defaults), true);
});

test('day operation uses the saved join mode, audits it, and still requires complete multi-window evidence', () => {
  const db = openDb(':memory:');
  try {
    const densityOnly = { ...metadata, loudnesses: [1, 1], multilabelScores: [{ bark: 0, wind: 1 }, { bark: 1, wind: 0 }] };
    for (const id of ['density-only', 'missing-scores', 'singleton', 'none-pass']) upsertDiaryEntry(db, { ...entry, id });
    upsertHitMetadata(db, 'density-only', densityOnly);
    upsertHitMetadata(db, 'missing-scores', { ...densityOnly, multilabelScores: null });
    upsertHitMetadata(db, 'singleton', { timestamps: [2], loudnesses: [4], confidences: [1], windowS: 2, multilabelScores: [{ bark: 1, wind: 0 }] });
    upsertHitMetadata(db, 'none-pass', { ...densityOnly, windowS: 1 });
    assert.equal(autoApproveDay(db, entry.date).approved, 0);
    updateFilterSettings(db, { auto_approve_require_all: 0 });
    const result = autoApproveDay(db, entry.date);
    assert.equal(result.approved, 1);
    assert.equal(result.skipped, 3);
    assert.equal(result.items[0].id, 'density-only');
    const [event] = listApprovalEvents(db, 'density-only');
    assert.equal(event.details.thresholds.auto_approve_require_all, 0);
    assert.equal(event.details.ruleVersion, 3);
    assert.equal(event.details.metrics.density, 50);
    updateFilterSettings(db, { auto_approve_require_all: 1 });
    assert.equal(listApprovalEvents(db, 'density-only')[0].details.thresholds.auto_approve_require_all, 0);
    assert.equal(autoApproveDay(db, entry.date).alreadyApproved, 1);
  } finally { db.close(); }
});

test('saved trim uses half-open bounds and all unfiltered diagnostics, with population sigma', () => {
  const trimmed = { ...entry, durationSec: 20, trimStartMs: 5000, trimStopMs: 13000 };
  const raw = { ...metadata, timestamps: [1, 5, 9, 13], loudnesses: [0, 3, 5, 0],
    multilabelScores: [{ wind: 1 }, ...metadata.multilabelScores, { wind: 1 }], filteredHits: [false, true, false, false] };
  assert.deepEqual(autoApprovalMetrics(trimmed, raw), { ...autoApprovalMetrics(entry, metadata), startSec: 5, stopSec: 13 });
  const inconsistent = autoApprovalMetrics(entry, { ...metadata, timestamps: [1, 2, 3, 4], loudnesses: [4, 4, 4, 4],
    multilabelScores: [.69, 1, 1, 1].map(bark => ({ bark, wind: 0 })) });
  assert.ok(inconsistent.deltaMean > .9);
  assert.equal(passesAutoApproval(inconsistent, defaults), false);
});

test('missing metadata, incomplete diagnostics and singletons stay unapproved', () => {
  for (const value of [null, {}, { ...metadata, windowS: 0 }, { ...metadata, windowS: NaN },
    { ...metadata, timestamps: [] }, { ...metadata, timestamps: [2] },
    { ...metadata, multilabelScores: null }, { ...metadata, multilabelScores: [{ bark: 1 }, { bark: 1, wind: 0 }] },
    { ...metadata, loudnesses: [4] }]) {
    assert.equal(autoApprovalMetrics(entry, value), null);
  }
});

test('day approval preserves approvals, freezes its audit, is repeatable, and invalidates changed auto evidence', () => {
  const db = openDb(':memory:');
  try {
    for (const id of ['pass', 'manual', 'missing', 'weak']) upsertDiaryEntry(db, { ...entry, id });
    for (const id of ['pass', 'manual']) upsertHitMetadata(db, id, metadata);
    upsertHitMetadata(db, 'weak', { ...metadata, loudnesses: [1, 1] });
    const manual = setDiaryApproved(db, 'manual', true);
    for (const id of ['sample-one', 'sample-two']) upsertSample(db, { ...entry, id, label: 'bark', diaryId: 'pass' });
    updateFilterSettings(db, { filter_bark_min: 1, filter_yap_min: 1 });
    const result = autoApproveDay(db, entry.date);
    assert.deepEqual({ ...result, items: [] }, { date: entry.date, evaluated: 3, approved: 1, trimmed: 0, alreadyApproved: 1, skipped: 2, items: [] });
    assert.equal(getDiaryEntry(db, 'manual').approved, manual.approved);
    assert.equal(getDiaryEntry(db, 'manual').approvalSource, 'manual');
    assert.equal(getDiaryEntry(db, 'pass').approvalSource, 'auto');
    const [event] = listApprovalEvents(db, 'pass');
    assert.equal(event.approved, getDiaryEntry(db, 'pass').approved);
    assert.equal(event.source, 'auto');
    assert.equal(event.details.ruleVersion, 3);
    assert.deepEqual(event.details.thresholds, defaults);
    assert.equal(event.details.metrics.density, 50);
    assert.equal(event.details.analyzedAt, getHitMetadata(db, 'pass').analyzedAt);
    assert.ok(Date.parse(event.details.analyzedAt));
    updateFilterSettings(db, { auto_approve_mean_loudness_min: 5 });
    assert.equal(listApprovalEvents(db, 'pass')[0].details.thresholds.auto_approve_mean_loudness_min, 4);
    assert.equal(autoApproveDay(db, entry.date).approved, 0);
    assert.equal(listApprovalEvents(db, 'pass').length, 1);
    setDiaryTrim(db, 'pass', { trimStartMs: 0, trimStopMs: 7000 });
    assert.equal(getDiaryEntry(db, 'pass').approved, null);
    assert.equal(getDiaryEntry(db, 'pass').approvalSource, null);
    assert.equal(listApprovalEvents(db, 'pass')[1].details.reason, 'trim_changed');
    updateFilterSettings(db, { auto_approve_mean_loudness_min: 4 });
    assert.equal(autoApproveDay(db, entry.date).approved, 1);
    upsertHitMetadata(db, 'pass', metadata);
    assert.equal(getDiaryEntry(db, 'pass').approved, null);
    assert.equal(listApprovalEvents(db, 'pass').at(-1).details.reason, 'analysis_replaced');
    setDiaryApproved(db, 'manual', false);
    assert.equal(listApprovalEvents(db, 'manual').at(-1).source, 'manual');
  } finally { db.close(); }
});

test('new fields remain nullable and migrations preserve historical approvals and unknown analysis times', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-approval-migration-'));
  const file = path.join(directory, 'db.sqlite');
  let db = openDb(file);
  try {
    upsertDiaryEntry(db, entry);
    upsertHitMetadata(db, entry.id, metadata);
    db.prepare('UPDATE diary_entries SET approved = ?').run('2026-01-01T00:00:00Z');
    db.exec('ALTER TABLE diary_entries DROP COLUMN approval_source');
    db.exec('ALTER TABLE hit_metadata DROP COLUMN analyzed_at');
    db.close();
    db = openDb(file);
    assert.equal(getDiaryEntry(db, entry.id).approved, '2026-01-01T00:00:00Z');
    assert.equal(getDiaryEntry(db, entry.id).approvalSource, null);
    assert.equal(getHitMetadata(db, entry.id).analyzedAt, null);
    assert.deepEqual(listApprovalEvents(db, entry.id), []);
    assert.equal(autoApproveDay(db, entry.date).alreadyApproved, 1);
    for (const [table, column] of [['diary_entries', 'approval_source'], ['hit_metadata', 'analyzed_at']]) {
      assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().find(row => row.name === column).notnull, 0);
    }
    setDiaryApproved(db, entry.id, false);
    assert.equal(autoApproveDay(db, entry.date).approved, 1);
    assert.equal(listApprovalEvents(db, entry.id).at(-1).details.analyzedAt, null);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('approval settings validate ranges atomically', () => {
  const db = openDb(':memory:');
  try {
    for (const invalid of [
      { auto_approve_mean_loudness_min: .9 }, { auto_approve_mean_loudness_min: 10.1 },
      { auto_approve_density_min: -1 }, { auto_approve_density_min: 101 },
      { auto_approve_delta_mean_min: .49 }, { auto_approve_delta_mean_min: 1.01 },
      { auto_approve_delta_sigma_max: -.01 }, { auto_approve_delta_sigma_max: 1.01 },
      { auto_approve_density_min: '50' }, { auto_approve_density_min: 70, filter_wind_max: 2 },
      { auto_approve_trim_sparse_tails_s: -1 }, { auto_approve_trim_sparse_tails_s: 121 },
      { auto_approve_bundle_count: 0 }, { auto_approve_bundle_count: 6 }, { auto_approve_bundle_count: 1.5 },
      { auto_approve_require_all: -1 }, { auto_approve_require_all: 2 }, { auto_approve_require_all: .5 },
      { auto_approve_require_all: 'OR' }, { auto_approve_require_all: false },
    ]) assert.throws(() => updateFilterSettings(db, invalid));
    assert.equal(listSettings(db).find(row => row.key === 'auto_approve_density_min').value, 50);
    updateFilterSettings(db, { auto_approve_density_min: 70, auto_approve_delta_sigma_max: 0 });
    assert.equal(listSettings(db).find(row => row.key === 'auto_approve_density_min').value, 70);
  } finally { db.close(); }
});

const tailSettings = { ...defaults, auto_approve_trim_sparse_tails_s: 20, auto_approve_bundle_count: 2 };
const longEntry = { ...entry, durationSec: 400 };

test('sparse-tail trim keeps multiple supported sessions and every gap and window between them', () => {
  const timestamps = [0, 40, 45, 100, 110, 125, 180, 240, 250, 265, 320, 360, 365];
  const raw = { timestamps, windowS: 1.5, loudnesses: timestamps.map(() => 4),
    multilabelScores: timestamps.map(() => ({ bark: 1, wind: 0 })) };
  const trim = sparseTailTrimBounds(longEntry, raw, tailSettings);
  assert.deepEqual(trim, { trimStartMs: 98500, trimStopMs: 265001 });
  const metrics = autoApprovalMetrics({ ...longEntry, ...trim }, raw);
  assert.equal(metrics.windowCount, 7, 'includes the isolated middle hit and both sessions, including their last hit');
  assert.deepEqual(raw.timestamps, timestamps, 'raw windows are retained');
  assert.equal(sparseTailTrimBounds(longEntry, raw, defaults), null, 'default 0 seconds is off');
  const reversed = { ...raw, timestamps: [...timestamps].reverse() };
  assert.deepEqual(sparseTailTrimBounds(longEntry, reversed, tailSettings), trim);
});

test('bundle needs an extra distinct window before or after, with strict neighbour distance and inclusive bundle span', () => {
  const find = (timestamps, bundleCount = 2) => sparseTailTrimBounds(longEntry, { timestamps, windowS: 2 },
    { ...tailSettings, auto_approve_bundle_count: bundleCount });
  assert.equal(find([100, 110]), null, 'an isolated pair is not enough for B=2');
  assert.deepEqual(find([100, 120, 139]), { trimStartMs: 98000, trimStopMs: 139001 }, 'bundle spans exactly T, extra less than T after');
  assert.deepEqual(find([100, 115, 135]), { trimStartMs: 98000, trimStopMs: 135001 }, 'extra is before the qualifying bundle');
  assert.equal(find([100, 120], 1), null, 'exactly T to the extra window does not qualify');
  assert.deepEqual(find([100, 119], 1), { trimStartMs: 98000, trimStopMs: 119001 });
  assert.equal(find([100, 100], 1), null, 'a repeated timestamp is not its own supporting window');
  assert.equal(find([100, 115, 130, 145], 3), null, 'nearby consecutive gaps alone do not make a compact B=3 bundle');
  for (let count = 1; count <= 5; count++) {
    assert.ok(find(Array.from({ length: count + 1 }, (_, i) => 100 + i), count), `B=${count} plus extra qualifies`);
  }
});

test('sparse trimming respects saved bounds, keeps full first-window audio, and does nothing without valid evidence', () => {
  const raw = { timestamps: [1, 2, 100, 110, 125, 240, 250, 265], windowS: 3 };
  assert.deepEqual(sparseTailTrimBounds({ ...longEntry, trimStartMs: 99000, trimStopMs: 200000 }, raw, tailSettings),
    { trimStartMs: 99000, trimStopMs: 125001 }, 'never expands a manual trim or includes a session beyond it');
  const whole = { ...longEntry, durationSec: 4 };
  assert.equal(sparseTailTrimBounds(whole, { timestamps: [1, 3.9999], windowS: 2 }, { ...tailSettings, auto_approve_bundle_count: 1 }), null,
    'no change when the first full window and final anchor cover the current range');
  for (const raw of [null, {}, { timestamps: [], windowS: 2 }, { timestamps: [100, NaN, 110], windowS: 2 }, { timestamps: [100, 110], windowS: 0 }]) {
    assert.equal(sparseTailTrimBounds(longEntry, raw, tailSettings), null);
  }
});

test('day operation evaluates proposed trim, saves only passing trims, preserves existing approvals, and audits both bounds', () => {
  const db = openDb(':memory:');
  try {
    const base = { ...entry, durationSec: 200, trimStartMs: 1000, trimStopMs: 199000 };
    for (const id of ['trim-pass', 'trim-fail', 'approved']) {
      upsertDiaryEntry(db, { ...base, id });
      upsertHitMetadata(db, id, { timestamps: [5, 100, 105, 190], windowS: 2,
        loudnesses: [1, 4, id === 'trim-fail' ? 1 : 4, 1], confidences: [1, 1, 1, 1],
        multilabelScores: [{ bark: 0, wind: 1 }, { bark: 1, wind: 0 }, { bark: 1, wind: 0 }, { bark: 0, wind: 1 }] });
    }
    const approved = setDiaryApproved(db, 'approved', true);
    assert.equal(autoApproveDay(db, entry.date).approved, 0, 'disabled trimming uses the original evidence');
    updateFilterSettings(db, { auto_approve_trim_sparse_tails_s: 20, auto_approve_bundle_count: 1 });
    const result = autoApproveDay(db, entry.date);
    assert.equal(result.trimmed, 1);
    assert.equal(result.approved, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.alreadyApproved, 1);
    assert.deepEqual(result.items[0], { id: 'trim-pass', approved: getDiaryEntry(db, 'trim-pass').approved,
      approvalSource: 'auto', trimStartMs: 98000, trimStopMs: 105001 });
    const failed = getDiaryEntry(db, 'trim-fail');
    assert.equal(failed.approved, null);
    assert.equal(failed.trimStartMs, 1000);
    assert.equal(failed.trimStopMs, 199000);
    assert.equal(getDiaryEntry(db, 'approved').approved, approved.approved);
    assert.equal(getDiaryEntry(db, 'approved').trimStartMs, 1000);
    assert.equal(getDiaryEntry(db, 'approved').trimStopMs, 199000);
    const [audit] = listApprovalEvents(db, 'trim-pass');
    assert.deepEqual(audit.details.sparseTailTrim, {
      before: { trimStartMs: 1000, trimStopMs: 199000 }, after: { trimStartMs: 98000, trimStopMs: 105001 },
    });
    assert.equal(audit.details.metrics.windowCount, 2);
    assert.equal(audit.details.trimStartMs, 98000);
    assert.equal(getHitMetadata(db, 'trim-pass').timestamps.length, 4, 'raw metadata is never removed');
  } finally { db.close(); }
});

test('audit failure rolls back the proposed trim and approval together', () => {
  const db = openDb(':memory:');
  try {
    upsertDiaryEntry(db, { ...longEntry, id: 'rollback' });
    upsertHitMetadata(db, 'rollback', metadata);
    updateFilterSettings(db, { auto_approve_trim_sparse_tails_s: 20 });
    db.exec("CREATE TRIGGER reject_approval BEFORE INSERT ON approval_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
    assert.throws(() => autoApproveDay(db, entry.date), /test audit failure/);
    assert.equal(getDiaryEntry(db, 'rollback').approved, null);
    assert.equal(getDiaryEntry(db, 'rollback').trimStartMs, null);
    assert.equal(getDiaryEntry(db, 'rollback').trimStopMs, null);
  } finally { db.close(); }
});
