import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_APPROVAL_SETTINGS, autoApprovalMetrics, passesAutoApproval } from '../lib/auto-approval.mjs';
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
    assert.deepEqual({ ...result, items: [] }, { date: entry.date, evaluated: 3, approved: 1, alreadyApproved: 1, skipped: 2, items: [] });
    assert.equal(getDiaryEntry(db, 'manual').approved, manual.approved);
    assert.equal(getDiaryEntry(db, 'manual').approvalSource, 'manual');
    assert.equal(getDiaryEntry(db, 'pass').approvalSource, 'auto');
    const [event] = listApprovalEvents(db, 'pass');
    assert.equal(event.approved, getDiaryEntry(db, 'pass').approved);
    assert.equal(event.source, 'auto');
    assert.equal(event.details.ruleVersion, 1);
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
    ]) assert.throws(() => updateFilterSettings(db, invalid));
    assert.equal(listSettings(db).find(row => row.key === 'auto_approve_density_min').value, 50);
    updateFilterSettings(db, { auto_approve_density_min: 70, auto_approve_delta_sigma_max: 0 });
    assert.equal(listSettings(db).find(row => row.key === 'auto_approve_density_min').value, 70);
  } finally { db.close(); }
});
