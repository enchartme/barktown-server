import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReanalysisLimiter,
  ReanalysisAlreadyRunningError,
} from "../lib/reanalysis-limiter.mjs";


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
