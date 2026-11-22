import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

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
      REANALYZE_CONCURRENCY: "8", BULK_REANALYZE_CONCURRENCY: "1" },
  });
  assert.equal(peakActive, 1);
  assert.deepEqual(selected, ["/api/diary/a/reanalyze", "/api/diary/b/reanalyze"]);
  assert.match(stdout, /Concurrent recordings: 1/);
  assert.match(stdout, /2 succeeded, 0 failed, 1 unavailable/);
});
