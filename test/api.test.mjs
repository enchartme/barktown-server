// test/api.test.mjs — integration tests for server.mjs's HTTP API.
//
// Runs the real server.mjs as a child process against a throwaway SQLite
// DB (no mocking of Fastify, routes, or the DB layer). Only exercises
// annotation endpoints + read-only sample endpoints, which don't touch
// MinIO, so no object storage needs to be running.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDb, upsertSample, upsertDiaryEntry, upsertHitMetadata } from "../lib/db.mjs";
import { startTestServer } from "./helpers/test-server.mjs";

let tmpDir;
let seedDb;
let server;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-ingest-test-"));
  const dbPath = path.join(tmpDir, "test.db");

  seedDb = openDb(dbPath);
  upsertSample(seedDb, {
    id: "sample-001",
    filename: "2026-01-01 12-00-00 SAMPLE bark.wav",
    audioPath: "training-samples/bark/2026-01-01 12-00-00 SAMPLE bark.wav",
    waveformPath: null,
    label: "bark",
    date: "2026-01-01",
    datetimeLocal: "2026-01-01T12:00:00",
    durationSec: 2,
  });
  upsertDiaryEntry(seedDb, {
    id: "2026-01-02_13-14-15_false-positive",
    filename: "2026-01-02 13-14-15 false-positive.mp3",
    audioPath: "audio/2026/01/2026-01-02 13-14-15 false-positive.mp3",
    waveformPath: "waveforms/2026/01/2026-01-02_13-14-15_false-positive.json",
    label: "false-positive",
    date: "2026-01-02",
    time: "13:14",
    datetimeLocal: "2026-01-02T13:14:15",
    durationSec: 8,
    kind: "audio",
  });
  upsertHitMetadata(seedDb, "2026-01-02_13-14-15_false-positive", {
    timestamps: [1], confidences: [0.91], loudnesses: [1.1], paddingS: 1.5, windowS: 1.5,
    modelTrainedAt: "2026-01-01T10:00:00Z",
    analysisSettings: {
      classifier: { model_sha256: "a".repeat(64), threshold: 0.42 },
      monitor: { candidate_threshold: 0.92 },
    },
    analysisTrigger: "automatic",
  });

  for (const [day, second] of [["03", 2], ["04", 3]]) {
    const id = `2026-01-${day}_13-14-15_auto`;
    upsertDiaryEntry(seedDb, {
      id,
      filename: `2026-01-${day} 13-14-15 auto.mp3`,
      audioPath: `audio/2026/01/2026-01-${day} 13-14-15 auto.mp3`,
      waveformPath: null,
      label: "-A- auto",
      date: `2026-01-${day}`,
      time: "13:14",
      datetimeLocal: `2026-01-${day}T13:14:15`,
      durationSec: 8,
      kind: "audio",
    });
    upsertHitMetadata(seedDb, id, {
      timestamps: [second], confidences: [0.92], loudnesses: [1.2], paddingS: 1.5, windowS: 1.5,
    });
  }
  // Metadata can arrive before asynchronous diary ingestion creates its row.
  upsertHitMetadata(seedDb, "orphan-clip", {
    timestamps: [4], confidences: [0.93], loudnesses: [1.3], paddingS: 1.5, windowS: 1.5,
  });

  server = await startTestServer({ dbPath });
});

after(async () => {
  await server.stop();
  seedDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /health reports ok", async () => {
  const res = await fetch(`${server.baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("CORS preflight allows PATCH and DELETE", async () => {
  // Regression test for the bug where @fastify/cors's default `methods`
  // ("GET,HEAD,POST") silently rejected PATCH/DELETE preflight requests,
  // which browsers reported as a generic, hard-to-diagnose CORS failure.
  const res = await fetch(`${server.baseUrl}/api/annotations`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://example.test",
      "Access-Control-Request-Method": "PATCH",
    },
  });
  const allowed = res.headers.get("access-control-allow-methods") ?? "";
  assert.match(allowed, /PATCH/);
  assert.match(allowed, /DELETE/);
});

test("GET /api/samples/:id returns the seeded sample", async () => {
  const res = await fetch(`${server.baseUrl}/api/samples/sample-001`);
  assert.equal(res.status, 200);
  const sample = await res.json();
  assert.equal(sample.id, "sample-001");
  assert.equal(sample.label, "bark");
});

test("GET /api/samples/:id returns 404 for an unknown id", async () => {
  const res = await fetch(`${server.baseUrl}/api/samples/does-not-exist`);
  assert.equal(res.status, 404);
});

test("GET /api/hit-metadata paginates and advertises the next and final pages", async () => {
  const firstRes = await fetch(`${server.baseUrl}/api/hit-metadata?page=1&pageSize=2`);
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json();
  assert.equal(first.items.length, 2);
  assert.equal(first.pagination.totalRecords, 4);
  assert.equal(first.pagination.totalPages, 2);
  assert.equal(first.pagination.hasNextPage, true);
  assert.equal(first.pagination.isLastPage, false);
  assert.equal(first.pagination.complete, false);
  assert.equal(first.pagination.nextPage, 2);
  assert.match(first.links.next, /page=2/);
  assert.match(firstRes.headers.get("link") ?? "", /rel="next"/);
  const seeded = first.items.find(item => item.clipId === "2026-01-02_13-14-15_false-positive");
  assert.equal(seeded.modelTrainedAt, "2026-01-01T10:00:00Z");
  assert.equal(seeded.analysisTrigger, "automatic");
  assert.equal(seeded.analysisSettings.monitor.candidate_threshold, 0.92);

  const secondRes = await fetch(`${server.baseUrl}${first.links.next}`);
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json();
  assert.equal(second.items.length, 2);
  assert.equal(second.pagination.hasNextPage, false);
  assert.equal(second.pagination.isLastPage, true);
  assert.equal(second.pagination.complete, true);
  assert.equal(second.pagination.nextPage, null);
  assert.equal(second.links.next, null);
  const orphan = second.items.at(-1);
  assert.equal(orphan.clipId, "orphan-clip");
  assert.equal(orphan.date, null);
  assert.deepEqual(orphan.timestamps, [4]);
});

test("GET /api/hit-metadata filters inclusively by diary date", async () => {
  const res = await fetch(`${server.baseUrl}/api/hit-metadata?startDate=2026-01-03&endDate=2026-01-03`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pagination.totalRecords, 1);
  assert.equal(body.items[0].clipId, "2026-01-03_13-14-15_auto");
  assert.equal(body.items[0].date, "2026-01-03");
});

test("GET /api/hit-metadata validates pagination and date bounds", async () => {
  for (const query of [
    "page=0",
    "pageSize=1001",
    "startDate=2026-02-30",
    "startDate=2026-01-04&endDate=2026-01-03",
  ]) {
    const res = await fetch(`${server.baseUrl}/api/hit-metadata?${query}`);
    assert.equal(res.status, 400, query);
  }
});

test("POST /api/diary/:id/hit-metadata stores and exposes analysis provenance", async () => {
  const payload = {
    timestamps: [1.25],
    confidences: [0.87],
    loudnesses: [2.1],
    padding_s: 1.5,
    window_s: 1.5,
    model_trained_at: "2026-08-12T15:32:07+02:00",
    analysis_settings: {
      classifier: { model_sha256: "b".repeat(64), threshold: 0.42 },
      monitor: { candidate_threshold: 0.8 },
    },
    analysis_trigger: "manual",
  };
  const res = await fetch(`${server.baseUrl}/api/diary/provenance-test/hit-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 201);
  const stored = await res.json();
  assert.equal(stored.modelTrainedAt, payload.model_trained_at);
  assert.deepEqual(stored.analysisSettings, payload.analysis_settings);
  assert.equal(stored.analysisTrigger, "manual");
});

