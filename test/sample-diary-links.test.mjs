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
        kind TEXT NOT NULL
      );
      CREATE TABLE samples (
        id TEXT PRIMARY KEY,
        diary_id TEXT,
        datetime_local TEXT NOT NULL,
        status TEXT NOT NULL,
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
