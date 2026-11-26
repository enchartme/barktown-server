import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

test('historical CLI dry run is read-only and real runs await each background job before posting the next', async t => {
  let current = null;
  let polls = 0;
  let fail = false;
  const posts = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/diary') {
      res.end(JSON.stringify([
        { id: 'later', date: '2023-05-02', reanalyzable: true, reanalysisMode: 'historical' },
        { id: 'earlier', date: '2023-05-01', reanalyzable: true, reanalysisMode: 'historical' },
        { id: 'converted', date: '2023-05-01', reanalyzable: true, reanalysisMode: 'windows', sourceRecording: { type: 'historical' } },
      ])); return;
    }
    if (req.method === 'POST') {
      assert.equal(current, null, 'previous job must finish before the next POST');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(chunks).toString()).uploadMinScore, 0);
      const recordId = decodeURIComponent(url.pathname.split('/')[3]);
      posts.push(recordId);
      polls = 0;
      current = { id: `job-${posts.length}`, instanceId: 'server', recordId, kind: 'historical', active: true, completed: 0 };
      res.writeHead(202); res.end(JSON.stringify(current)); return;
    }
    if (url.pathname === '/api/reanalysis') {
      polls++;
      if (polls === 1) { res.end(JSON.stringify({ ...current, stage: 'analyzing' })); return; }
      const done = { ...current, active: false, completed: 1, failed: fail ? 1 : 0,
        replacementIds: ['event-one', 'event-two'], errors: fail ? [{ error: 'Scoring failed' }] : [] };
      current = null;
      res.end(JSON.stringify(done)); return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, BULK_REANALYZE_PUBLIC_API_URL: base, BULK_REANALYZE_PRIVATE_API_URL: base };
  const args = ['bulk-reanalyze.mjs', '--historical', '--start-date', '2023-05-01', '--end-date', '2023-05-02',
    '--upload-min-score', '0'];
  const cwd = new URL('..', import.meta.url);
  const preview = await execute(process.execPath, [...args, '--dry-run'], { cwd, env });
  assert.match(preview.stdout, /WOULD RUN earlier/);
  assert.doesNotMatch(preview.stdout, /WOULD RUN converted/);
  assert.deepEqual(posts, []);
  const run = await execute(process.execPath, args, { cwd, env });
  assert.deepEqual(posts, ['earlier', 'later']);
  assert.match(run.stdout, /2 event clip\(s\)/);
  assert.match(run.stdout, /2 succeeded, 0 failed/);
  posts.length = 0; fail = true;
  await assert.rejects(execute(process.execPath, args, { cwd, env }), error => {
    assert.match(error.stderr, /Scoring failed/);
    assert.match(error.stderr, /1 recording\(s\) not started/);
    return error.code === 1;
  });
  assert.deepEqual(posts, ['earlier']);
});

test("bulk CLI filters the requested day and serializes recordings despite legacy worker settings", async t => {
  const selected = [];
  let active = 0;
  let peakActive = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/diary") {
      assert.equal(url.searchParams.get("startDate"), "2026-11-12");
      assert.equal(url.searchParams.get("endDate"), "2026-11-12");
      res.end(JSON.stringify([
        { id: "a", date: "2026-11-12", reanalyzable: true },
        { id: "b", date: "2026-11-12", reanalyzable: true },
        { id: "missing", date: "2026-11-12", reanalyzable: false },
      ]));
      return;
    }
    if (req.method === "POST" && /^\/api\/diary\/[ab]\/reanalyze$/.test(url.pathname)) {
      assert.equal(req.headers["x-barktown-reanalysis-mode"], "bulk");
      selected.push(url.pathname);
      for await (const chunk of req) { /* drain request */ }
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      res.end(JSON.stringify({ timestamps: [1.5] }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { stdout } = await execute(process.execPath, ["bulk-reanalyze.mjs", "2026-11-12"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BULK_REANALYZE_PUBLIC_API_URL: base, BULK_REANALYZE_PRIVATE_API_URL: base,
      REANALYZE_CONCURRENCY: "8", BULK_REANALYZE_CONCURRENCY: "4" },
  });
  assert.equal(peakActive, 1);
  assert.deepEqual(selected, ["/api/diary/a/reanalyze", "/api/diary/b/reanalyze"]);
  assert.match(stdout, /Concurrent recordings: 1/);
  assert.match(stdout, /2 succeeded, 0 failed, 1 unavailable/);
});
