// test/export-fragments.test.mjs — end-to-end smoke test for
// barktown-utils' tools/export_fragments.py against this repo's real
// server.mjs, a throwaway SQLite DB, and a fixture asset server.
//
// This automates the manual verification steps used while building the
// tool: fresh export, idempotent re-run, relabel-only move (no
// re-download/re-slice), and delete-triggered orphan + cache pruning.
//
// Skipped automatically if the barktown-utils sibling repo (expected to
// be checked out next to this one) or python3 aren't available.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { openDb, upsertSample } from "../lib/db.mjs";
import { startTestServer } from "./helpers/test-server.mjs";
import { startStaticServer } from "./helpers/static-file-server.mjs";
import { writeTestWav } from "./fixtures/make-test-wav.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UTILS_REPO = path.resolve(REPO_ROOT, "..", "barktown-utils");
const EXPORT_SCRIPT = path.join(UTILS_REPO, "tools", "export_fragments.py");

const pythonCheck = spawnSync("python3", ["--version"]);
const available = pythonCheck.status === 0 && fs.existsSync(EXPORT_SCRIPT);
const skip = available
  ? false
  : "requires python3 and a sibling ../barktown-utils checkout with tools/export_fragments.py";

let tmpDir;
let seedDb;
let publicServer;
let privateServer;
let assetServer;
let trainingDataDir;
let cacheDir;
let annotationId;

before(async () => {
  if (!available) return;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-export-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const assetsDir = path.join(tmpDir, "assets");
  trainingDataDir = path.join(tmpDir, "training_data");
  cacheDir = path.join(tmpDir, "training_cache");

  await writeTestWav(path.join(assetsDir, "test.wav"), { durationSec: 2, sampleRate: 8000, freq: 440 });

  seedDb = openDb(dbPath);
  upsertSample(seedDb, {
    id: "sample-001",
    filename: "2026-01-01 12-00-00 SAMPLE bark.wav",
    audioPath: "test.wav",
    waveformPath: null,
    label: "bark",
    date: "2026-01-01",
    datetimeLocal: "2026-01-01T12:00:00",
    durationSec: 2,
  });

  publicServer = await startTestServer({ dbPath, mode: "public" });
  privateServer = await startTestServer({ dbPath, mode: "private" });
  assetServer = await startStaticServer(assetsDir);

  const res = await fetch(`${privateServer.baseUrl}/api/samples/sample-001/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startSec: 0.5, endSec: 1.0, label: "bark", source: "manual" }),
  });
  annotationId = (await res.json()).id;
});

after(async () => {
  if (!available) return;
  await Promise.all([publicServer.stop(), privateServer.stop()]);
  await assetServer.stop();
  seedDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runExport(extraArgs = []) {
  // Must be async (child_process.spawn), not spawnSync: the asset fixture
  // server (test/helpers/static-file-server.mjs) runs in this same Node
  // process, and spawnSync blocks the whole event loop until the child
  // exits -- which deadlocks here, since the Python subprocess can't get a
  // response from a server that can't run until the subprocess exits.
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [
      EXPORT_SCRIPT,
      "--ingest-base", publicServer.baseUrl,
      "--asset-base", assetServer.baseUrl,
      "--training-data", trainingDataDir,
      "--cache-dir", cacheDir,
      ...extraArgs,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`export_fragments.py exited ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

test("fresh export downloads the sample audio and slices the fragment", { skip }, async () => {
  const out = await runExport();
  assert.match(out, /exported=1 moved=0 unchanged=0 removed=0/);
  assert.ok(fs.existsSync(path.join(trainingDataDir, "bark", "sample-001_500-1000.wav")));
  assert.ok(fs.existsSync(path.join(cacheDir, "samples", "sample-001.wav")));
});

test("re-running with no changes is a no-op", { skip }, async () => {
  const out = await runExport();
  assert.match(out, /exported=0 moved=0 unchanged=1 removed=0/);
});

test("relabeling moves the exported file without re-downloading/re-slicing", { skip }, async () => {
  const patch = await fetch(`${privateServer.baseUrl}/api/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "yap" }),
  });
  assert.equal(patch.status, 200);

  const out = await runExport();
  assert.match(out, /exported=0 moved=1 unchanged=0 removed=0/);
  assert.ok(!fs.existsSync(path.join(trainingDataDir, "bark", "sample-001_500-1000.wav")));
  assert.ok(fs.existsSync(path.join(trainingDataDir, "yap", "sample-001_500-1000.wav")));
});

test("deleting the fragment removes its export and prunes the now-unreferenced cached sample", { skip }, async () => {
  const del = await fetch(`${privateServer.baseUrl}/api/annotations/${annotationId}`, { method: "DELETE" });
  assert.equal(del.status, 204);

  const out = await runExport();
  assert.match(out, /exported=0 moved=0 unchanged=0 removed=1/);
  assert.ok(!fs.existsSync(path.join(trainingDataDir, "yap", "sample-001_500-1000.wav")));
  assert.ok(!fs.existsSync(path.join(cacheDir, "samples", "sample-001.wav")));
});
