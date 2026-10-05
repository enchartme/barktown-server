#!/usr/bin/env node
/**
 * Reconcile active training samples and diary records by their deterministic,
 * second-precision local timestamp. The only stored relationship is
 * samples.diary_id; the diary -> sample direction is derived from that field.
 *
 * Dry run (default): npm run repair-sample-diary-links
 * Apply:             npm run repair-sample-diary-links -- --apply
 */

import path from "path";
import Database from "better-sqlite3";

import { loadEnv } from "./lib/env.mjs";
import { buildConfig } from "./lib/config.mjs";
import { auditSampleDiaryLinks } from "./lib/sample-diary-links.mjs";

loadEnv(import.meta.url);

function usage() {
  return [
    "Usage: node repair-sample-diary-links.mjs [--apply] [--db PATH]",
    "",
    "Audit diary/sample links in both directions by exact local timestamp.",
    "Without --apply, the database is opened read-only and no rows are changed.",
    "",
    "Options:",
    "  --apply     Write safe, unambiguous repairs to samples.diary_id",
    "  --db PATH   Override DB_PATH for this run",
    "  --help      Show this help",
  ].join("\n");
}

function parseArgs(args) {
  const options = { apply: false, dbPath: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--db") {
      const value = args[++i];
      if (!value) throw new Error("--db requires a path");
      options.dbPath = value;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function readRows(db) {
  return {
    diaries: db.prepare(`
      SELECT id, datetime_local AS datetimeLocal, kind
      FROM diary_entries
      WHERE kind = 'audio'
      ORDER BY datetime_local ASC, id ASC
    `).all(),
    samples: db.prepare(`
      SELECT id, diary_id AS diaryId, datetime_local AS datetimeLocal, status
      FROM samples
      ORDER BY datetime_local ASC, id ASC
    `).all(),
  };
}

function printSection(title, rows, format) {
  console.log(`\n${title}: ${rows.length}`);
  for (const row of rows) console.log(`  ${format(row)}`);
}

function printAudit(audit) {
  const { counts } = audit;
  console.log(`Diary rows: ${counts.diaries}`);
  console.log(`Active samples: ${counts.activeSamples}`);
  console.log(`Healthy links: ${counts.healthyLinks}`);
  console.log(`Recoverable lost links (sample -> diary): ${counts.repairableLinks}`);
  console.log(`Recoverable lost links (diary -> sample): ${counts.repairableLinks}`);

  printSection("Safe same-timestamp repairs", audit.repairableLinks, (row) => (
    `${row.timestamp}  sample ${row.sampleId}: ${row.previousDiaryId ?? "(none)"} -> diary ${row.diaryId} [${row.reason}]`
  ));
  printSection("Samples with no diary target at the same timestamp", audit.sampleMissingTargets, (row) => (
    `${row.timestamp}  sample ${row.sampleId} (current diary: ${row.currentDiaryId ?? "none"})`
  ));
  printSection("Diary rows with no active sample target at the same timestamp", audit.diaryMissingTargets, (row) => (
    `${row.timestamp}  diary ${row.diaryId}${row.currentSampleIds.length ? ` (currently referenced by ${row.currentSampleIds.join(", ")})` : ""}`
  ));
  printSection("Ambiguous timestamps (never repaired)", audit.ambiguousTimestamps, (row) => (
    `${row.timestamp}  diaries=[${row.diaryIds.join(", ")}] samples=[${row.sampleIds.join(", ")}]`
  ));
  printSection("Blocked repairs", audit.blockedRepairs, (row) => (
    `${row.timestamp}  sample ${row.sampleId} -> diary ${row.diaryId}; occupied by [${row.blockingSampleIds.join(", ")}]`
  ));
  printSection("Orphaned current sample links", audit.orphanedCurrentLinks, (row) => (
    `${row.timestamp ?? "invalid time"}  sample ${row.sampleId} -> missing diary ${row.diaryId}`
  ));
  printSection("Timestamp-mismatched current links", audit.mismatchedCurrentLinks, (row) => (
    `sample ${row.sampleId} (${row.sampleTimestamp ?? "invalid"}) -> diary ${row.diaryId} (${row.diaryTimestamp ?? "invalid"})`
  ));
  printSection("Duplicate current diary targets", audit.duplicateCurrentTargets, (row) => (
    `diary ${row.diaryId} <- samples [${row.sampleIds.join(", ")}]`
  ));
  printSection("Invalid timestamps", audit.invalidTimestamps, (row) => (
    `${row.side} ${row.id}: ${JSON.stringify(row.value)}`
  ));
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(`\n${usage()}`);
  process.exitCode = 1;
}

if (options?.help) {
  console.log(usage());
} else if (options) {
  const cfg = buildConfig();
  const dbPath = path.resolve(options.dbPath ?? cfg.dbPath);
  const db = new Database(dbPath, {
    readonly: !options.apply,
    fileMustExist: true,
  });
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  try {
    console.log(`Sample/diary link audit: ${dbPath}`);
    console.log(options.apply ? "Mode: APPLY" : "Mode: DRY RUN (pass --apply to write repairs)");
    const initialRows = readRows(db);
    const initialAudit = auditSampleDiaryLinks(initialRows.diaries, initialRows.samples);
    printAudit(initialAudit);

    if (options.apply) {
      const update = db.prepare(`
        UPDATE samples
        SET diary_id = @diaryId, updated_at = @now
        WHERE id = @sampleId
          AND status = 'active'
          AND COALESCE(diary_id, '') = @previousDiaryId
      `);

      const applyRepairs = db.transaction(() => {
        const currentRows = readRows(db);
        const currentAudit = auditSampleDiaryLinks(currentRows.diaries, currentRows.samples);
        const now = new Date().toISOString();
        for (const repair of currentAudit.repairableLinks) {
          const result = update.run({
            sampleId: repair.sampleId,
            diaryId: repair.diaryId,
            previousDiaryId: repair.previousDiaryId ?? "",
            now,
          });
          if (result.changes !== 1) {
            throw new Error(`sample changed during repair: ${repair.sampleId}`);
          }
        }
        return currentAudit.repairableLinks;
      });

      const applied = applyRepairs.immediate();
      console.log(`\nApplied ${applied.length} link repair(s).`);
      for (const repair of applied) {
        console.log(`  ${repair.sampleId} -> ${repair.diaryId}`);
      }

      const finalRows = readRows(db);
      const finalAudit = auditSampleDiaryLinks(finalRows.diaries, finalRows.samples);
      console.log("\nPost-apply verification:");
      console.log(`  healthy links: ${finalAudit.counts.healthyLinks}`);
      console.log(`  recoverable links remaining: ${finalAudit.counts.repairableLinks}`);
      console.log(`  ambiguous timestamps remaining: ${finalAudit.counts.ambiguousTimestamps}`);
      console.log(`  blocked repairs remaining: ${finalAudit.counts.blockedRepairs}`);
    }
  } finally {
    db.close();
  }
}