test("POST /api/diary/:id/hit-metadata canonicalizes legacy stats IDs", async () => {
  const legacyId = "2026-08-01_11-08-24_-A-_C1_D11_W9_La1_4_Lm1_2";
  const canonicalId = "2026-08-01_11-08-24_-A-";
  const res = await fetch(`${server.baseUrl}/api/diary/${legacyId}/hit-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamps: [1], confidences: [1], loudnesses: [1.4] }),
  });

  assert.equal(res.status, 201);
  assert.equal((await res.json()).clipId, canonicalId);
  assert.equal((await fetch(`${server.baseUrl}/api/diary/${legacyId}/hit-metadata`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/api/diary/${canonicalId}/hit-metadata`)).status, 200);
});

test("POST /api/diary/:id/hit-metadata validates provenance fields", async () => {
  const base = { timestamps: [], confidences: [], loudnesses: [] };
  for (const [field, value, expected] of [
    ["model_trained_at", "2026-08-12T15:32:07", /timezone/],
    ["analysis_settings", [], /JSON object/],
    ["analysis_trigger", "scheduled", /automatic or manual/],
  ]) {
    const res = await fetch(`${server.baseUrl}/api/diary/invalid-provenance/hit-metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, [field]: value }),
    });
    assert.equal(res.status, 400, field);
    assert.match((await res.json()).error, expected);
  }
});

test("POST /api/diary/:id/move-to-samples rejects labels outside the taxonomy", async () => {
  const res = await fetch(`${server.baseUrl}/api/diary/2026-01-02_13-14-15_false-positive/move-to-samples`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "other" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /label must be one of/);
});

let annotationId;

test("POST /api/samples/:id/annotations creates a fragment", async () => {
  const res = await fetch(`${server.baseUrl}/api/samples/sample-001/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startSec: 0.5, endSec: 1.0, label: "bark", source: "manual" }),
  });
  assert.equal(res.status, 201);
  const annotation = await res.json();
  assert.equal(annotation.sampleId, "sample-001");
  assert.equal(annotation.label, "bark");
  annotationId = annotation.id;
});

test("POST /api/samples/:id/annotations rejects endSec < startSec", async () => {
  const res = await fetch(`${server.baseUrl}/api/samples/sample-001/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startSec: 1.0, endSec: 0.5, label: "bark" }),
  });
  assert.equal(res.status, 400);
});

test("GET /api/annotations aggregates across samples, joined with sample fields", async () => {
  const res = await fetch(`${server.baseUrl}/api/annotations`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  const row = rows.find((r) => r.id === annotationId);
  assert.ok(row, "seeded annotation should be present");
  assert.equal(row.sampleAudioPath, "training-samples/bark/2026-01-01 12-00-00 SAMPLE bark.wav");
  assert.equal(row.sampleDurationSec, 2);
});

test("PATCH /api/annotations/:id updates the label", async () => {
  const res = await fetch(`${server.baseUrl}/api/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "yap" }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.label, "yap");
});

test("DELETE /api/annotations/:id removes it", async () => {
  const res = await fetch(`${server.baseUrl}/api/annotations/${annotationId}`, { method: "DELETE" });
  assert.equal(res.status, 204);

  const check = await fetch(`${server.baseUrl}/api/annotations`);
  const rows = await check.json();
  assert.ok(!rows.some((r) => r.id === annotationId));
});
