import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { buildConfig } from "../lib/config.mjs";
import { runReanalyzeScript } from "../lib/reanalyze.mjs";


test("default re-analysis ownership points to the sibling Goblin checkout", () => {
  const cfg = buildConfig();
  assert.match(cfg.reanalyze.scriptPath, /barktown-goblin\/tools\/analyze_wav\.py$/);
  assert.match(cfg.reanalyze.modelDir, /barktown-goblin\/models$/);
});

test("runReanalyzeScript passes one effective monitor settings snapshot", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-reanalyze-runner-test-"));
  const scriptPath = path.join(tmpDir, "fake-analyzer.mjs");
  fs.writeFileSync(scriptPath, `
    const args = process.argv.slice(2);
    const value = (name) => args[args.indexOf(name) + 1];
    const monitor = JSON.parse(value("--monitor-settings-json"));
    console.log(JSON.stringify({
      timestamps: [], confidences: [], loudnesses: [], padding_s: 0, window_s: 1.5,
      model_trained_at: "2026-08-12T13:32:07Z",
      analysis_settings: { classifier: { threshold: 0.42 }, monitor },
      analysis_trigger: "manual",
      input: value("--input"), model_dir: value("--model-dir")
    }));
  `);
  const monitorSettings = {
    candidate_threshold: 0.8,
    hit_refractory_s: 1.5,
    inference_window_s: 1.5,
    score_interval_s: 0.25,
    confirmation_hits: 4,
  };
  const cfg = {
    reanalyze: {
      pythonBin: process.execPath,
      scriptPath,
      modelDir: "/models",
      timeoutMs: 5000,
    },
  };

  try {
    const payload = await runReanalyzeScript(cfg, "/archive/source.wav", { monitorSettings });
    assert.equal(payload.input, "/archive/source.wav");
    assert.equal(payload.model_dir, "/models");
    assert.deepEqual(payload.analysis_settings.monitor, monitorSettings);
    assert.equal(payload.analysis_trigger, "manual");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runReanalyzeScript kills analyzers that exceed output limits", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-reanalyze-output-test-"));
  const scriptPath = path.join(tmpDir, "noisy-analyzer.mjs");
  fs.writeFileSync(scriptPath, `process.stdout.write("x".repeat(1024));`);
  const cfg = {
    reanalyze: {
      pythonBin: process.execPath,
      scriptPath,
      modelDir: "/models",
      timeoutMs: 5000,
      maxStdoutBytes: 32,
      maxStderrBytes: 32,
    },
  };

  try {
    await assert.rejects(
      runReanalyzeScript(cfg, "/archive/source.wav", { monitorSettings: {} }),
      /stdout exceeded 32 bytes/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
