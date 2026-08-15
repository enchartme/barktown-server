// test/api.test.mjs — integration tests for the split public/private APIs.
//
// Runs both real entry points as child processes against one throwaway SQLite
// DB (no mocking of Fastify, routes, or the DB layer).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDb, upsertSample, upsertDiaryEntry, upsertHitMetadata } from "../lib/db.mjs";
import { startTestServer } from "./helpers/test-server.mjs";

let tmpDir;
let seedDb;
let publicServer;
let privateServer;

const recordingContext = {
  album: "Neighbourhood watch",
  location: "Test garden",
  direction: "facing east",
  copyright: "© 2026 Barktown",
};

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
    if (day === "03") {
      upsertSample(seedDb, {
        id: "sample-linked",
        filename: "2026-01-03 13-14-15 SAMPLE bark.wav",
        audioPath: "training-samples/bark/2026-01-03 13-14-15 SAMPLE bark.wav",
        waveformPath: null,
        label: "bark",
        date: "2026-01-03",
        datetimeLocal: "2026-01-03T13:14:15",
        durationSec: 8,
        diaryId: id,
      });
    }
  }
  // Metadata can arrive before asynchronous diary ingestion creates its row.
  upsertHitMetadata(seedDb, "orphan-clip", {
    timestamps: [4], confidences: [0.93], loudnesses: [1.3], paddingS: 1.5, windowS: 1.5,
  });

  publicServer = await startTestServer({
    dbPath,
    mode: "public",
    env: {
      RECORDING_ALBUM: recordingContext.album,
      RECORDING_LOCATION: recordingContext.location,
      RECORDING_DIRECTION: recordingContext.direction,
      RECORDING_COPYRIGHT: recordingContext.copyright,
    },
  });
  privateServer = await startTestServer({ dbPath, mode: "private" });
});

after(async () => {
  await Promise.all([publicServer.stop(), privateServer.stop()]);
  seedDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("both API processes report healthy", async () => {
  for (const server of [publicServer, privateServer]) {
    const res = await fetch(`${server.baseUrl}/health`);
    assert.equal(res.status, 200, server.mode);
    assert.deepEqual(await res.json(), { ok: true });
  }
});

test("CORS preflight allows PUT, PATCH and DELETE", async () => {
  // Regression test for the bug where @fastify/cors's default `methods`
  // ("GET,HEAD,POST") silently rejected PATCH/DELETE preflight requests,
  // which browsers reported as a generic, hard-to-diagnose CORS failure.
  const res = await fetch(`${privateServer.baseUrl}/api/annotations`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://example.test",
      "Access-Control-Request-Method": "PATCH",
    },
  });
  const allowed = res.headers.get("access-control-allow-methods") ?? "";
  assert.match(allowed, /PUT/);
  assert.match(allowed, /PATCH/);
  assert.match(allowed, /DELETE/);
});

test("public API is non-cacheable and does not register mutation routes", async () => {
  const read = await fetch(`${publicServer.baseUrl}/api/samples`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");

  const mutation = await fetch(`${publicServer.baseUrl}/api/samples/sample-001`, {
    method: "DELETE",
  });
  assert.equal(mutation.status, 404);
});

test("GET /api/recording-context exposes public report metadata", async () => {
  const res = await fetch(`${publicServer.baseUrl}/api/recording-context`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), recordingContext);

  const privateRes = await fetch(`${privateServer.baseUrl}/api/recording-context`);
  assert.equal(privateRes.status, 404);
});

test("private API does not duplicate public data routes", async () => {
  const res = await fetch(`${privateServer.baseUrl}/api/samples/sample-001`);
  assert.equal(res.status, 404);
});

test("GET /api/samples/:id returns the seeded sample", async () => {
  const res = await fetch(`${publicServer.baseUrl}/api/samples/sample-001`);
  assert.equal(res.status, 200);
  const sample = await res.json();
  assert.equal(sample.id, "sample-001");
  assert.equal(sample.label, "bark");
});

test("GET /api/samples/:id returns 404 for an unknown id", async () => {
  const res = await fetch(`${publicServer.baseUrl}/api/samples/does-not-exist`);
  assert.equal(res.status, 404);
});

test("GET /api/diary filters inclusively by diary date", async () => {
  const res = await fetch(`${publicServer.baseUrl}/api/diary?startDate=2026-01-03&endDate=2026-01-04`);
  assert.equal(res.status, 200);
  const entries = await res.json();
  assert.deepEqual(entries.map(entry => entry.date), ["2026-01-03", "2026-01-04"]);
});

test("GET /api/diary/latest-date returns only the newest available date", async () => {
  const res = await fetch(`${publicServer.baseUrl}/api/diary/latest-date`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { date: "2026-01-04" });
});

test("PUT /api/diary/:id/comment creates and updates an unlinked diary note", async () => {
  const url = `${privateServer.baseUrl}/api/diary/2026-01-02_13-14-15_false-positive/comment`;
  const create = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Garden comment" }),
  });
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.equal(created.length, 1);
  assert.equal(created[0].scope, "diary");
  assert.equal(created[0].label, "Garden comment");

  const update = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Updated garden comment" }),
  });
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, created[0].id);
  assert.equal(updated[0].label, "Updated garden comment");

  const publicEntry = await fetch(`${publicServer.baseUrl}/api/diary/2026-01-02_13-14-15_false-positive`);
  assert.equal(publicEntry.status, 200);
  assert.deepEqual((await publicEntry.json()).annotations, updated);
});

