import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isIsoDate,
  parseBulkReanalyzeArgs,
  runBulkReanalysis,
  selectReanalyzableEntries,
} from "../lib/bulk-reanalyze.mjs";

test("bulk re-analysis requires a real ISO calendar date", () => {
  assert.equal(isIsoDate("2026-08-12"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("12-08-2026"), false);
});

test("bulk arguments accept one day and an inclusive range with tuning overrides", () => {
  assert.deepEqual(parseBulkReanalyzeArgs(["2026-08-20"]), {
    startDate: "2026-08-20",
    endDate: "2026-08-20",
    tuning: {},
  });
  assert.deepEqual(parseBulkReanalyzeArgs([
    "--start-date", "2026-08-20",
    "--end-date", "2026-08-27",
    "-t", "0.9",
    "-r", "1.25",
    "-w", "1.5",
    "-s", "0.25",
  ]), {
    startDate: "2026-08-20",
    endDate: "2026-08-27",
    tuning: {
      candidateThreshold: 0.9,
      hitRefractoryS: 1.25,
      inferenceWindowS: 1.5,
      scoreIntervalS: 0.25,
    },
  });
});

test("bulk arguments reject incomplete ranges, invalid bounds, and mixed date forms", () => {
  assert.throws(() => parseBulkReanalyzeArgs([]), /provide one date/);
  assert.throws(() => parseBulkReanalyzeArgs(["--start-date", "2026-08-20"]), /both/);
  assert.throws(() => parseBulkReanalyzeArgs([
    "--start-date", "2026-08-27", "--end-date", "2026-08-20",
  ]), /later than/);
  assert.throws(() => parseBulkReanalyzeArgs(["2026-08-20", "-t", "1.1"]), /threshold/);
  assert.throws(() => parseBulkReanalyzeArgs([
    "2026-08-20", "--start-date", "2026-08-20", "--end-date", "2026-08-21",
  ]), /not both/);
});

test("bulk selection is limited to an inclusive date range and available sources", () => {
  const entries = [
    { id: "a", date: "2026-08-12", reanalyzable: true },
    { id: "b", date: "2026-08-13", reanalyzable: false },
    { id: "c", date: "2026-08-13", reanalyzable: true },
    { id: "d", date: "2026-08-14", reanalyzable: true },
  ];
  assert.deepEqual(selectReanalyzableEntries(entries, "2026-08-12", "2026-08-13"), [
    entries[0],
    entries[2],
  ]);
});

test("bulk worker pool bounds concurrency, reports progress, and continues after failure", async () => {
  const entries = ["a", "b", "c", "d", "e"].map(id => ({ id }));
  const releases = [];
  const started = [];
  const finished = [];
  let active = 0;
  let peakActive = 0;

  const run = runBulkReanalysis(entries, {
    concurrency: 2,
    analyze: async entry => {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(resolve => releases.push(resolve));
      active--;
      if (entry.id === "c") throw new Error("broken clip");
      return { id: entry.id };
    },
    onStart: ({ entry }) => started.push(entry.id),
    onFinish: result => finished.push(result),
  });

  await Promise.resolve();
  assert.deepEqual(started, ["a", "b"]);
  while (releases.length || started.length < entries.length) {
    const release = releases.shift();
    if (release) release();
    await Promise.resolve();
    await Promise.resolve();
  }
  releases.splice(0).forEach(resolve => resolve());

  const results = await run;
  assert.equal(peakActive, 2);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 4);
  assert.equal(results[2].status, "rejected");
  assert.match(results[2].reason.message, /broken clip/);
  assert.equal(finished.length, 5);
  assert.deepEqual(results.map(result => result.entry.id), entries.map(entry => entry.id));
});
