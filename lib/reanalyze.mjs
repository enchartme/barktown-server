// lib/reanalyze.mjs — spawns barktown-utils' tools/reanalyze_clip.py against
// a local WAV file and parses its scored hit-metadata payload from stdout.
//
// Must use async spawn, not spawnSync: this runs inside the same Fastify
// process handling other requests, and spawnSync would block the whole
// event loop for as long as inference takes.

import { spawn } from "child_process";

/**
 * Run tools/reanalyze_clip.py --input <wavPath> --model-dir <modelDir> and
 * return its parsed JSON payload ({ timestamps, confidences, loudnesses,
 * padding_s, window_s }). Rejects if the script exits non-zero, times out,
 * or its stdout isn't valid JSON.
 *
 * `overrides` (all optional) let a caller (e.g. a per-request body from the
 * client) override the detection tuning in cfg.reanalyze for this one run:
 *   { candidateThreshold, hitRefractoryS, inferenceWindowS, scoreIntervalS }
 */
export function runReanalyzeScript(cfg, wavPath, overrides = {}) {
  const tuning = { ...cfg.reanalyze, ...overrides };
  const { pythonBin, scriptPath, modelDir, timeoutMs } = tuning;
  const args = [
    scriptPath,
    "--input", wavPath,
    "--model-dir", modelDir,
    "--candidate-threshold", String(tuning.candidateThreshold),
    "--hit-refractory-s", String(tuning.hitRefractoryS),
    "--inference-window-s", String(tuning.inferenceWindowS),
    "--score-interval-s", String(tuning.scoreIntervalS),
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`reanalyze_clip.py timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`reanalyze_clip.py exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      const lastLine = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(lastLine));
      } catch (e) {
        reject(new Error(`reanalyze_clip.py produced invalid JSON: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}
