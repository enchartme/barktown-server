#!/usr/bin/env node
/** Re-analyze eligible diary recordings for one day or an inclusive date range. */

import { loadEnv } from "./lib/env.mjs";
loadEnv(import.meta.url);

import {
  parseBulkReanalyzeArgs,
  runBulkReanalysis,
  selectReanalyzableEntries,
} from "./lib/bulk-reanalyze.mjs";
import { waitForReanalysisJob } from './lib/reanalysis-job-client.mjs';

const args = process.argv.slice(2);
let selection;
try {
  selection = parseBulkReanalyzeArgs(args);
} catch (error) {
  console.error("Usage: npm run bulk-reanalyze -- YYYY-MM-DD");
  console.error("   or: npm run bulk-reanalyze -- --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]");
  console.error("Options: -t, --threshold N; -r, --refractory SECONDS; -w, --window SECONDS; -s, --step SECONDS");
  console.error('         --upload-min-score N|any (historical replay only; any = 0)');
  console.error('         --historical (only original AAC/M4A imports); --dry-run (list without processing)');
  console.error(`Error: ${error.message}`);
  process.exit(2);
}
const { startDate, endDate, tuning, historical = false, dryRun = false } = selection;

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
const requestedConcurrency = Number.parseInt(process.env.BULK_REANALYZE_CONCURRENCY ?? "1", 10);
if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
  console.error("BULK_REANALYZE_CONCURRENCY must be a positive integer.");
  process.exit(2);
}

// Independent HTTP requests cannot share a day job's reservation.
const concurrency = 1;
if (requestedConcurrency > 1) {
  console.warn("Serializing CLI requests to respect the API re-analysis lock; use a day job for pooled scoring.");
}

async function readJsonResponse(res) {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

let diary;
try {
  diary = await readJsonResponse(await fetch(`${publicApiBase}/api/diary?${new URLSearchParams({ startDate, endDate })}`));
} catch (error) {
  console.error(`Could not load diary from ${publicApiBase}: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(diary)) {
  console.error("Diary API returned an invalid response.");
  process.exit(1);
}

const selectedEntries = diary.filter(entry => entry?.date >= startDate && entry.date <= endDate
  && (!historical || entry.reanalysisMode === 'historical'));
const eligible = selectReanalyzableEntries(diary, startDate, endDate, { historical })
  .sort((a, b) => (a.datetimeLocal ?? a.date).localeCompare(b.datetimeLocal ?? b.date) || a.id.localeCompare(b.id));
const skipped = selectedEntries.length - eligible.length;
const dateLabel = startDate === endDate ? startDate : `${startDate} through ${endDate}`;

console.log(`Bulk re-analysis: ${dateLabel}`);
console.log(`Selection: ${historical ? 'historical AAC/M4A sources only' : 'all eligible recordings'}`);
console.log(`Read API: ${publicApiBase}`);
console.log(`Private API: ${privateApiBase}`);
console.log(`Entries: ${selectedEntries.length}; eligible: ${eligible.length}; unavailable: ${skipped}`);
console.log(`Concurrent recordings: ${concurrency}`);
console.log(`Overrides: ${Object.keys(tuning).length ? JSON.stringify(tuning) : "none (using DB defaults)"}`);

if (dryRun) {
  for (const entry of eligible) console.log(`WOULD RUN ${entry.id} — ${entry.filename ?? ''}`);
  console.log('Dry run: no recordings were processed.');
  process.exit(0);
}

if (eligible.length === 0) {
  console.log("Nothing to re-analyze.");
  process.exit(0);
}

const results = await runBulkReanalysis(eligible, {
  concurrency,
  stopOnError: historical,
  analyze: async (entry) => {
    let response;
    try {
      response = await fetch(`${privateApiBase}/api/diary/${encodeURIComponent(entry.id)}/reanalyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Barktown-Reanalysis-Mode": "bulk",
        },
        body: JSON.stringify(tuning),
        ...(entry.reanalysisMode === 'historical' ? { signal: AbortSignal.timeout(30000) } : {}),
      });
    } catch (error) {
      // A lost POST response may still have started a detached server job.
      error.stopBulk = true;
      throw error;
    }
    const body = await readJsonResponse(response);
    if (response.status !== 202) return body;
    let previousProgress;
    return waitForReanalysisJob(body, entry.id, async () => readJsonResponse(await fetch(
      `${privateApiBase}/api/reanalysis`, { cache: 'no-store', signal: AbortSignal.timeout(10000) },
    )), { onProgress: job => {
      const progress = `${job.stage ?? 'starting'}${job.eventTotal !== undefined ? ` ${job.eventsCompleted ?? 0}/${job.eventTotal} clips` : ''}`;
      if (progress !== previousProgress) console.log(`WAIT  ${entry.id} — ${progress}`);
      previousProgress = progress;
    } });
  },
  onStart: ({ entry, index, total }) => {
    console.log(`START ${String(index + 1).padStart(String(total).length)}/${total} ${entry.id}`);
  },
  onFinish: ({ status, entry, value, reason, completed, total, elapsedMs }) => {
    const progress = `${String(completed).padStart(String(total).length)}/${total}`;
    const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
    if (status === "fulfilled") {
      const outcome = Array.isArray(value?.replacementIds)
        ? `${value.replacementIds.length} event clip(s)${value.message ? `; ${value.message}` : ''}`
        : `${value?.timestamps?.length ?? 0} hit(s)`;
      console.log(`OK    ${progress} ${entry.id} — ${outcome}, ${elapsed}`);
    } else {
      console.error(`FAIL  ${progress} ${entry.id} — ${reason?.message ?? reason}, ${elapsed}`);
    }
  },
});

const succeeded = results.filter(result => result.status === "fulfilled").length;
const failed = results.length - succeeded;
console.log(`Done: ${succeeded} succeeded, ${failed} failed, ${skipped} unavailable.`);
if (results.length < eligible.length) console.error(`Stopped: ${eligible.length - results.length} recording(s) not started. Check /api/reanalysis before rerunning.`);
if (failed > 0) process.exitCode = 1;
