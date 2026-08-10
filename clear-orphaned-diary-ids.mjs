#!/usr/bin/env node
// clear-orphaned-diary-ids.mjs
//
// One-off script: find samples whose diary_id points at a diary_entries row
// that no longer exists, and clear that stale link.
//
// Usage (dry-run):   node clear-orphaned-diary-ids.mjs
// Usage (apply):     node clear-orphaned-diary-ids.mjs --apply

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import Database from "better-sqlite3";
import { buildConfig } from "./lib/config.mjs";

const apply = process.argv.includes("--apply");
const cfg   = buildConfig();
const db    = new Database(cfg.dbPath);

const orphans = db
  .prepare(`
    SELECT s.id, s.diary_id
    FROM   samples s
    WHERE  s.diary_id IS NOT NULL
    AND    s.diary_id != ''
    AND    NOT EXISTS (SELECT 1 FROM diary_entries d WHERE d.id = s.diary_id)
  `)
  .all();

console.log(`Found ${orphans.length} sample(s) with an orphaned diary_id.`);
if (!apply) console.log("Dry-run mode — pass --apply to commit changes.\n");

for (const s of orphans) {
  console.log(`  sample ${s.id} -> diary_id ${s.diary_id} (missing)`);
}

if (apply && orphans.length) {
  const clear = db.prepare(`
    UPDATE samples SET diary_id = NULL, updated_at = @now
    WHERE id = @id
  `);
  const run = db.transaction(() => {
    const now = new Date().toISOString();
    for (const s of orphans) clear.run({ id: s.id, now });
  });
  run();
  console.log(`\nCleared ${orphans.length} orphaned diary_id link(s).`);
}

db.close();
