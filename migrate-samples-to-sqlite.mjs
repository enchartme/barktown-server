#!/usr/bin/env node
/**
 * barktown-server — one-off migration: import the existing
 * training-samples-index.json (in MinIO) into the local SQLite database.
 *
 * Safe to re-run: upsert-based, existing rows are just refreshed.
 *
 * Usage:
 *   node migrate-samples-to-sqlite.mjs
 *   npm run migrate-samples-to-sqlite
 */

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import { buildConfig } from "./lib/config.mjs";
import { createClient, loadJson } from "./lib/minio.mjs";
import { openDb, upsertSample, listActiveSamples } from "./lib/db.mjs";
import { log } from "./lib/log.mjs";

async function main() {
  const CFG = buildConfig();
  const mc = createClient(CFG.minio);
  const db = openDb(CFG.dbPath);

  log(`Loading ${CFG.samplesIndexKey} from bucket "${CFG.bucket}"...`);
  const entries = await loadJson(mc, CFG.bucket, CFG.samplesIndexKey, []);
  log(`Found ${entries.length} entries in the legacy index.`);

  let migrated = 0;
  for (const entry of entries) {
    upsertSample(db, entry);
    migrated++;
  }

  const total = listActiveSamples(db).length;
  log(`Migrated ${migrated} entries. Database now has ${total} active sample(s).`);
  log(`Database file: ${CFG.dbPath}`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
