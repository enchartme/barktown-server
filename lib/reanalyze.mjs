// lib/reanalyze.mjs — spawns barktown-goblin's tools/analyze_wav.py against
// a local WAV file and parses its scored hit-metadata payload from stdout.
//
// Must use async spawn, not spawnSync: this runs inside the same Fastify
// process handling other requests, and spawnSync would block the whole
// event loop for as long as inference takes.

import { spawn } from "child_process";

/**
 * Run tools/analyze_wav.py --input <wavPath> --model-dir <modelDir> and
 * return its parsed JSON payload ({ timestamps, confidences, loudnesses,
 * padding_s, window_s }). Rejects if the script exits non-zero, times out,
 * or its stdout isn't valid JSON.
 *
 * `tuning.monitorSettings` must already be fully resolved by the caller (server.mjs merges
 * the monitor_params DB defaults with any per-request body overrides —
 * see getMonitorParamsMap() in lib/db.mjs):
 *   { monitorSettings: { candidate_threshold, hit_refractory_s,
 *                        inference_window_s, score_interval_s } }
 */
export function runReanalyzeScript(cfg, wavPath, tuning) {
  const {
    pythonBin,
    scriptPath,
    modelDir,
    timeoutMs,
    maxStdoutBytes = 2 * 1024 * 1024,
    maxStderrBytes = 128 * 1024,
  } = cfg.reanalyze;
  const args = [
    scriptPath,
    "--input", wavPath,
    "--model-dir", modelDir,
    "--monitor-settings-json", JSON.stringify(tuning.monitorSettings),
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const rejectOnce = (error, { kill = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) proc.kill("SIGKILL");
      reject(error);
    };

    const capture = (name, chunks, chunk, currentBytes, limit) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > limit) {
        rejectOnce(new Error(`analyze_wav.py ${name} exceeded ${limit} bytes`), { kill: true });
        return currentBytes;
      }
      chunks.push(Buffer.from(chunk));
      return nextBytes;
    };

    const timer = setTimeout(() => {
      rejectOnce(new Error(`analyze_wav.py timed out after ${timeoutMs}ms`), { kill: true });
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdoutBytes = capture("stdout", stdoutChunks, chunk, stdoutBytes, maxStdoutBytes);
    });
    proc.stderr.on("data", (chunk) => {
      stderrBytes = capture("stderr", stderrChunks, chunk, stderrBytes, maxStderrBytes);
    });
    proc.once("error", (e) => {
      rejectOnce(e);
    });
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`analyze_wav.py exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      const lastLine = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(lastLine));
      } catch (e) {
        reject(new Error(`analyze_wav.py produced invalid JSON: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}
