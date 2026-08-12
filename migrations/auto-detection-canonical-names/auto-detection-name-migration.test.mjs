import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { openDb, upsertDiaryEntry, upsertHitMetadata, upsertSample } from "../../lib/db.mjs";
import {
  buildDiaryMapping,
  buildIdentityMapping,
  buildMigratedDiaryIndex,
  canonicalizeManagedObjectKey,
  classifyUnplannedLegacyObjects,
  migrateDatabase,
  resolveSourceWavMapping,
  validateMigrationPlan,
} from "./auto-detection-name-migration.mjs";

const oldId = "2026-08-02_13-54-38_-A-_C1_D17_W98_La1_6_Lm0_9";
const newId = "2026-08-02_13-54-38_-A-";

function diary(overrides = {}) {
  return {
    id: oldId,
    filename: "2026-08-02 13-54-38 -A- C1 D17 W98 La1.6 Lm0.9.mp3",
    audioPath: "audio/2026/08/2026-08-02 13-54-38 -A- C1 D17 W98 La1.6 Lm0.9.mp3",
    waveformPath: `waveforms/2026/08/${oldId}.json`,
    label: "-A- C1 D17 W98 La1.6 Lm0.9",
    date: "2026-08-02",
    time: "13:54",
    datetimeLocal: "2026-08-02T13:54:38",
    durationSec: 351.2,
    kind: "audio",
    sourceWavPath: "uncompressed-uploads-archive/2026/08/2026-08-02 13-54-38 -A- C1 D17 W98 La1.6 Lm0.9.wav",
    sourceWavEtag: "source-etag",
    createdAt: "2026-08-02T11:55:00.000Z",
    ...overrides,
  };
}

test("maps every diary identity/path field to the stable -A- marker", () => {
  const mapping = buildDiaryMapping(diary(), { migrationToken: "test" });

  assert.equal(mapping.newId, newId);
  assert.equal(mapping.newFilename, "2026-08-02 13-54-38 -A-.mp3");
  assert.equal(mapping.newAudioPath, "audio/2026/08/2026-08-02 13-54-38 -A-.mp3");
  assert.equal(mapping.newWaveformPath, `waveforms/2026/08/${newId}.json`);
  assert.equal(mapping.newSourceWavPath, "uncompressed-uploads-archive/2026/08/2026-08-02 13-54-38 -A-.wav");
  assert.equal(mapping.newLabel, "-A-");
});

test("discovers an archived WAV for rows created before source_wav_path", () => {
  const mapping = buildDiaryMapping(diary({ sourceWavPath: null }));
  const resolved = resolveSourceWavMapping(mapping, new Set([mapping.oldSourceWavInferred]));

  assert.equal(resolved.oldSourceWavPath, mapping.oldSourceWavInferred);
  assert.equal(resolved.newSourceWavPath, mapping.newSourceWavInferred);
});

test("rejects two historical stats snapshots that collapse to one identity", () => {
  const first = buildDiaryMapping(diary(), { migrationToken: "test" });
  const second = buildDiaryMapping(diary({
    id: "2026-08-02_13-54-38_-A-_C0_99_D12_W70_La1_2_Lm0_8",
    filename: "2026-08-02 13-54-38 -A- C0.99 D12 W70 La1.2 Lm0.8.mp3",
    audioPath: "audio/2026/08/2026-08-02 13-54-38 -A- C0.99 D12 W70 La1.2 Lm0.8.mp3",
    waveformPath: "waveforms/2026/08/2026-08-02_13-54-38_-A-_C0_99_D12_W70_La1_2_Lm0_8.json",
    label: "-A- C0.99 D12 W70 La1.2 Lm0.8",
    sourceWavPath: "uncompressed-uploads-archive/2026/08/2026-08-02 13-54-38 -A- C0.99 D12 W70 La1.2 Lm0.8.wav",
  }), { migrationToken: "test" });

  assert.throws(() => validateMigrationPlan({
    diaryMappings: [first, second],
    identityMappings: [
      buildIdentityMapping(first.oldId, "test"),
      buildIdentityMapping(second.oldId, "test"),
    ],
  }), /target diary id collision/);
});

