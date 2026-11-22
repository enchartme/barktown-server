// Reanalysis transport: HTTP to the Goblin service when REANALYZE_URL is set;
// otherwise retain the local analyzer subprocess for development/legacy installs.
//
// Must use async spawn, not spawnSync: this runs inside the same Fastify
// process handling other requests, and spawnSync would block the whole
// event loop for as long as inference takes.

import { spawn } from "child_process";
import fs from "node:fs";

/**
 * Send a WAV to Goblin over HTTP, or use the legacy local analyzer when
 * REANALYZE_URL is unset. Return the parsed JSON payload ({ timestamps, confidences, loudnesses,
 * padding_s, window_s, optional multilabel_scores }). Rejects if the script exits non-zero, times out,
 * or its stdout isn't valid JSON.
 *
 * `tuning.monitorSettings` must already be fully resolved by the caller (server.mjs merges
 * the monitor_params DB defaults with any per-request body overrides —
 * see getMonitorParamsMap() in lib/db.mjs):
 *   { monitorSettings: { candidate_threshold, hit_refractory_s,
 *                        inference_window_s, score_interval_s } }
 *
 * workers controls independent window-scoring interpreters inside Goblin.
 */
export function runReanalyzeScript(cfg, wavPath, tuning, { workers = 1 } = {}) {
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new TypeError("re-analysis workers must be a positive integer");
  }
  if (cfg.reanalyze.url) return runHttpAnalysis(cfg.reanalyze, wavPath, tuning.monitorSettings, workers);
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
    "--workers", String(workers),
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


/** Stream a WAV to the independently deployed Goblin analyzer. */
async function runHttpAnalysis(config, wavPath, monitorSettings, workers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 330000);
  let stream;
  try {
    const stat = await fs.promises.stat(wavPath);
    stream = fs.createReadStream(wavPath);
    const response = await fetch(new URL("analyze", `${config.url.replace(/\/$/, "")}/`), {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: {
        "Content-Type": "audio/wav", "Content-Length": String(stat.size),
        "X-Barktown-Monitor-Settings": JSON.stringify(monitorSettings),
        "X-Barktown-Workers": String(workers),
      },
      body: stream, duplex: "half",
    });
    const limit = config.maxStdoutBytes ?? 2 * 1024 * 1024;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) {
        controller.abort();
        throw new Error(`Analyzer response exceeded ${limit} bytes`);
      }
      chunks.push(chunk);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error(`Analyzer returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Analyzer HTTP ${response.status}: ${typeof payload?.error === "string" ? payload.error : "request failed"}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      throw new Error(`Analyzer request timed out after ${config.timeoutMs ?? 330000}ms`);
    }
    if (error.cause) {
      // Undici puts DNS, socket and upload errors in cause, while its public
      // message is only "fetch failed". Preserve the actionable cause in the
      // existing API/UI error instead of hiding it in a server-only stack.
      const causes = Array.isArray(error.cause.errors) ? error.cause.errors : [error.cause];
      const details = causes.map(cause => [cause.code, cause.message].filter(Boolean).join(": ")).join("; ");
      throw new Error(`Analyzer request failed: ${details.slice(0, 500) || error.message}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    stream?.destroy();
  }
}
