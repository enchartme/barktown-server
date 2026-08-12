import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isIsoDate,
  runBulkReanalysis,
  selectReanalyzableEntries,
} from "../lib/bulk-reanalyze.mjs";

test("bulk re-analysis requires a real ISO calendar date", () => {
  assert.equal(isIsoDate("2026-08-12"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("12-08-2026"), false);
});

test("bulk selection is limited to one date and currently available sources", () => {
  const entries = [
    { id: "a", date: "2026-08-12", reanalyzable: true },
    { id: "b", date: "2026-08-12", reanalyzable: false },
    { id: "c", date: "2026-08-13", reanalyzable: true },
  ];
  assert.deepEqual(selectReanalyzableEntries(entries, "2026-08-12"), [entries[0]]);
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