test("transaction retains samples and hit metadata under the new diary identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-auto-name-migration-"));
  const db = openDb(path.join(directory, "test.db"));
  try {
    const original = diary();
    upsertDiaryEntry(db, original);
    upsertSample(db, {
      id: "sample-1",
      filename: "2026-08-02 13-54-38 SAMPLE bark.wav",
      audioPath: "training-samples/bark/2026-08-02 13-54-38 SAMPLE bark.wav",
      waveformPath: null,
      label: "bark",
      date: original.date,
      datetimeLocal: original.datetimeLocal,
      durationSec: 2,
      diaryId: original.id,
    });
    upsertHitMetadata(db, original.id, {
      timestamps: [1, 2],
      confidences: [0.9, 1],
      loudnesses: [1.2, 1.6],
      paddingS: 1.5,
      windowS: 1.5,
    });

    const mapping = buildDiaryMapping(original, { migrationToken: "test" });
    const identity = buildIdentityMapping(original.id, "test");
    validateMigrationPlan({
      diaryMappings: [mapping],
      identityMappings: [identity],
      existingDiaryIds: [original.id],
      existingHitMetadataIds: [original.id],
      existingReferencedIds: [original.id],
    });

    migrateDatabase(db, [mapping], [identity], "2026-08-12T12:00:00.000Z");

    const migrated = db.prepare("SELECT * FROM diary_entries WHERE id = ?").get(newId);
    assert.equal(migrated.filename, mapping.newFilename);
    assert.equal(migrated.audio_path, mapping.newAudioPath);
    assert.equal(migrated.waveform_path, mapping.newWaveformPath);
    assert.equal(migrated.source_wav_path, mapping.newSourceWavPath);
    assert.equal(migrated.label, "-A-");
    assert.equal(db.prepare("SELECT diary_id FROM samples WHERE id = 'sample-1'").get().diary_id, newId);
    assert.equal(db.prepare("SELECT clip_id FROM hit_metadata").get().clip_id, newId);
    assert.deepEqual(db.pragma("foreign_key_check"), []);

    const index = buildMigratedDiaryIndex([original], [mapping]);
    assert.equal(index[0].id, newId);
    assert.equal(index[0].label, "-A-");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transaction migrates orphan sample and hit-metadata references", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-auto-name-orphans-"));
  const db = openDb(path.join(directory, "test.db"));
  try {
    upsertSample(db, {
      id: "orphan-sample",
      filename: "2026-08-02 13-54-38 SAMPLE bark.wav",
      audioPath: "training-samples/bark/2026-08-02 13-54-38 SAMPLE bark.wav",
      waveformPath: null,
      label: "bark",
      date: "2026-08-02",
      datetimeLocal: "2026-08-02T13:54:38",
      durationSec: 2,
      diaryId: oldId,
    });
    upsertHitMetadata(db, oldId, {
      timestamps: [1], confidences: [0.9], loudnesses: [1.2], paddingS: 1.5, windowS: 1.5,
    });
    const identity = buildIdentityMapping(oldId, "test");

    validateMigrationPlan({
      diaryMappings: [],
      identityMappings: [identity],
      existingHitMetadataIds: [oldId],
      existingReferencedIds: [oldId],
    });
    migrateDatabase(db, [], [identity]);

    assert.equal(db.prepare("SELECT diary_id FROM samples").get().diary_id, newId);
    assert.equal(db.prepare("SELECT clip_id FROM hit_metadata").get().clip_id, newId);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("canonicalizes managed audio, archive, and waveform object keys", () => {
  const cfg = {
    audioPrefix: "audio/",
    archivePrefix: "uncompressed-uploads-archive/",
    waveformPrefix: "waveforms/",
  };
  assert.equal(
    canonicalizeManagedObjectKey(diary().audioPath, cfg),
    "audio/2026/08/2026-08-02 13-54-38 -A-.mp3",
  );
  assert.equal(
    canonicalizeManagedObjectKey(diary().sourceWavPath, cfg),
    "uncompressed-uploads-archive/2026/08/2026-08-02 13-54-38 -A-.wav",
  );
  assert.equal(
    canonicalizeManagedObjectKey(diary().waveformPath, cfg),
    `waveforms/2026/08/${newId}.json`,
  );
  const freeform = "audio/2026/08/2026-08-02 13-54-38 note C1 D17 W98.mp3";
  assert.equal(canonicalizeManagedObjectKey(freeform, cfg), freeform);
});

test("plans standalone archive WAVs but blocks unrepresented derived objects", () => {
  const cfg = {
    audioPrefix: "audio/",
    archivePrefix: "uncompressed-uploads-archive/",
    waveformPrefix: "waveforms/",
  };
  const archive = {
    name: "uncompressed-uploads-archive/2026/08/2026-08-06 20-31-46 -A- C1 D5 W9 La16.9 Lm7.1.wav",
    size: 123,
  };
  const derivedAudio = {
    name: "audio/2026/08/2026-08-06 20-31-46 -A- C1 D5 W9 La16.9 Lm7.1.mp3",
    size: 45,
  };

  const classified = classifyUnplannedLegacyObjects(
    [archive, derivedAudio],
    new Set(),
    cfg,
  );

  assert.deepEqual(classified.standaloneArchiveMoves, [{
    kind: "source-wav-standalone",
    sourceKey: archive.name,
    targetKey: "uncompressed-uploads-archive/2026/08/2026-08-06 20-31-46 -A-.wav",
    source: archive,
  }]);
  assert.deepEqual(classified.blockingKeys, [derivedAudio.name]);
});
