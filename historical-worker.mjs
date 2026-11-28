#!/usr/bin/env node
/** Prepare historical recordings on a workstation; the Pi verifies and commits. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { buildConfig } from './lib/config.mjs';
import { parseBulkReanalyzeArgs, selectReanalyzableEntries } from './lib/bulk-reanalyze.mjs';
import { createClient, download, upload } from './lib/minio.mjs';
import { runAudioCommand } from './lib/audio.mjs';
import { runReanalyzeScript } from './lib/reanalyze.mjs';
import { planHistoricalClips } from './lib/historical-recordings.mjs';
import { decodeHistoricalSource, createHistoricalClipMedia, historicalStagingFiles } from './lib/historical-media.mjs';
import { mountedObjectPath as mountPath, copyMountedHistoricalSource, writeMountedHistoricalFile, commitWhenStagedFilesVisible } from './lib/historical-worker-files.mjs';

loadEnv(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}
function requestJson(url, { body, timeoutMs = 30000 } = {}) {
  // Native HTTP also supports long verification without Undici's header timeout.
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('API URL must use HTTP or HTTPS');
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method: data ? 'POST' : 'GET', signal: AbortSignal.timeout(timeoutMs),
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, async response => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 40 * 1024 * 1024) throw new Error('API response exceeded 40 MiB');
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw Object.assign(new Error(payload.message ?? payload.error ?? `HTTP ${response.statusCode}`), { statusCode: response.statusCode });
        }
        resolve(payload);
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on('error', reject);
    request.end(data);
  });
}
function parseArgs(args) {
  const options = {
    apiBase: process.env.HISTORICAL_WORKER_API_URL ?? 'https://barktown-private.tail523149.ts.net',
    publicApiBase: process.env.BULK_REANALYZE_PUBLIC_API_URL ?? 'https://barktown-api.enchart.me',
    bucketRoot: process.env.HISTORICAL_BUCKET_ROOT,
    workers: 3,
  };
  const names = { '--api-base': 'apiBase', '--public-api-base': 'publicApiBase',
    '--bucket-root': 'bucketRoot', '--state-file': 'stateFile', '--workers': 'workers' };
  const remaining = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--retry-review') { options.retryReview = true; continue; }
    const name = names[args[index]];
    if (!name) { remaining.push(args[index]); continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${args[index - 1]} requires a value`);
    options[name] = name === 'workers' ? Number(value) : value;
  }
  if (!Number.isSafeInteger(options.workers) || options.workers < 1) throw new Error('--workers must be a positive integer');
  const selection = parseBulkReanalyzeArgs([...remaining, '--historical']);
  options.apiBase = options.apiBase.replace(/\/$/, '');
  options.publicApiBase = options.publicApiBase.replace(/\/$/, '');
  options.stateFile = path.resolve(options.stateFile ?? path.join(root, 'data',
    `historical-worker-${selection.startDate}-${selection.endDate}.json`));
  if (options.bucketRoot) options.bucketRoot = path.resolve(options.bucketRoot);
  return { ...options, selection };
}
function reportCompletion(state, stateFile) {
  console.log(`Done: ${state.completed.length} historical source(s) committed.`);
  if (state.needsReview.length) {
    console.warn(`REVIEW: ${state.needsReview.length} recording(s) require review. Details: ${stateFile}`);
    console.warn('After resolving conflicts, rerun with --retry-review to retry those recordings.');
    process.exitCode = 1;
  }
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: npm run historical-worker -- YYYY-MM-DD [options]
   or: npm run historical-worker -- --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]
Options: --threshold N; --refractory SECONDS; --window SECONDS; --step SECONDS
         --upload-min-score N|any (any = 0; default from Pi monitor settings)
         --workers N (default 3); --bucket-root PATH (otherwise use MinIO API)
         --state-file PATH; --api-base URL; --public-api-base URL; --dry-run
         --retry-review (retry recordings previously deferred for event conflicts)
Run on the workstation. The Pi validates staged files and commits database changes.
Rerun the same command and state file to resume.`);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const { selection, stateFile, apiBase, publicApiBase, bucketRoot, workers } = options;
  const parameters = { apiBase, publicApiBase, startDate: selection.startDate,
    endDate: selection.endDate, tuning: selection.tuning };
  let state = await readJson(stateFile);
  if (state && !isDeepStrictEqual(state.parameters, parameters)) throw new Error('State file belongs to different dates, API or tuning');
  if (selection.dryRun || !state) {
    const diary = await requestJson(`${publicApiBase}/api/diary?${new URLSearchParams({
      startDate: selection.startDate, endDate: selection.endDate,
    })}`);
    const entries = selectReanalyzableEntries(diary, selection.startDate, selection.endDate, { historical: true })
      .sort((left, right) => left.datetimeLocal.localeCompare(right.datetimeLocal) || left.id.localeCompare(right.id));
    if (selection.dryRun) {
      for (const entry of entries) console.log(`WOULD RUN ${entry.id} — ${entry.filename}`);
      console.log(`Dry run: ${entries.length} historical source(s); no tickets, files or database changes.`);
      return;
    }
    state = { version: 1, parameters, entries, completed: [], current: null };
  }
  state.needsReview ??= [];
  if (state.completed.length === state.entries.length) { console.log('Done: all recordings in this checkpoint are complete.'); return; }
  if (!options.retryReview && state.completed.length + state.needsReview.length === state.entries.length) {
    reportCompletion(state, stateFile); return;
  }
  const cfg = buildConfig();
  // This command always scores locally, even when .env points at the Pi analyzer.
  cfg.reanalyze.url = null;
  cfg.reanalyze.modelDir = process.env.REANALYZE_MODEL_DIR ?? path.resolve(root, '../barktown-goblin/models/analyzer');
  for (const [setting, variable, candidates] of [
    ['ffmpegBin', 'FFMPEG_BIN', ['../barktown-ui/.bin/ffmpeg', '../barktown-utils/.venv/bin/ffmpeg']],
    ['ffprobeBin', 'FFPROBE_BIN', ['../barktown-ui/.bin/ffprobe']],
  ]) {
    if (process.env[variable]) continue;
    for (const candidate of candidates) {
      try { await fs.access(path.resolve(root, candidate)); cfg[setting] = path.resolve(root, candidate); break; }
      catch { /* retain the PATH default when no shared binary exists */ }
    }
  }
  if (!process.env.REANALYZE_PYTHON_BIN) {
    for (const candidate of ['../barktown-goblin/.venv/bin/python', '../barktown-utils/.venv/bin/python']) {
      try { await fs.access(path.resolve(root, candidate)); cfg.reanalyze.pythonBin = path.resolve(root, candidate); break; }
      catch { /* try the next shared environment */ }
    }
  }
  for (const [binary, argument] of [[cfg.ffmpegBin, '-version'], [cfg.ffprobeBin, '-version'],
    [cfg.audiowaveformBin, '--version'], [cfg.reanalyze.pythonBin, '--version']]) {
    try { await runAudioCommand(binary, [argument], { timeoutMs: 15000 }); }
    catch (error) { throw new Error(`Local prerequisite failed (${binary}): ${error.message}`); }
  }
  if (bucketRoot && !(await fs.stat(bucketRoot)).isDirectory()) throw new Error('--bucket-root must be the mounted bucket directory');
  const mc = bucketRoot ? null : createClient(cfg.minio);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const lockPath = `${stateFile}.lock`;
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(String(process.pid)); await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid worker lock: ${lockPath}`);
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      await fs.unlink(lockPath);
      // Start again with the durable state and an exclusive lock.
      return main();
    }
    throw new Error(`This checkpoint is already running as PID ${pid}`);
  }
  try {
    await writeJson(stateFile, state);
    const queue = [...state.entries.entries()];
    // Finish an interrupted ticket before retrying any earlier review items.
    const currentIndex = queue.findIndex(([, entry]) => entry.id === state.current?.entryId);
    if (currentIndex > 0) queue.unshift(...queue.splice(currentIndex, 1));
    for (const [entryIndex, entry] of queue) {
      if (state.completed.includes(entry.id)) continue;
      if (!options.retryReview && state.needsReview.some(item => item.entryId === entry.id)) continue;
      if (state.current && state.current.entryId !== entry.id) throw new Error('Checkpoint current recording does not match its queue');
      state.current ??= { entryId: entry.id,
        requestId: state.needsReview.find(item => item.entryId === entry.id)?.requestId ?? randomUUID() };
      await writeJson(stateFile, state);
      const id = state.current.requestId;
      const work = `${stateFile}.files/${id}`;
      await fs.mkdir(work, { recursive: true });
      console.log(`START ${entryIndex + 1}/${state.entries.length} ${entry.id} — ${workers} local worker(s)`);
      try {
        let ticket;
        try { ticket = await requestJson(`${apiBase}/api/historical-imports/${id}`); }
        catch (error) { if (error.statusCode !== 404) throw error; }
        ticket ??= await requestJson(`${apiBase}/api/diary/${encodeURIComponent(entry.id)}/historical-import`, {
          body: { ...selection.tuning, requestId: id }, timeoutMs: 120000,
        });
        let manifest = await readJson(path.join(work, 'manifest.json'));
        if (!manifest && !ticket.result && ticket.entry.kind !== 'note') {
          const input = path.join(work, path.posix.basename(ticket.archiveKey));
          const wav = path.join(work, 'source.wav');
          let analysis = await readJson(path.join(work, 'analysis.json'));
          if (!analysis) {
            console.log(`READ  ${ticket.archiveKey}`);
            if (bucketRoot) {
              const readKey = await copyMountedHistoricalSource({ bucketRoot, ticket, destination: input,
                onWait: message => console.log(`WAIT  ${message}`) });
              if (readKey !== ticket.archiveKey) console.log(`READ  ${readKey} — archive not visible in mount; Pi will verify its checksum`);
            } else await download(mc, cfg.bucket, ticket.archiveKey, input);
            const sourceSha256 = await hashFile(input);
            console.log('DECODE on Mac');
            const durationSec = await decodeHistoricalSource(cfg, input, wav);
            console.log('SCORE on Mac');
            const payload = await runReanalyzeScript(cfg, wav,
              { monitorSettings: ticket.monitorSettings }, { workers, mode: 'replay' });
            analysis = { payload, durationSec, sourceSha256 };
            await writeJson(path.join(work, 'analysis.json'), analysis);
          }
          const clips = planHistoricalClips(ticket.entry, ticket.mediaConfig, analysis.payload,
            analysis.durationSec, ticket.monitorSettings);
          const planned = historicalStagingFiles(id, clips);
          const files = [];
          for (const [index, clip] of clips.entries()) {
            console.log(`STAGE ${index + 1}/${clips.length} ${clip.filename}`);
            const media = await createHistoricalClipMedia({ cfg: { ...cfg, ...ticket.mediaConfig },
              clip, entry: ticket.entry, archiveKey: ticket.archiveKey, wav, directory: work });
            for (const [offset, file] of media.entries()) {
              const descriptor = planned[index * 3 + offset];
              const size = (await fs.stat(file.path)).size;
              const sha256 = await hashFile(file.path);
              if (bucketRoot) {
                const destination = mountPath(bucketRoot, descriptor.stagingKey);
                await writeMountedHistoricalFile(file.path, destination, {
                  onWait: message => console.log(`WAIT  ${message}`),
                });
              } else await upload(mc, cfg.bucket, file.path, descriptor.stagingKey, file.contentType);
              files.push({ key: descriptor.key, stagingKey: descriptor.stagingKey, size, sha256 });
            }
          }
          manifest = { ...analysis, files };
          await writeJson(path.join(work, 'manifest.json'), manifest);
        }
        console.log('VERIFY and COMMIT on Pi');
        const commit = () => requestJson(`${apiBase}/api/historical-imports/${id}/commit`, {
          body: manifest ?? {}, timeoutMs: cfg.reanalyze.replayTimeoutMs,
        });
        const result = ticket.result ?? (bucketRoot
          ? await commitWhenStagedFilesVisible(commit, { onWait: message => console.log(`WAIT  ${message}`) })
          : await commit());
        state.completed.push(entry.id); state.current = null;
        state.needsReview = state.needsReview.filter(item => item.entryId !== entry.id);
        await writeJson(stateFile, state);
        console.log(`OK    ${entry.id} — ${result.replacementIds.length} event clip(s)`);
        if (result.message) console.log(`NOTE  ${result.message}`);
        for (const warning of result.cleanupWarnings ?? []) console.warn(warning);
        await fs.rm(work, { recursive: true, force: true });
      } catch (error) {
        // Conflicts belong to this source, not the rest of the batch. Keep its
        // ticket, analysis and staged files available for a deliberate retry.
        if (!/^(Diary event already exists:|Event object already exists:|Historical event filenames collide$)/.test(error.message)) throw error;
        state.needsReview = state.needsReview.filter(item => item.entryId !== entry.id);
        state.needsReview.push({ entryId: entry.id, filename: entry.filename,
          requestId: id, error: error.message, workDirectory: work, recordedAt: new Date().toISOString() });
        state.current = null;
        await writeJson(stateFile, state);
        console.warn(`REVIEW ${entry.id} — ${error.message}; continuing with the next recording.`);
      }
    }
    reportCompletion(state, stateFile);
  } finally { await fs.rm(lockPath, { force: true }); }
}

main().catch(error => { console.error(`STOP: ${error.message}\nRerun the same command to resume from its checkpoint.`); process.exitCode = 1; });
