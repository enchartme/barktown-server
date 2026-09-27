import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReanalysisLimiter,
  ReanalysisAlreadyRunningError,
} from "../lib/reanalysis-limiter.mjs";

const nextTurn = () => new Promise(resolve => setImmediate(resolve));


test("re-analysis limiter rejects duplicate records and serializes distinct records", async () => {
  const limiter = createReanalysisLimiter();
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const order = [];

  const first = limiter.run("clip-a", async () => {
    order.push("a:start");
    await firstGate;
    order.push("a:end");
  });
  await Promise.resolve();

  await assert.rejects(
    limiter.run("clip-a", async () => {}),
    ReanalysisAlreadyRunningError,
  );

  const second = limiter.run("clip-b", async () => {
    order.push("b:start");
    order.push("b:end");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["a:start"]);
  assert.equal(limiter.isScheduled("clip-b"), true);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  assert.equal(limiter.isScheduled("clip-a"), false);
  assert.equal(limiter.isScheduled("clip-b"), false);
});

test("re-analysis limiter runs up to its configured concurrency and keeps queued work FIFO", async () => {
  const limiter = createReanalysisLimiter({ concurrency: 2 });
  const releases = [];
  const started = [];
  const operation = id => limiter.run(id, async () => {
    started.push(id);
    await new Promise(resolve => releases.push(resolve));
  });

  const jobs = [operation("a"), operation("b"), operation("c"), operation("d")];
  await Promise.resolve();
  assert.deepEqual([...started], ["a", "b"]);
  assert.equal(limiter.activeCount, 2);
  assert.equal(limiter.pendingCount, 2);

  releases.shift()();
  await nextTurn();
  assert.deepEqual([...started], ["a", "b", "c"]);

  releases.shift()();
  await nextTurn();
  assert.deepEqual([...started], ["a", "b", "c", "d"]);

  releases.splice(0).forEach(resolve => resolve());
  await Promise.all(jobs);
  assert.equal(limiter.activeCount, 0);
  assert.equal(limiter.pendingCount, 0);
});

test("weighted slots give one interactive file the full budget and keep FIFO fairness", async () => {
  const limiter = createReanalysisLimiter({ concurrency: 4 });
  const releases = new Map();
  const started = [];
  const operation = (id, slots) => limiter.run(id, async () => {
    started.push(id);
    await new Promise(resolve => releases.set(id, resolve));
  }, { slots });

  const firstBulk = operation("bulk-a", 1);
  const secondBulk = operation("bulk-b", 1);
  const interactive = operation("interactive", 4);
  const laterBulk = operation("bulk-c", 1);
  await nextTurn();

  assert.deepEqual(started, ["bulk-a", "bulk-b"]);
  assert.equal(limiter.activeCount, 2);
  assert.equal(limiter.activeSlots, 2);
  assert.equal(limiter.pendingCount, 2);

  releases.get("bulk-a")();
  await nextTurn();
  assert.deepEqual(started, ["bulk-a", "bulk-b"]);

  releases.get("bulk-b")();
  await nextTurn();
  assert.deepEqual(started, ["bulk-a", "bulk-b", "interactive"]);
  assert.equal(limiter.activeCount, 1);
  assert.equal(limiter.activeSlots, 4);
  assert.equal(limiter.pendingCount, 1);

  releases.get("interactive")();
  await nextTurn();
  assert.deepEqual(started, ["bulk-a", "bulk-b", "interactive", "bulk-c"]);
  assert.equal(limiter.activeSlots, 1);

  releases.get("bulk-c")();
  await Promise.all([firstBulk, secondBulk, interactive, laterBulk]);
  assert.equal(limiter.activeCount, 0);
  assert.equal(limiter.activeSlots, 0);
});

test("weighted slots must fit within the configured CPU budget", async () => {
  const limiter = createReanalysisLimiter({ concurrency: 2 });
  await assert.rejects(
    limiter.run("too-wide", async () => {}, { slots: 3 }),
    /slots must be an integer in \[1, 2\]/,
  );
});

test("re-analysis limiter validates concurrency", () => {
  assert.throws(() => createReanalysisLimiter({ concurrency: 0 }), /positive integer/);
  assert.throws(() => createReanalysisLimiter({ concurrency: 1.5 }), /positive integer/);
});
