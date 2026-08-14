// test/monitor-params.test.mjs — integration tests for the monitor_params
// DB table (single source of truth for barktown-goblin's bark-monitor
// tuning) and its GET/PATCH routes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDb } from "../lib/db.mjs";
import { startTestServer } from "./helpers/test-server.mjs";

let tmpDir;
let seedDb;
let server;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-monitor-params-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  seedDb = openDb(dbPath); // openDb() seeds monitor_params idempotently
  server = await startTestServer({ dbPath, mode: "private" });
});

after(async () => {
  await server.stop();
  seedDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /api/monitor-params returns the seeded params with defaults and ranges", async () => {
  const res = await fetch(`${server.baseUrl}/api/monitor-params`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.length >= 10);
  const candidate = rows.find(r => r.paramId === "candidate_threshold");
  assert.equal(candidate.currentValue, 0.92);
  assert.equal(candidate.defaultValue, 0.92);
  assert.equal(candidate.minValue, 0);
  assert.equal(candidate.maxValue, 1);
  assert.ok(candidate.description.length > 0);
});

test("PATCH /api/monitor-params/:paramId updates current_value within range", async () => {
  const res = await fetch(`${server.baseUrl}/api/monitor-params/candidate_threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: 0.6 }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.currentValue, 0.6);
  assert.equal(updated.defaultValue, 0.92); // default is untouched

  const list = await (await fetch(`${server.baseUrl}/api/monitor-params`)).json();
  assert.equal(list.find(r => r.paramId === "candidate_threshold").currentValue, 0.6);
});

test("PATCH /api/monitor-params/:paramId rejects out-of-range values", async () => {
  const res = await fetch(`${server.baseUrl}/api/monitor-params/candidate_threshold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: 1.5 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /<= 1/);
});

test("PATCH /api/monitor-params/:paramId rejects an unknown param", async () => {
  const res = await fetch(`${server.baseUrl}/api/monitor-params/not_a_real_param`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: 1 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown monitor param/);
});
