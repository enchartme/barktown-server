// test/helpers/test-server.mjs — spawns either real API entry point as a child
// process against a throwaway SQLite DB, so tests exercise the actual Fastify
// app + CORS config + route boundary (no mocking).

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { getFreePort } from "./free-port.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Start one API process against `dbPath`, waiting for it to answer /health.
 * Returns { baseUrl, stop }.
 */
export async function startTestServer({ dbPath, mode = "public", env = {} }) {
  if (mode !== "public" && mode !== "private") {
    throw new Error(`unknown test API mode: ${mode}`);
  }
  const port = await getFreePort();
  const entryPoint = mode === "public" ? "server.mjs" : "server-private.mjs";
  const portVariable = mode === "public" ? "PUBLIC_API_PORT" : "PRIVATE_API_PORT";
  const hostVariable = mode === "public" ? "PUBLIC_API_HOST" : "PRIVATE_API_HOST";
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, entryPoint)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      [hostVariable]: "127.0.0.1",
      [portVariable]: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const exitedEarly = new Promise((_resolve, reject) => {
    proc.once("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`${entryPoint} exited early (code ${code}):\n${stderr}`));
      }
    });
  });

  await Promise.race([waitForHealth(baseUrl), exitedEarly]);

  return {
    baseUrl,
    mode,
    stop: () => stopServer(proc),
  };
}

async function waitForHealth(baseUrl, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`API server did not become healthy within ${timeoutMs}ms`);
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
  });
}
