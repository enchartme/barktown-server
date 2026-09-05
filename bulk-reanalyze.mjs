#!/usr/bin/env node
/** Re-analyze eligible diary recordings for one day or an inclusive date range. */

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import {
  parseBulkReanalyzeArgs,
  runBulkReanalysis,
  selectReanalyzableEntries,
} from "./lib/bulk-reanalyze.mjs";

const args = process.argv.slice(2);
let selection;
try {
  selection = parseBulkReanalyzeArgs(args);
} catch (error) {
  console.error("Usage: npm run bulk-reanalyze -- YYYY-MM-DD");
  console.error("   or: npm run bulk-reanalyze -- --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]");
  console.error("Options: -t, --threshold N; -r, --refractory SECONDS; -w, --window SECONDS; -s, --step SECONDS");
  console.error(`Error: ${error.message}`);
  process.exit(2);
}
const { startDate, endDate, tuning } = selection;

const publicPort = process.env.PUBLIC_API_PORT ?? "8091";
const privatePort = process.env.PRIVATE_API_PORT ?? process.env.API_PORT ?? "8090";
const publicApiBase = (
  process.env.BULK_REANALYZE_PUBLIC_API_URL
  ?? `http://127.0.0.1:${publicPort}`
).replace(/\/$/, "");
const privateApiBase = (
  process.env.BULK_REANALYZE_PRIVATE_API_URL
  ?? process.env.BULK_REANALYZE_API_URL
  ?? `http://127.0.0.1:${privatePort}`
).replace(/\/$/, "");
const concurrency = Number.parseInt(process.env.REANALYZE_CONCURRENCY ?? "4", 10);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  console.error("REANALYZE_CONCURRENCY must be a positive integer.");
  process.exit(2);
}

async function readJsonResponse(res) {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

let diary;
try {
  diary = await readJsonResponse(await fetch(`${publicApiBase}/api/diary`));
} catch (error) {
  console.error(`Could not load diary from ${publicApiBase}: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(diary)) {
  console.error("Diary API returned an invalid response.");
  process.exit(1);
}

const selectedEntries = diary.filter(entry => entry?.date >= startDate && entry.date <= endDate);
const eligible = selectReanalyzableEntries(diary, startDate, endDate);
const skipped = selectedEntries.length - eligible.length;
const dateLabel = startDate === endDate ? startDate : `${startDate} through ${endDate}`;

console.log(`Bulk re-analysis: ${dateLabel}`);
console.log(`Read API: ${publicApiBase}`);
console.log(`Private API: ${privateApiBase}`);
console.log(`Entries: ${selectedEntries.length}; eligible: ${eligible.length}; unavailable: ${skipped}`);
console.log(`Workers: ${concurrency}`);
console.log(`Overrides: ${Object.keys(tuning).length ? JSON.stringify(tuning) : "none (using DB defaults)"}`);

if (eligible.length === 0) {
  console.log("Nothing to re-analyze.");
  process.exit(0);
}

const results = await runBulkReanalysis(eligible, {
  concurrency,
  analyze: async (entry) => readJsonResponse(await fetch(
    `${privateApiBase}/api/diary/${encodeURIComponent(entry.id)}/reanalyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tuning),
    },
  )),
  onStart: ({ entry, index, total }) => {
    console.log(`START ${String(index + 1).padStart(String(total).length)}/${total} ${entry.id}`);
  },
  onFinish: ({ status, entry, value, reason, completed, total, elapsedMs }) => {
    const progress = `${String(completed).padStart(String(total).length)}/${total}`;
    const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
    if (status === "fulfilled") {
      console.log(`OK    ${progress} ${entry.id} — ${value?.timestamps?.length ?? 0} hit(s), ${elapsed}`);
    } else {
      console.error(`FAIL  ${progress} ${entry.id} — ${reason?.message ?? reason}, ${elapsed}`);
    }
  },
});

const succeeded = results.filter(result => result.status === "fulfilled").length;
const failed = results.length - succeeded;
console.log(`Done: ${succeeded} succeeded, ${failed} failed, ${skipped} unavailable.`);
if (failed > 0) process.exitCode = 1;
