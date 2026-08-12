#!/usr/bin/env node
/**
 * One-time migration: remove mutable C/D/W/La/Lm analysis snapshots from
 * auto-detection filenames, MinIO keys, diary IDs, and logical DB references.
 *
 * Default mode is a read-only dry run. `--apply` is required for mutation.
 * Both barktown-ingest and barktown-api must be stopped for apply.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import Database from "better-sqlite3";

import { loadEnv } from "../../lib/env.mjs";
loadEnv(new URL("../../package.json", import.meta.url).href);

import { buildConfig } from "../../lib/config.mjs";
import {
  createClient,
  copyObject,
  listObjects,
  objectExists,
  removeObject,
  uploadBuffer,
} from "../../lib/minio.mjs";
import {
  canonicalizeAutoDetectionFilename,
  canonicalizeAutoDetectionId,
  canonicalizeAutoDetectionLabel,
} from "../../lib/filenames.mjs";
import { createSqliteBackup } from "../../lib/sqlite-backup.mjs";
import { log, warn } from "../../lib/log.mjs";
import {
  buildDiaryMapping,
  buildIdentityMapping,
  buildMigratedDiaryIndex,
  canonicalizeManagedObjectKey,
  diaryMappingHasChanges,
  migrateDatabase,
  resolveSourceWavMapping,
  validateMigrationPlan,
} from "./auto-detection-name-migration.mjs";

const args = parseArgs(process.argv.slice(2));
const CFG = buildConfig();
const migrationToken = new Date().toISOString().replaceAll(/\D/g, "").slice(0, 14);
const MIGRATION_NAME = "auto-detection-canonical-names";

async function main() {
  const dbPath = path.resolve(CFG.dbPath);
  const backupRoot = args.backupRoot ?? path.join(path.dirname(dbPath), "backups");
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database does not exist: ${dbPath}`);
  assertNotPreviouslyCompleted(backupRoot);
  if (args.apply) assertServicesStopped();

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  try {
    const diaryRows = readDiaryRows(db);
    let diaryMappings = diaryRows
      .filter(isDiaryMigrationCandidate)
      .map(row => buildDiaryMapping(row, {
        migrationToken,
        audioPrefix: CFG.audioPrefix,
        archivePrefix: CFG.archivePrefix,
      }));

    const mc = createClient(CFG.minio);
    if (!(await mc.bucketExists(CFG.bucket))) {
      throw new Error(`MinIO bucket does not exist: ${CFG.bucket}`);
    }

    const managedObjects = await listManagedObjects(mc);
    const availableKeys = new Set(managedObjects.map(object => object.name));
    diaryMappings = diaryMappings
      .map(item => resolveSourceWavMapping(item, availableKeys))
      .filter(diaryMappingHasChanges);

    const hitMetadataIds = db.prepare("SELECT clip_id FROM hit_metadata ORDER BY clip_id").all().map(row => row.clip_id);
    const referencedIds = db.prepare("SELECT DISTINCT diary_id FROM samples WHERE diary_id IS NOT NULL ORDER BY diary_id").all().map(row => row.diary_id);
    const identitySourceIds = new Set([
      ...diaryMappings.filter(item => item.oldId !== item.newId).map(item => item.oldId),
      ...hitMetadataIds.filter(id => canonicalizeAutoDetectionId(id) !== id),
      ...referencedIds.filter(id => canonicalizeAutoDetectionId(id) !== id),
    ]);
    const identityMappings = [...identitySourceIds]
      .sort()
      .map(id => buildIdentityMapping(id, migrationToken));

    validateMigrationPlan({
      diaryMappings,
      identityMappings,
      existingDiaryIds: diaryRows.map(row => row.id),
      existingHitMetadataIds: hitMetadataIds,
      existingReferencedIds: referencedIds,
    });

    const preflight = preflightObjects(diaryMappings, managedObjects);
    const oldIndexBuffer = await getObjectBuffer(mc, CFG.bucket, CFG.indexKey);
    const oldIndex = JSON.parse(oldIndexBuffer.toString("utf8"));
    if (!Array.isArray(oldIndex)) throw new Error(`${CFG.indexKey} must contain a JSON array`);
    const newIndex = buildMigratedDiaryIndex(diaryRows, diaryMappings);

    const legacyIdentityIds = identityMappings.map(item => item.oldId);
    const sampleReferenceCount = countWhereIn(db, "samples", "diary_id", legacyIdentityIds);
    const hitMetadataCount = countWhereIn(db, "hit_metadata", "clip_id", legacyIdentityIds);

    printPlan({
      dbPath,
      diaryMappings,
      identityMappings,
      sampleReferenceCount,
      hitMetadataCount,
      oldIndexCount: oldIndex.length,
      newIndexCount: newIndex.length,
      preflight,
    });
    if (!args.apply) {
      log("DRY RUN complete. Nothing was changed.");
      log("Stop barktown-ingest and barktown-api, then rerun with --apply.");
      return;
    }

    const objectMoves = buildObjectMoves(preflight.moves, migrationToken);
    const backup = await createSqliteBackup({
      db,
      dbPath,
      backupRoot,
      backupName: `${MIGRATION_NAME}-${migrationToken}`,
      additionalFiles: {
        "migration-plan.json": JSON.stringify({ diaryMappings, identityMappings }, null, 2) + "\n",
        "minio-object-plan.json": JSON.stringify(objectMoves, null, 2) + "\n",
        "index.json": oldIndexBuffer,
      },
      manifestMetadata: { migration: MIGRATION_NAME },
    });
    log("SQLite binary backup, SQL/JSON exports, old index, and complete plans saved to:");
    log(`  ${backup.backupDir}`);

    let databaseCommitted = false;
    try {
      await stageObjects(mc, objectMoves);
      await publishObjects(mc, objectMoves);
      await uploadBuffer(mc, CFG.bucket, JSON.stringify(newIndex, null, 2) + "\n", CFG.indexKey);
      migrateDatabase(db, diaryMappings, identityMappings);
      databaseCommitted = true;
    } catch (error) {
      if (!databaseCommitted) {
        warn("Migration failed before DB commit; restoring the original index and removing published/staged copies...");
        await restorePreCommitState(mc, objectMoves, oldIndexBuffer);
      }
      throw error;
    }

    const cleanupErrors = await cleanupOldAndStagedObjects(mc, objectMoves);
    await verifyCompletedMigration({
      db,
      mc,
      diaryMappings,
      identityMappings,
      objectMoves,
      expectedIndex: newIndex,
      sampleReferenceCount,
      hitMetadataCount,
    });

    const result = {
      status: cleanupErrors.length === 0 ? "completed" : "cleanup-required",
      completedAt: new Date().toISOString(),
      diaryRowsMigrated: diaryMappings.length,
      identityMappings: identityMappings.length,
      sampleReferencesMigrated: sampleReferenceCount,
      hitMetadataRowsMigrated: hitMetadataCount,
      minioObjectsRenamed: objectMoves.length,
      cleanupErrors,
      backupDir: backup.backupDir,
    };
    fs.writeFileSync(
      path.join(backup.backupDir, "migration-result.json"),
      JSON.stringify(result, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );

    log(`Migration complete: ${diaryMappings.length} diary rows, ${objectMoves.length} MinIO objects.`);
    log(`References retained: ${sampleReferenceCount} samples, ${hitMetadataCount} hit_metadata rows.`);
    if (cleanupErrors.length > 0) {
      throw new Error(`migration committed but ${cleanupErrors.length} cleanup operation(s) failed; see migration-result.json`);
    }
  } finally {
    db.close();
  }
}

function readDiaryRows(db) {
  return db.prepare(`
    SELECT id, filename, audio_path AS audioPath, waveform_path AS waveformPath,
           label, date, time, datetime_local AS datetimeLocal,
           duration_sec AS durationSec, kind,
           source_wav_path AS sourceWavPath, source_wav_etag AS sourceWavEtag,
           created_at AS createdAt, updated_at AS updatedAt
    FROM diary_entries
    ORDER BY datetime_local ASC
  `).all();
}

function isDiaryMigrationCandidate(row) {
  return canonicalizeAutoDetectionFilename(row.filename) !== row.filename
    || canonicalizeAutoDetectionId(row.id) !== row.id
    || canonicalizeAutoDetectionLabel(row.label) !== row.label
    || canonicalizeManagedObjectKey(row.audioPath, CFG) !== row.audioPath
    || (row.waveformPath && canonicalizeManagedObjectKey(row.waveformPath, CFG) !== row.waveformPath)
    || (row.sourceWavPath && canonicalizeManagedObjectKey(row.sourceWavPath, CFG) !== row.sourceWavPath);
}

async function listManagedObjects(mc) {
  const prefixes = [CFG.archivePrefix, CFG.audioPrefix, CFG.waveformPrefix];
  const lists = await Promise.all(prefixes.map(prefix => listObjects(mc, CFG.bucket, prefix)));
  return lists.flat().filter(object =>
    !object.name.endsWith("/") && path.posix.basename(object.name) !== ".keep"
  );
}

function preflightObjects(diaryMappings, managedObjects) {
  const objectsByName = new Map(managedObjects.map(object => [object.name, object]));
  const pairs = [];
  for (const item of diaryMappings) {
    for (const [kind, sourceKey, targetKey, requiredPrefix] of [
      ["audio", item.oldAudioPath, item.newAudioPath, CFG.audioPrefix],
      ["waveform", item.oldWaveformPath, item.newWaveformPath, CFG.waveformPrefix],
      ["source-wav", item.oldSourceWavPath, item.newSourceWavPath, CFG.archivePrefix],
    ]) {
      if (!sourceKey) continue;
      if (!sourceKey.startsWith(requiredPrefix) || !targetKey.startsWith(requiredPrefix)) {
        throw new Error(`${kind} path escaped ${requiredPrefix}: ${sourceKey} -> ${targetKey}`);
      }
      if (!objectsByName.has(sourceKey)) throw new Error(`MinIO object missing for DB row: ${sourceKey}`);
      if (sourceKey !== targetKey) pairs.push({ kind, sourceKey, targetKey, source: objectsByName.get(sourceKey) });
    }
  }

  const expectedLegacyKeys = new Set(pairs.map(pair => pair.sourceKey));
  const unexpectedLegacy = managedObjects
    .map(object => object.name)
    .filter(key => canonicalizeManagedObjectKey(key, CFG) !== key && !expectedLegacyKeys.has(key));
  if (unexpectedLegacy.length > 0) {
    throw new Error(`legacy stats-named MinIO objects are not represented by the migration plan:\n${unexpectedLegacy.join("\n")}`);
  }

  const sourceKeys = new Set(pairs.map(pair => pair.sourceKey));
  for (const pair of pairs) {
    if (objectsByName.has(pair.targetKey) && !sourceKeys.has(pair.targetKey)) {
      throw new Error(`target object already exists and is not a migration source: ${pair.targetKey}`);
    }
  }

  const counts = Object.fromEntries([CFG.archivePrefix, CFG.audioPrefix, CFG.waveformPrefix].map(prefix => [
    prefix,
    pairs.filter(pair => pair.sourceKey.startsWith(prefix)).length,
  ]));
  return { moves: pairs, counts };
}

function printPlan({
  dbPath,
  diaryMappings,
  identityMappings,
  sampleReferenceCount,
  hitMetadataCount,
  oldIndexCount,
  newIndexCount,
  preflight,
}) {
  log(`Auto-detection canonical-name migration ${args.apply ? "APPLY" : "DRY RUN"}`);
  log(`  database       : ${dbPath}`);
  log(`  bucket         : ${CFG.bucket}`);
  log(`  diary rows     : ${diaryMappings.length}`);
  log(`  identity maps  : ${identityMappings.length}`);
  log(`  sample refs    : ${sampleReferenceCount}`);
  log(`  hit metadata   : ${hitMetadataCount}`);
  log(`  index rows     : ${oldIndexCount} -> ${newIndexCount}`);
  log(`  archive WAVs   : ${preflight.counts[CFG.archivePrefix]}`);
  log(`  audio objects  : ${preflight.counts[CFG.audioPrefix]}`);
  log(`  waveforms      : ${preflight.counts[CFG.waveformPrefix]}`);
  const examples = diaryMappings.length <= 2 ? diaryMappings : [diaryMappings[0], diaryMappings.at(-1)];
  for (const item of examples) log(`  ${item.oldFilename}  ->  ${item.newFilename}`);
}

function buildObjectMoves(pairs, token) {
  return pairs.map((pair, index) => ({
    kind: pair.kind,
    sourceKey: pair.sourceKey,
    targetKey: pair.targetKey,
    size: pair.source.size,
    etag: pair.source.etag ?? null,
    stageKey: `migration-staging/${MIGRATION_NAME}/${token}/${pair.kind}/${String(index).padStart(6, "0")}-${path.posix.basename(pair.sourceKey)}`,
  }));
}

async function stageObjects(mc, moves) {
  log(`Staging ${moves.length} MinIO objects...`);
  for (const [index, move] of moves.entries()) {
    if (await objectExists(mc, CFG.bucket, move.stageKey)) throw new Error(`staging key exists: ${move.stageKey}`);
    await copyObject(mc, CFG.bucket, move.sourceKey, move.stageKey);
    await assertObjectSize(mc, move.stageKey, move.size);
    progress(index + 1, moves.length);
  }
}

async function publishObjects(mc, moves) {
  log("Publishing canonical MinIO object names...");
  for (const [index, move] of moves.entries()) {
    await copyObject(mc, CFG.bucket, move.stageKey, move.targetKey);
    await assertObjectSize(mc, move.targetKey, move.size);
    progress(index + 1, moves.length);
  }
}

async function restorePreCommitState(mc, moves, oldIndexBuffer) {
  const sourceKeys = new Set(moves.map(move => move.sourceKey));
  for (const move of moves) {
    if (!sourceKeys.has(move.targetKey) && await objectExists(mc, CFG.bucket, move.targetKey)) {
      await removeObject(mc, CFG.bucket, move.targetKey);
    }
  }
  for (const move of moves) {
    if (await objectExists(mc, CFG.bucket, move.stageKey)) await removeObject(mc, CFG.bucket, move.stageKey);
  }
  await uploadBuffer(mc, CFG.bucket, oldIndexBuffer, CFG.indexKey);
}

async function cleanupOldAndStagedObjects(mc, moves) {
  const errors = [];
  const finalKeys = new Set(moves.map(move => move.targetKey));
  const staleSources = [...new Set(moves.map(move => move.sourceKey))]
    .filter(key => !finalKeys.has(key));
  for (const key of staleSources) {
    try {
      await removeObject(mc, CFG.bucket, key);
    } catch (error) {
      errors.push({ operation: "remove-old", key, error: error.message });
    }
  }
  for (const move of moves) {
    try {
      await removeObject(mc, CFG.bucket, move.stageKey);
    } catch (error) {
      errors.push({ operation: "remove-stage", key: move.stageKey, error: error.message });
    }
  }
  return errors;
}

async function verifyCompletedMigration({
  db,
  mc,
  diaryMappings,
  identityMappings,
  objectMoves,
  expectedIndex,
  sampleReferenceCount,
  hitMetadataCount,
}) {
  for (const item of diaryMappings) {
    const row = db.prepare(`
      SELECT filename, audio_path AS audioPath, waveform_path AS waveformPath,
             label, source_wav_path AS sourceWavPath
      FROM diary_entries WHERE id = ?
    `).get(item.newId);
    if (!row || row.filename !== item.newFilename || row.audioPath !== item.newAudioPath
      || row.waveformPath !== item.newWaveformPath || row.label !== item.newLabel
      || row.sourceWavPath !== item.newSourceWavPath) {
      throw new Error(`post-migration diary verification failed: ${item.newId}`);
    }
  }

  const oldIds = identityMappings.map(item => item.oldId);
  const newIds = identityMappings.map(item => item.newId);
  const remainingOldSampleRefs = countWhereIn(db, "samples", "diary_id", oldIds);
  const remainingOldHits = countWhereIn(db, "hit_metadata", "clip_id", oldIds);
  if (remainingOldSampleRefs !== 0 || remainingOldHits !== 0) {
    throw new Error("legacy logical references remain after DB migration");
  }
  if (countWhereIn(db, "samples", "diary_id", newIds) < sampleReferenceCount) {
    throw new Error("sample diary references were lost during migration");
  }
  if (countWhereIn(db, "hit_metadata", "clip_id", newIds) < hitMetadataCount) {
    throw new Error("hit_metadata rows were lost during migration");
  }

  const integrity = db.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeys = db.pragma("foreign_key_check");
  if (foreignKeys.length > 0) throw new Error(`foreign-key verification failed: ${JSON.stringify(foreignKeys)}`);

  for (const move of objectMoves) await assertObjectSize(mc, move.targetKey, move.size);
  const storedIndex = JSON.parse((await getObjectBuffer(mc, CFG.bucket, CFG.indexKey)).toString("utf8"));
  if (JSON.stringify(storedIndex) !== JSON.stringify(expectedIndex)) {
    throw new Error(`${CFG.indexKey} does not match the migrated diary state`);
  }
}

function countWhereIn(db, table, column, values) {
  if (values.length === 0) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${placeholders(values.length)})`)
    .get(...values).n;
}

function placeholders(count) {
  return Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
}

async function assertObjectSize(mc, key, expectedSize) {
  const stat = await mc.statObject(CFG.bucket, key);
  if (stat.size !== expectedSize) {
    throw new Error(`object size mismatch for ${key}: expected ${expectedSize}, got ${stat.size}`);
  }
}

async function getObjectBuffer(mc, bucket, key) {
  const stream = await mc.getObject(bucket, key);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) throw new Error(`cannot back up empty object: ${key}`);
  return buffer;
}

function assertServicesStopped() {
  for (const service of ["barktown-ingest", "barktown-api"]) {
    const result = spawnSync("systemctl", ["is-active", "--quiet", service]);
    if (result.status === 0) {
      throw new Error(`${service}.service is active; stop both Barktown services before --apply`);
    }
  }
}

function assertNotPreviouslyCompleted(backupRoot) {
  if (!fs.existsSync(backupRoot)) return;
  const completed = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${MIGRATION_NAME}-`))
    .map(entry => path.join(backupRoot, entry.name, "migration-result.json"))
    .find(resultPath => {
      if (!fs.existsSync(resultPath)) return false;
      return JSON.parse(fs.readFileSync(resultPath, "utf8")).status === "completed";
    });
  if (completed) throw new Error(`this one-time migration already completed (${completed})`);
}

function progress(done, total) {
  if (done === total || done % 25 === 0) log(`  ${done}/${total}`);
}

function parseArgs(argv) {
  const parsed = { apply: false, backupRoot: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--backup-root") {
      parsed.backupRoot = argv[++index];
      if (!parsed.backupRoot) throw new Error("--backup-root requires a path");
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node migrations/auto-detection-canonical-names/migrate-auto-detection-canonical-names.mjs [--apply] [--backup-root DIR]\n\nWithout --apply, performs a read-only preflight/dry run.");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