test("PUT /api/diary/:id/comment uses a linked sample-wide annotation", async () => {
  const res = await fetch(`${privateServer.baseUrl}/api/diary/2026-01-03_13-14-15_auto/comment`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Linked automatic comment" }),
  });
  assert.equal(res.status, 200);
  const annotations = await res.json();
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].scope, "sample");
  assert.equal(annotations[0].sampleId, "sample-linked");
  assert.equal(annotations[0].label, "Linked automatic comment");

  const publicList = await fetch(`${publicServer.baseUrl}/api/diary?startDate=2026-01-03&endDate=2026-01-03`);
  const entries = await publicList.json();
  assert.deepEqual(entries[0].annotations, annotations);
});

test("PUT /api/diary/:id/comment validates the label and stays private", async () => {
  const path = "/api/diary/2026-01-04_13-14-15_auto/comment";
  const invalid = await fetch(`${privateServer.baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "   " }),
  });
  assert.equal(invalid.status, 400);

  const publicMutation = await fetch(`${publicServer.baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "not allowed" }),
  });
  assert.equal(publicMutation.status, 404);
});

test("GET /api/diary validates date bounds", async () => {
  for (const query of [
    "startDate=2026-02-30",
    "endDate=not-a-date",
    "startDate=2026-01-04&endDate=2026-01-03",
  ]) {
    const res = await fetch(`${publicServer.baseUrl}/api/diary?${query}`);
    assert.equal(res.status, 400, query);
  }
});

test("GET /api/hit-metadata paginates and advertises the next and final pages", async () => {
  const firstRes = await fetch(`${publicServer.baseUrl}/api/hit-metadata?page=1&pageSize=2`);
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

  const secondRes = await fetch(`${publicServer.baseUrl}${first.links.next}`);
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
  const res = await fetch(`${publicServer.baseUrl}/api/hit-metadata?startDate=2026-01-03&endDate=2026-01-03`);
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
    const res = await fetch(`${publicServer.baseUrl}/api/hit-metadata?${query}`);
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
  const res = await fetch(`${privateServer.baseUrl}/api/diary/provenance-test/hit-metadata`, {
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
  const res = await fetch(`${privateServer.baseUrl}/api/diary/${legacyId}/hit-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamps: [1], confidences: [1], loudnesses: [1.4] }),
  });

  assert.equal(res.status, 201);
  assert.equal((await res.json()).clipId, canonicalId);
  assert.equal((await fetch(`${publicServer.baseUrl}/api/diary/${legacyId}/hit-metadata`)).status, 404);
  assert.equal((await fetch(`${publicServer.baseUrl}/api/diary/${canonicalId}/hit-metadata`)).status, 200);
});

test("POST /api/diary/:id/hit-metadata validates provenance fields", async () => {
  const base = { timestamps: [], confidences: [], loudnesses: [] };
  for (const [field, value, expected] of [
    ["model_trained_at", "2026-08-12T15:32:07", /timezone/],
    ["analysis_settings", [], /JSON object/],
    ["analysis_trigger", "scheduled", /automatic or manual/],
  ]) {
    const res = await fetch(`${privateServer.baseUrl}/api/diary/invalid-provenance/hit-metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, [field]: value }),
    });
    assert.equal(res.status, 400, field);
    assert.match((await res.json()).error, expected);
  }
});

test("POST /api/diary/:id/move-to-samples rejects labels outside the taxonomy", async () => {
  const res = await fetch(`${privateServer.baseUrl}/api/diary/2026-01-02_13-14-15_false-positive/move-to-samples`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "other" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /label must be one of/);
});

let annotationId;

test("POST /api/samples/:id/annotations creates a fragment", async () => {
  const res = await fetch(`${privateServer.baseUrl}/api/samples/sample-001/annotations`, {
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
  const res = await fetch(`${privateServer.baseUrl}/api/samples/sample-001/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startSec: 1.0, endSec: 0.5, label: "bark" }),
  });
  assert.equal(res.status, 400);
});

test("GET /api/annotations aggregates across samples, joined with sample fields", async () => {
  const res = await fetch(`${publicServer.baseUrl}/api/annotations`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  const row = rows.find((r) => r.id === annotationId);
  assert.ok(row, "seeded annotation should be present");
  assert.equal(row.sampleAudioPath, "training-samples/bark/2026-01-01 12-00-00 SAMPLE bark.wav");
  assert.equal(row.sampleDurationSec, 2);
});

test("PATCH /api/annotations/:id updates the label", async () => {
  const res = await fetch(`${privateServer.baseUrl}/api/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "yap" }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.label, "yap");
});

test("DELETE /api/annotations/:id removes it", async () => {
  const res = await fetch(`${privateServer.baseUrl}/api/annotations/${annotationId}`, { method: "DELETE" });
  assert.equal(res.status, 204);

  const check = await fetch(`${publicServer.baseUrl}/api/annotations`);
  const rows = await check.json();
  assert.ok(!rows.some((r) => r.id === annotationId));
});
