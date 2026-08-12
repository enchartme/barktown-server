// Pure mapping, validation, and transactional DB helpers for the one-off
// migration that removes C/D/W/La/Lm snapshots from auto-detection identities.

import path from "path";

import {
  canonicalizeAutoDetectionFilename,
  canonicalizeAutoDetectionId,
  canonicalizeAutoDetectionLabel,
  parseFilename,
} from "../../lib/filenames.mjs";

/** Build the old -> canonical mapping for one auto-detected diary row. */
export function buildDiaryMapping(row, {
  migrationToken = "migration",
  audioPrefix = "audio/",
  archivePrefix = "uncompressed-uploads-archive/",
} = {}) {
  const parsed = parseFilename(row.filename);
  if (!parsed) throw new Error(`diary filename does not match the canonical pattern: ${row.filename}`);

  const newFilename = canonicalizeAutoDetectionFilename(row.filename);
  const parsedNew = parseFilename(newFilename);
  if (!parsedNew) throw new Error(`failed to construct canonical filename for ${row.id}`);

  const newId = parsedNew.id;
  if (canonicalizeAutoDetectionId(row.id) !== newId) {
    throw new Error(`diary id/filename identity drift cannot be canonicalized safely: DB=${row.id} filename=${row.filename}`);
  }
  if (parsedNew.date !== row.date || parsedNew.time !== row.time || parsedNew.datetimeLocal !== row.datetimeLocal) {
    throw new Error(`diary timestamp fields disagree for ${row.id}`);
  }

  const newLabel = canonicalizeAutoDetectionLabel(row.label);
  if (newLabel !== "-A-") {
    throw new Error(`auto-detection row has a non-canonicalizable label: ${row.id} label=${row.label}`);
  }
  if (parsedNew.label !== "-A-") {
    throw new Error(`auto-detection filename has a non-canonicalizable label: ${row.filename}`);
  }

  if (path.posix.basename(row.audioPath) !== row.filename) {
    throw new Error(`diary filename/audio_path mismatch for ${row.id}`);
  }
  const newAudioPath = replaceBasename(row.audioPath, newFilename);

  let newWaveformPath = null;
  if (row.waveformPath) {
    if (path.posix.basename(row.waveformPath) !== `${row.id}.json`) {
      throw new Error(`diary id/waveform_path mismatch for ${row.id}`);
    }
    newWaveformPath = replaceBasename(row.waveformPath, `${newId}.json`);
  }

  let newSourceWavPath = null;
  if (row.sourceWavPath) {
    const sourceName = path.posix.basename(row.sourceWavPath);
    const newSourceName = canonicalizeAutoDetectionFilename(sourceName);
    if (!parseFilename(sourceName) || !parseFilename(newSourceName)) {
      throw new Error(`source_wav_path is not a diary WAV filename for ${row.id}: ${row.sourceWavPath}`);
    }
    newSourceWavPath = replaceBasename(row.sourceWavPath, newSourceName);
  }

  if (!row.audioPath.startsWith(audioPrefix)) {
    throw new Error(`diary audio path is outside ${audioPrefix}: ${row.audioPath}`);
  }
  const oldSourceWavInferred = `${archivePrefix}${row.audioPath.slice(audioPrefix.length)}`
    .replace(/\.[^./]+$/, ".wav");
  const newSourceWavInferred = `${archivePrefix}${newAudioPath.slice(audioPrefix.length)}`
    .replace(/\.[^./]+$/, ".wav");

  return {
    oldId: row.id,
    temporaryId: `__auto_name__${migrationToken}__${row.id}`,
    oldFilename: row.filename,
    newId,
    newFilename,
    oldAudioPath: row.audioPath,
    newAudioPath,
    oldWaveformPath: row.waveformPath,
    newWaveformPath,
    oldSourceWavPath: row.sourceWavPath,
    newSourceWavPath,
    oldSourceWavInferred,
    newSourceWavInferred,
    oldLabel: row.label,
    newLabel,
    date: row.date,
    time: row.time,
    datetimeLocal: row.datetimeLocal,
    durationSec: row.durationSec,
    kind: row.kind,
    sourceWavEtag: row.sourceWavEtag,
    createdAt: row.createdAt,
  };
}

