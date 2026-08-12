#!/usr/bin/env node
/** Re-analyze every currently eligible diary recording on one calendar date. */

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import {
  isIsoDate,
  runBulkReanalysis,
  selectReanalyzableEntries,
} from "./lib/bulk-reanalyze.mjs";

const args = process.argv.slice(2);
const date = args[0];
if (args.length !== 1 || !isIsoDate(date)) {
  console.error("Usage: npm run bulk-reanalyze -- YYYY-MM-DD");
  console.error("The date is required and must be a real calendar date.");
  process.exit(2);
}

const port = process.env.API_PORT ?? "8090";
const apiBase = (process.env.BULK_REANALYZE_API_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
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
  diary = await readJsonResponse(await fetch(`${apiBase}/api/diary`));
} catch (error) {
  console.error(`Could not load diary from ${apiBase}: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(diary)) {
  console.error("Diary API returned an invalid response.");
  process.exit(1);
}

const dayEntries = diary.filter(entry => entry?.date === date);
const eligible = selectReanalyzableEntries(diary, date);
const skipped = dayEntries.length - eligible.length;

console.log(`Bulk re-analysis: ${date}`);
console.log(`API: ${apiBase}`);
console.log(`Entries: ${dayEntries.length}; eligible: ${eligible.length}; unavailable: ${skipped}`);
console.log(`Workers: ${concurrency}`);

if (eligible.length === 0) {
  console.log("Nothing to re-analyze.");
  process.exit(0);
}

const results = await runBulkReanalysis(eligible, {
  concurrency,
  analyze: async (entry) => readJsonResponse(await fetch(
    `${apiBase}/api/diary/${encodeURIComponent(entry.id)}/reanalyze`,
    { method: "POST" },
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
