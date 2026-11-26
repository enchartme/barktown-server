import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  auditSampleDiaryLinks,
  localTimestampSecond,
} from "../lib/sample-diary-links.mjs";

const diary = (id, datetimeLocal) => ({ id, datetimeLocal });
const sample = (id, datetimeLocal, diaryId = null, status = "active") => ({
  id,
  datetimeLocal,
  diaryId,
  status,
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("timestamps are compared as local identities down to seconds", () => {
  assert.equal(localTimestampSecond("2026-10-05T12:34:56.789"), "2026-10-05T12:34:56");
  assert.equal(localTimestampSecond("2026-10-05 12:34:56"), "2026-10-05T12:34:56");
  assert.equal(localTimestampSecond("2026-02-30T12:34:56"), null);
  assert.equal(localTimestampSecond("2026-10-05T12:34"), null);
});

test("an unlinked one-to-one timestamp match is recoverable from both directions", () => {
  const audit = auditSampleDiaryLinks(
    [diary("diary-1", "2026-10-05T12:34:56")],
    [sample("sample-1", "2026-10-05T12:34:56")],
  );

  assert.deepEqual(audit.repairableLinks, [{
    timestamp: "2026-10-05T12:34:56",
    sampleId: "sample-1",
    diaryId: "diary-1",
    previousDiaryId: null,
    reason: "unlinked",
  }]);
  assert.equal(audit.counts.sampleMissingTargets, 0);
  assert.equal(audit.counts.diaryMissingTargets, 0);
});

test("orphaned and timestamp-mismatched links are reassigned deterministically", () => {
  const audit = auditSampleDiaryLinks(
    [
      diary("diary-1", "2026-10-05T12:00:00"),
      diary("diary-2", "2026-10-05T13:00:00"),
    ],
    [
      sample("sample-1", "2026-10-05T12:00:00", "missing-diary"),
      sample("sample-2", "2026-10-05T13:00:00", "diary-1"),
    ],
  );

  assert.deepEqual(
    audit.repairableLinks.map(({ sampleId, diaryId, reason }) => ({ sampleId, diaryId, reason })),
    [
      { sampleId: "sample-1", diaryId: "diary-1", reason: "orphaned-target" },
      { sampleId: "sample-2", diaryId: "diary-2", reason: "timestamp-mismatch" },
    ],
  );
  assert.equal(audit.orphanedCurrentLinks.length, 1);
  assert.equal(audit.mismatchedCurrentLinks.length, 1);
});

test("missing targets are reported independently from both sides", () => {
  const audit = auditSampleDiaryLinks(
    [diary("diary-only", "2026-10-05T12:00:00")],
    [sample("sample-only", "2026-10-05T13:00:00")],
  );

  assert.equal(audit.repairableLinks.length, 0);
  assert.deepEqual(audit.sampleMissingTargets.map((row) => row.sampleId), ["sample-only"]);
  assert.deepEqual(audit.diaryMissingTargets.map((row) => row.diaryId), ["diary-only"]);
});

test("duplicate timestamps are reported and never guessed", () => {
  const timestamp = "2026-10-05T12:00:00";
  const audit = auditSampleDiaryLinks(
    [diary("diary-1", timestamp)],
    [sample("sample-1", timestamp), sample("sample-2", timestamp)],
  );

  assert.equal(audit.repairableLinks.length, 0);
  assert.deepEqual(audit.ambiguousTimestamps, [{
    timestamp,
    diaryIds: ["diary-1"],
    sampleIds: ["sample-1", "sample-2"],
  }]);
});

test("a target occupied by a sample with no destination blocks the repair", () => {
  const audit = auditSampleDiaryLinks(
    [diary("diary-1", "2026-10-05T12:00:00")],
    [
      sample("sample-1", "2026-10-05T12:00:00"),
      sample("stray-sample", "2026-10-05T13:00:00", "diary-1"),
    ],
  );

  assert.equal(audit.repairableLinks.length, 0);
  assert.deepEqual(audit.blockedRepairs[0].blockingSampleIds, ["stray-sample"]);
  assert.deepEqual(audit.sampleMissingTargets.map((row) => row.sampleId), ["stray-sample"]);
});

test("inactive samples neither claim diary targets nor create ambiguity", () => {
  const timestamp = "2026-10-05T12:00:00";
  const audit = auditSampleDiaryLinks(
    [diary("diary-1", timestamp)],
    [
      sample("sample-active", timestamp),
      sample("sample-deleted", timestamp, "diary-1", "deleted"),
    ],
  );

  assert.equal(audit.repairableLinks.length, 1);
  assert.equal(audit.ambiguousTimestamps.length, 0);
});

test("non-audio diary notes are not sample-link targets", () => {
  const timestamp = "2026-10-05T12:00:00";
  const audit = auditSampleDiaryLinks(
    [{ ...diary("note-1", timestamp), kind: "note" }],
    [sample("sample-1", timestamp)],
  );

  assert.equal(audit.counts.diaries, 0);
  assert.deepEqual(audit.sampleMissingTargets.map((row) => row.sampleId), ["sample-1"]);
});

test("CLI is read-only by default and applies the audited link on request", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-link-repair-"));
  const dbPath = path.join(directory, "links.db");
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE diary_entries (
        id TEXT PRIMARY KEY,
        datetime_local TEXT NOT NULL,
        kind TEXT NOT NULL,
        audio_path TEXT, waveform_path TEXT, updated_at TEXT
      );
      CREATE TABLE samples (
        id TEXT PRIMARY KEY,
        diary_id TEXT,
        datetime_local TEXT NOT NULL,
        status TEXT NOT NULL,
        audio_path TEXT, waveform_path TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO diary_entries (id, datetime_local, kind) VALUES (?, ?, 'audio')")
      .run("diary-1", "2026-10-05T12:34:56");
    db.prepare(`
      INSERT INTO samples (id, diary_id, datetime_local, status, updated_at)
      VALUES (?, NULL, ?, 'active', ?)
    `).run("sample-1", "2026-10-05T12:34:56", "2026-10-05T00:00:00Z");

    const dryRun = spawnSync(
      process.execPath,
      ["repair-sample-diary-links.mjs", "--db", dbPath],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Mode: DRY RUN/);
    assert.match(dryRun.stdout, /Recoverable lost links \(sample -> diary\): 1/);
    assert.equal(db.prepare("SELECT diary_id FROM samples WHERE id = ?").get("sample-1").diary_id, null);

    const apply = spawnSync(
      process.execPath,
      ["repair-sample-diary-links.mjs", "--db", dbPath, "--apply"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /Applied 1 link repair\(s\)/);
    assert.match(apply.stdout, /recoverable links remaining: 0/);
    assert.equal(
      db.prepare("SELECT diary_id FROM samples WHERE id = ?").get("sample-1").diary_id,
      "diary-1",
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const timestamp = "2026-06-17T18:58:28";
const oldAudio = "training-samples/bark/2026-06-17 18-58-28 SAMPLE bark.wav";
const newAudio = "training-samples/yap/2026-06-17 18-58-28 SAMPLE yap.wav";
const oldWave = "training-samples-waveforms/bark/old.json";
const newWave = "training-samples-waveforms/yap/new.json";
const assetDiary = (overrides = {}) => ({
  ...diary("diary", timestamp), audioPath: oldAudio, waveformPath: oldWave, ...overrides,
});
const assetSample = (overrides = {}) => ({
  ...sample("sample", timestamp, "diary"), audioPath: newAudio, waveformPath: newWave, ...overrides,
});

test("asset audit repairs stale paths and missing waveforms on healthy and recoverable links", () => {
  for (const diaryId of ["diary", null, "missing-diary"]) {
    for (const waveformPath of [oldWave, null]) {
      const audit = auditSampleDiaryLinks([assetDiary({ waveformPath })], [assetSample({ diaryId })]);
      assert.equal(audit.repairableAssets.length, 1);
      assert.deepEqual(audit.repairableAssets[0].changes, {
        audioPath: { previous: oldAudio, next: newAudio },
        waveformPath: { previous: waveformPath, next: newWave },
      });
    }
  }
  const waveformOnly = auditSampleDiaryLinks(
    [assetDiary({ audioPath: newAudio, waveformPath: null })], [assetSample()],
  );
  assert.deepEqual(Object.keys(waveformOnly.repairableAssets[0].changes), ["waveformPath"]);
});

test("asset audit preserves independent encodings and skips ambiguous or inactive samples", () => {
  const cases = [
    [[assetDiary({ audioPath: "audio/2026/06/recording.mp3", waveformPath: null })], [assetSample()]],
    [[assetDiary()], [assetSample(), assetSample({ id: "duplicate" })]],
    [[assetDiary(), assetDiary({ id: "duplicate" })], [assetSample()]],
    [[assetDiary()], [assetSample({ status: "deleted" })]],
    [[assetDiary()], [assetSample({ diaryId: null }), assetSample({ id: "stray", datetimeLocal: "2026-06-18T12:00:00" })]],
  ];
  for (const [diaries, samples] of cases) {
    assert.equal(auditSampleDiaryLinks(diaries, samples).repairableAssets.length, 0);
  }
  const occupied = auditSampleDiaryLinks([assetDiary()], [
    assetSample(), assetSample({ id: "stray", datetimeLocal: "2026-06-18T12:00:00" }),
  ]);
  assert.equal(occupied.repairableAssets.length, 0);
  assert.equal(occupied.blockedAssetRepairs.length, 1);
});

test("asset audit reports unavailable replacements without erasing references", () => {
  const audit = auditSampleDiaryLinks([assetDiary()], [assetSample({ waveformPath: null })]);
  assert.equal(audit.blockedAssetRepairs.length, 1);
  assert.equal(audit.blockedAssetRepairs[0].field, "waveformPath");
  assert.deepEqual(Object.keys(audit.repairableAssets[0].changes), ["audioPath"]);
});

test("CLI repairs stale and missing asset references atomically with links and is idempotent", async () => {
  const { openDb, upsertDiaryEntry, upsertSample } = await import("../lib/db.mjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-asset-repair-"));
  const dbPath = path.join(directory, "assets.db");
  const db = openDb(dbPath);
  const run = (...args) => spawnSync(process.execPath,
    ["repair-sample-diary-links.mjs", "--db", dbPath, ...args],
    { cwd: REPO_ROOT, encoding: "utf8" });
  try {
    for (const [id, audioPath, waveformPath] of [
      ["renamed", oldAudio, oldWave],
      ["missing-wave", newAudio, null],
      ["independent", "audio/2026/06/independent.mp3", "waveforms/2026/06/independent.json"],
    ]) {
      const dt = id === "renamed" ? timestamp : id === "missing-wave" ? "2026-06-28T08:16:29" : "2026-07-01T12:00:00";
      upsertDiaryEntry(db, {
        id, filename: `${id}.wav`, audioPath, waveformPath, label: "historical label",
        datetimeLocal: dt, date: dt.slice(0, 10), time: dt.slice(11, 16), durationSec: 30,
        trimStartMs: 1000, trimStopMs: 24000, kind: "audio",
      });
      upsertSample(db, {
        id: `sample-${id}`, diaryId: id === "renamed" ? null : id,
        filename: `${id} SAMPLE yap.wav`, audioPath: newAudio, waveformPath: newWave,
        label: "yap", datetimeLocal: dt, date: dt.slice(0, 10), durationSec: 30,
      });
    }
    db.prepare("UPDATE diary_entries SET approved = '2026-11-01T12:00:00Z'").run();
    const rows = () => db.prepare("SELECT * FROM diary_entries ORDER BY id").all();
    const before = rows();
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Safe diary asset reference repairs: 2/);
    assert.match(dry.stdout, /audioPath:.*bark.*->.*yap/);
    assert.match(dry.stdout, /waveformPath: null ->/);
    assert.deepEqual(rows(), before);
    assert.equal(db.prepare("SELECT diary_id FROM samples WHERE id = 'sample-renamed'").get().diary_id, null);

    db.exec(`CREATE TRIGGER fail_waveform_repair BEFORE UPDATE OF waveform_path ON diary_entries
      WHEN NEW.id = 'renamed' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    const failed = run("--apply");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /test failure/);
    assert.deepEqual(rows(), before);
    assert.equal(db.prepare("SELECT diary_id FROM samples WHERE id = 'sample-renamed'").get().diary_id, null);
    db.exec("DROP TRIGGER fail_waveform_repair");

    const applied = run("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Applied 1 link repair\(s\)/);
    assert.match(applied.stdout, /Applied 2 diary asset reference repair\(s\)/);
    assert.match(applied.stdout, /recoverable asset references remaining: 0/);
    for (const row of rows()) {
      const previous = before.find(old => old.id === row.id);
      if (row.id === "independent") assert.deepEqual(row, previous);
      else assert.deepEqual(row, { ...previous, audio_path: newAudio, waveform_path: newWave, updated_at: row.updated_at });
    }
    assert.equal(db.prepare("SELECT diary_id FROM samples WHERE id = 'sample-renamed'").get().diary_id, "renamed");
    const after = rows();
    const second = run("--apply");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Applied 0 diary asset reference repair\(s\)/);
    assert.deepEqual(rows(), after);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