/** True when at least one persisted diary field needs to change. */
export function diaryMappingHasChanges(item) {
  return item.oldId !== item.newId
    || item.oldFilename !== item.newFilename
    || item.oldAudioPath !== item.newAudioPath
    || item.oldWaveformPath !== item.newWaveformPath
    || item.oldSourceWavPath !== item.newSourceWavPath
    || item.oldLabel !== item.newLabel;
}

/**
 * Resolve a nullable legacy source_wav_path against the object listing.
 * This also fills the column when the archived WAV existed before that column.
 */
export function resolveSourceWavMapping(item, availableKeys) {
  if (item.oldSourceWavPath) return { ...item };
  const oldExists = availableKeys.has(item.oldSourceWavInferred);
  const newExists = availableKeys.has(item.newSourceWavInferred);
  if (oldExists && newExists && item.oldSourceWavInferred !== item.newSourceWavInferred) {
    throw new Error(`both legacy and canonical inferred source WAVs exist for ${item.oldId}`);
  }
  if (oldExists) {
    return {
      ...item,
      oldSourceWavPath: item.oldSourceWavInferred,
      newSourceWavPath: item.newSourceWavInferred,
    };
  }
  if (newExists) {
    return {
      ...item,
      oldSourceWavPath: item.newSourceWavInferred,
      newSourceWavPath: item.newSourceWavInferred,
    };
  }
  return { ...item };
}

/** Build an identity-only mapping for orphan hit_metadata/sample references. */
export function buildIdentityMapping(oldId, migrationToken = "migration") {
  const newId = canonicalizeAutoDetectionId(oldId);
  if (newId === oldId) return null;
  return {
    oldId,
    newId,
    temporaryId: `__auto_name__${migrationToken}__${oldId}`,
  };
}

/** Reject all DB identity and object-path collisions before any mutation. */
export function validateMigrationPlan({
  diaryMappings,
  identityMappings,
  existingDiaryIds = [],
  existingHitMetadataIds = [],
  existingReferencedIds = [],
}) {
  if (diaryMappings.length === 0 && identityMappings.length === 0) {
    throw new Error("no legacy auto-detection names or IDs were found");
  }

  assertUnique(diaryMappings.map(item => item.oldId), "source diary id");
  assertUnique(diaryMappings.map(item => item.newId), "target diary id");
  assertUnique(identityMappings.map(item => item.oldId), "source identity");
  assertUnique(identityMappings.map(item => item.newId), "target identity");
  assertUnique(identityMappings.map(item => item.temporaryId), "temporary identity");

  const identityByOld = new Map(identityMappings.map(item => [item.oldId, item]));
  for (const item of diaryMappings) {
    if (item.oldId !== item.newId && identityByOld.get(item.oldId)?.newId !== item.newId) {
      throw new Error(`missing identity mapping for diary row: ${item.oldId}`);
    }
  }

  const diaryIdSet = new Set(existingDiaryIds);
  for (const item of diaryMappings) {
    if (item.newId !== item.oldId && diaryIdSet.has(item.newId)) {
      throw new Error(`target diary id already exists: ${item.newId}`);
    }
  }

  const hitIdSet = new Set(existingHitMetadataIds);
  for (const item of identityMappings) {
    if (hitIdSet.has(item.oldId) && item.newId !== item.oldId && hitIdSet.has(item.newId)) {
      throw new Error(`target hit_metadata clip_id already exists: ${item.newId}`);
    }
  }

  const allExistingIds = new Set([
    ...existingDiaryIds,
    ...existingHitMetadataIds,
    ...existingReferencedIds.filter(Boolean),
  ]);
  for (const item of identityMappings) {
    if (allExistingIds.has(item.temporaryId)) {
      throw new Error(`temporary identity already exists: ${item.temporaryId}`);
    }
  }

  for (const [oldField, newField, description] of [
    ["oldAudioPath", "newAudioPath", "audio key"],
    ["oldWaveformPath", "newWaveformPath", "waveform key"],
    ["oldSourceWavPath", "newSourceWavPath", "source WAV key"],
  ]) {
    const withPath = diaryMappings.filter(item => item[oldField]);
    assertUnique(withPath.map(item => item[oldField]), `source ${description}`);
    assertUnique(withPath.map(item => item[newField]), `target ${description}`);
  }
}

