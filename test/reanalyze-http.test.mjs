import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runReanalyzeScript } from "../lib/reanalyze.mjs";

const monitorSettings = { candidate_threshold: .95, hit_refractory_s: 1.5, inference_window_s: 1.5, score_interval_s: .25 };

async function fixture(t, handler) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "barktown-http-analyzer-"));
  const wav = path.join(tmp, "source.wav");
  fs.writeFileSync(wav, Buffer.from("RIFF----WAVE-test-audio"));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { wav, cfg: { reanalyze: { url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 } } };
}

test("HTTP analyzer receives streamed WAV and settings; richer result is preserved", async t => {
  const result = { timestamps: [1.5], confidences: [.99], loudnesses: [1], multilabel_scores: [{ bark: .4, wildlife: .98 }], analysis_trigger: "manual" };
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.url, "/analyze");
    assert.equal(req.headers["content-type"], "audio/wav");
    assert.equal(req.headers["x-barktown-workers"], "1");
    assert.deepEqual(JSON.parse(req.headers["x-barktown-monitor-settings"]), monitorSettings);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(f.wav));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  assert.deepEqual(await runReanalyzeScript(f.cfg, f.wav, { monitorSettings }), result);
});

test("HTTP analyzer errors are surfaced without falling back to a local subprocess", async t => {
  const f = await fixture(t, async (req, res) => {
    for await (const chunk of req) { /* drain request */ }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Analyzer is busy" }));
  });
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }), /HTTP 503: Analyzer is busy/);
});

test("HTTP analyzer enforces timeout", async t => {
  const f = await fixture(t, () => {});
  f.cfg.reanalyze.timeoutMs = 30;
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }), /timed out after 30ms/);
});

test('historical HTTP replay sends the mode and uses its independent timeout', async t => {
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.headers['x-barktown-analysis-mode'], 'replay');
    for await (const _chunk of req) { /* drain */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    res.end(JSON.stringify({ timestamps: [] }));
  });
  f.cfg.reanalyze.timeoutMs = 1;
  f.cfg.reanalyze.replayTimeoutMs = 1000;
  assert.deepEqual(await runReanalyzeScript(f.cfg, f.wav, { monitorSettings }, { mode: 'replay' }), { timestamps: [] });
  f.cfg.reanalyze.replayTimeoutMs = 10;
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }, { mode: 'replay' }), /timed out after 10ms/);
});

test("HTTP analyzer rejects invalid or excessive response bodies", async t => {
  let body = "not-json";
  const f = await fixture(t, async (req, res) => {
    for await (const chunk of req) { /* drain request */ }
    res.end(body);
  });
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }), /invalid JSON/);
  body = JSON.stringify({ large: "x".repeat(1000) });
  f.cfg.reanalyze.maxStdoutBytes = 32;
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }), /exceeded 32 bytes/);
});


test("HTTP analyzer socket failures expose the underlying cause", async t => {
  const f = await fixture(t, req => req.socket.destroy());
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }),
    /Analyzer request failed: (UND_ERR_SOCKET|ECONNRESET)/);
});

test("HTTP analyzer preserves aggregate connection errors", async t => {
  const f = await fixture(t, () => {});
  const createReadStream = fs.createReadStream;
  let upload;
  t.mock.method(fs, "createReadStream", (...args) => {
    upload = createReadStream(...args);
    return upload;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", { cause: new AggregateError([
      Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
    ]) });
  });
  await assert.rejects(runReanalyzeScript(f.cfg, f.wav, { monitorSettings }),
    /ECONNREFUSED: connect refused; ENETUNREACH: network unreachable/);
  assert.equal(upload.closed, true, "upload must close before the caller can delete its WAV");
});