/**
 * Migrate diary primary keys/fields plus samples.diary_id and
 * hit_metadata.clip_id in one SQLite transaction.
 */
export function migrateDatabase(db, diaryMappings, identityMappings, updatedAt = new Date().toISOString()) {
  const moveDiaryId = db.prepare("UPDATE diary_entries SET id = ? WHERE id = ?");
  const moveSampleRefs = db.prepare("UPDATE samples SET diary_id = ?, updated_at = ? WHERE diary_id = ?");
  const moveHitId = db.prepare("UPDATE hit_metadata SET clip_id = ? WHERE clip_id = ?");
  const updateDiary = db.prepare(`
    UPDATE diary_entries SET
      id = ?, filename = ?, audio_path = ?, waveform_path = ?, label = ?,
      source_wav_path = ?, updated_at = ?
    WHERE id = ?
  `);

  const identityByOld = new Map(identityMappings.map(item => [item.oldId, item]));
  const transaction = db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");

    for (const item of identityMappings) {
      moveSampleRefs.run(item.temporaryId, updatedAt, item.oldId);
      moveHitId.run(item.temporaryId, item.oldId);
    }

    for (const item of diaryMappings) {
      if (item.oldId === item.newId) continue;
      const changed = moveDiaryId.run(identityByOld.get(item.oldId).temporaryId, item.oldId);
      if (changed.changes !== 1) throw new Error(`diary row disappeared during migration: ${item.oldId}`);
    }

    for (const item of diaryMappings) {
      const currentId = item.oldId === item.newId
        ? item.oldId
        : identityByOld.get(item.oldId).temporaryId;
      const changed = updateDiary.run(
        item.newId,
        item.newFilename,
        item.newAudioPath,
        item.newWaveformPath,
        item.newLabel,
        item.newSourceWavPath,
        updatedAt,
        currentId,
      );
      if (changed.changes !== 1) throw new Error(`temporary diary row missing: ${currentId}`);
    }

    for (const item of identityMappings) {
      moveSampleRefs.run(item.newId, updatedAt, item.temporaryId);
      moveHitId.run(item.newId, item.temporaryId);
    }

    const foreignKeyErrors = db.pragma("foreign_key_check");
    if (foreignKeyErrors.length > 0) {
      throw new Error(`foreign-key check failed: ${JSON.stringify(foreignKeyErrors)}`);
    }
  });

  transaction();
}

/** Build index.json from the planned post-migration diary state. */
export function buildMigratedDiaryIndex(rows, diaryMappings) {
  const mappings = new Map(diaryMappings.map(item => [item.oldId, item]));
  return rows.map(row => {
    const item = mappings.get(row.id);
    return {
      id: item?.newId ?? row.id,
      filename: item?.newFilename ?? row.filename,
      audioPath: item?.newAudioPath ?? row.audioPath,
      waveformPath: item?.newWaveformPath ?? row.waveformPath,
      label: item?.newLabel ?? row.label,
      date: row.date,
      time: row.time,
      datetimeLocal: row.datetimeLocal,
      durationSec: row.durationSec,
      kind: row.kind,
      sourceWavPath: item?.newSourceWavPath ?? row.sourceWavPath,
      sourceWavEtag: row.sourceWavEtag,
    };
  }).sort((a, b) => a.datetimeLocal.localeCompare(b.datetimeLocal));
}

/** Canonicalize one managed object key, or return it unchanged. */
export function canonicalizeManagedObjectKey(key, cfg) {
  if (key.startsWith(cfg.audioPrefix) || key.startsWith(cfg.archivePrefix)) {
    return replaceBasename(key, canonicalizeAutoDetectionFilename(path.posix.basename(key)));
  }
  if (key.startsWith(cfg.waveformPrefix) && key.toLowerCase().endsWith(".json")) {
    const basename = path.posix.basename(key);
    const id = basename.slice(0, -".json".length);
    return replaceBasename(key, `${canonicalizeAutoDetectionId(id)}.json`);
  }
  return key;
}

function replaceBasename(value, basename) {
  return path.posix.join(path.posix.dirname(value), basename);
}

function assertUnique(values, description) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${description} collision: ${value}`);
    seen.add(value);
  }
}
