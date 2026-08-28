# barktown-server

Pi-side ingest and API services for **barktown**. The ingest service watches the `upload-here/` prefix in a MinIO bucket, validates filenames, and routes diary recordings and manual training samples through separate incremental pipelines.

---

## How it works

1. Diary audio and Goblin's manual `.wav` samples are uploaded to `<bucket>/upload-here/`
2. The service polls that prefix every 20 s
3. Once a file's size and ETag have been stable for 30 s (upload complete), it is processed:
   - Diary filenames are validated against `YYYY-MM-DD HH-MM-SS optional comment.ext`
   - Invalid names are left in `upload-here/` untouched — rename and re-upload
   - `ffprobe` reads the duration
   - `audiowaveform` generates peak data (skipped for clips < 5 s)
   - Waveform JSON is uploaded to `waveforms/YYYY/MM/<id>.json`
   - Audio is copied to `audio/YYYY/MM/<filename>` then removed from `upload-here/`
   - `index.json` is updated (appended + sorted)

Manual Goblin recordings use `YYYY-MM-DD HH-MM-SS SAMPLE <label>.wav`. The
`SAMPLE` marker routes each file to an incremental training-sample ingest:

- the WAV moves to `training-samples/<label>/`
- its waveform is generated under `training-samples-waveforms/<label>/`
- only that sample's SQLite row is upserted
- the transient `upload-here/` object is removed after successful publication

The ingest service watches only `upload-here/`. The durable
`training-samples/` and `training-samples-waveforms/` prefixes are outputs,
never ingest queues, so existing samples cannot be rebuilt by a poll cycle.

Training-sample metadata lives in `data/barktown.db` (see `lib/db.mjs`). The
small `training-samples-index.json` compatibility view is regenerated from
SQLite after an update so existing clients can continue fetching it.

Shared code (MinIO helpers, audio helpers, filename parsing) lives in `lib/`
and is used by both `ingest-service.mjs` and the maintenance scripts.

---

## Prerequisites

```bash
# ffmpeg / ffprobe
sudo apt update && sudo apt install ffmpeg

# audiowaveform — grab the pre-built arm64 .deb from GitHub releases:
VER=1.10.1
wget https://github.com/bbc/audiowaveform/releases/download/${VER}/audiowaveform_${VER}-1-12_arm64.deb
sudo apt install ./audiowaveform_${VER}-1-12_arm64.deb

# Node.js >= 18 (already installed)
```

---

## Install

```bash
git clone <this-repo> ~/barktown-server
cd ~/barktown-server
npm install
```

---

## Configuration

All settings are environment variables:

| Variable | Default | Description |
|---|---|---|
| `MINIO_ENDPOINT` | `localhost` | MinIO host |
| `MINIO_PORT` | `9000` | MinIO port |
| `MINIO_USE_SSL` | `false` | Use HTTPS |
| `MINIO_ACCESS_KEY` | `minioadmin` | Access key |
| `MINIO_SECRET_KEY` | `minioadmin` | Secret key |
| `MINIO_BUCKET` | `barktown` | Bucket name |
| `POLL_INTERVAL_MS` | `20000` | How often to scan `upload-here/` (ms) |
| `STABILITY_DELAY_MS` | `30000` | Idle time before processing a file (ms) |
| `FFPROBE_BIN` | `ffprobe` | Path to ffprobe binary |
| `AUDIOWAVEFORM_BIN` | `audiowaveform` | Path to audiowaveform binary |
| `WAVEFORM_THRESHOLD_SEC` | `5` | Min duration to generate a waveform |
| `DB_PATH` | `./data/barktown.db` | Local SQLite metadata store for training samples |

---

## Training samples database

Training-sample metadata (uploaded by barktown-goblin) is stored in a local
SQLite database rather than only in `training-samples-index.json`. This
gives the ingest service transactional, queryable storage as a foundation
for upcoming CRUD features (delete, rename/move, fragment annotations).

If you already have a `training-samples-index.json` in the bucket from
before this database existed, import it once:

```bash
node migrate-samples-to-sqlite.mjs
# or
npm run migrate-samples-to-sqlite
```

This is idempotent — safe to re-run any time. `training-samples-index.json`
in the bucket continues to be regenerated from the database on every
update, so the existing barktown client keeps working unchanged.

Pending guarded one-time operations live under `migrations/`; completed
operations and their tests are retained under `archive/`. The current
auto-detection canonical-name migration is documented in
`migrations/auto-detection-canonical-names/README.md`.

---

## API servers

The HTTP interface is split across two Fastify/Node processes backed by the
same local SQLite database. `server.mjs` is an anonymous, read-only API suitable
for publishing through Cloudflare Tunnel. `server-private.mjs` owns every
mutation plus operator-only reads and must remain reachable only over the
trusted Tailscale network.

There is no duplicated business route between the processes. The public API
opens SQLite with `readonly` and `query_only`; the private API and
`ingest-service.mjs` are the possible writers. SQLite WAL mode plus a busy
timeout safely support these readers/writers when all processes use the same
local filesystem.

```bash
# Public read API (127.0.0.1:8091)
node server.mjs
npm run server

# Private mutation/operator API (127.0.0.1:8090)
node server-private.mjs
npm run server:private
```

### Public API (`barktown-api`)

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check |
| `GET /api/recording-context` | Return the public album, location, microphone direction and copyright used in report descriptions |
| `GET /api/diary` | List diary entries with a live `reanalyzable` indication; optionally filter inclusively with `startDate`/`endDate` |
| `GET /api/diary/latest-date` | Return the newest available diary date without loading diary entries |
| `GET /api/diary-summary` | Return records, trimmed disturbed time and bark counts for every day and the totals in an inclusive `startDate`/`endDate` period |
| `GET /api/diary/:id` | Get one diary entry with a live `reanalyzable` indication |
| `GET /api/hit-metadata` | Bulk hit metadata, optionally filtered by inclusive `startDate`/`endDate`; 1-based `page`, max `pageSize` 1000 |
| `GET /api/diary/:id/hit-metadata` | Get hit metadata and analysis provenance for one clip |
| `GET /api/samples` | List active training samples (`?label=bark` to filter) |
| `GET /api/samples/:id` | Get one sample |
| `GET /api/samples/:id/annotations` | List fragment annotations for a sample |
| `GET /api/annotations` | List every annotation across all samples in one request (includes each annotation's sample `audioPath`/`durationSec`) — for laptop-side training export tooling |

Public responses send `Cache-Control: no-store`; filtering and freshness come
from live database queries rather than an independently cached data dump.
Diary entries include an `annotations` array containing only whole-recording
notes. Linked recordings expose their sample-wide `0..0` note annotations;
unlinked recordings expose the equivalent diary-scoped notes.

### Private API (`barktown-api-private`)

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check |
| `GET /api/monitor-params` | List Goblin monitor parameters |
| `PUT /api/diary/:id/comment` | Add or replace the whole-recording note, using the linked sample annotation when available |
| `PATCH /api/diary/:id/trim` | Persist or clear non-destructive `trimStartMs`/`trimStopMs` playback bounds |
| `PATCH /api/monitor-params/:paramId` | Update one monitor parameter |
| `POST /api/diary/:id/hit-metadata` | Upsert hit metadata produced automatically by Goblin |
| `POST /api/diary/:id/reanalyze` | Reclassify the available source WAV and store the result |
| `DELETE /api/diary/:id` | Delete a diary entry |
| `POST /api/diary/:id/move-to-samples` | Publish a diary recording and waveform as a training sample |
| `POST /api/samples/:id/regenerate-waveform` | Regenerate a training-sample waveform |
| `DELETE /api/samples/:id` | Delete a sample (MinIO objects + DB row) |
| `PATCH /api/samples/:id` | Rename/move a sample to a different label (`{"label":"bark"}`) |
| `POST /api/samples/:id/annotations` | Add a fragment annotation (`{startSec, endSec, label, source?}`) |
| `PATCH /api/annotations/:id` | Update a fragment annotation (partial body) |
| `DELETE /api/annotations/:id` | Delete a fragment annotation |

Bulk hit-metadata responses contain `items`, pagination fields including
`hasNextPage`, `isLastPage`, and `complete`, plus `links.next`/`links.previous`.
The same navigation links are advertised in the HTTP `Link` header. Date bounds
use the linked diary recording's `YYYY-MM-DD` date; without bounds, orphaned
metadata that has not yet acquired a diary row is included as well.
Each record also exposes `modelTrainedAt`, `analysisSettings`, and
`analysisTrigger`. `analysisSettings` contains the classifier identity and the
settings actually applied during that run. Existing records
migrate with an unknown model timestamp, empty settings, and an `automatic`
trigger.

Diary responses include a live `reanalyzable` boolean. It is true only when a
source WAV currently exists in MinIO: either the diary entry's archived WAV or
a WAV belonging to its linked training sample. New WAV ingests retain the
archive path and ETag in SQLite; legacy normalized archive-name candidates are
also checked. If a source is later cleaned from disk, the next diary response
turns the indication off and the client disables the re-analysis button.

Diary audio is never rewritten by trimming. SQLite stores nullable
`trim_start_ms`/`trim_stop_ms` bounds and public diary responses expose their
camel-case equivalents. A successful manual or bulk re-analysis scores the
complete archived source, then sets the visible range from 1.5 seconds before
the first newly identified bark to 1.5 seconds after the last. The range is
clamped to the source duration; a result with no barks remains untrimmed.

Manual re-analysis is deterministic window reclassification, not replay of
Goblin's callback-aligned live event state machine. It applies and records only
`candidate_threshold`, `hit_refractory_s`, `inference_window_s`, and
`score_interval_s`. Confirmation, silence-gap, cooldown, and event assembly do
not participate.

The API permits four re-analysis operations at a time by default. Additional
records wait in FIFO order; another request for a record that is already queued
or running returns `409`. Each operation uses a unique temporary directory, and
analyzer stdout/stderr are capped as well as timed out.

### Bulk re-analysis by date

Run the server-local CLI with exactly one real calendar date. It loads the
current diary, selects only entries on that date whose source WAV is currently
available, and submits them through a bounded worker pool:

```bash
cd ~/git/enchartme/barktown-server
npm run bulk-reanalyze -- 2026-08-12
```

The required `YYYY-MM-DD` argument deliberately limits each invocation to one
day. The CLI prints a `START` line as each worker takes a record, an `OK` or
`FAIL` line as it completes, and a final succeeded/failed/unavailable summary.
A failed recording does not stop the rest of the date. Entries without a
discoverable archive or linked training WAV are counted as unavailable and are
not submitted.

The CLI reads the diary from `http://127.0.0.1:$PUBLIC_API_PORT` and submits work to
`http://127.0.0.1:$PRIVATE_API_PORT`. It uses the same
`REANALYZE_CONCURRENCY` value as the private API. Set the two
`BULK_REANALYZE_*_API_URL` variables only when either API is at another
address. Changing `REANALYZE_CONCURRENCY` requires a
`barktown-api-private` restart; on the four-CPU server the default of four
gives one Python analyzer process per worker.

For the server-side Python environment, TFLite runtime, model bundle, systemd
wiring, and smoke-test procedure, follow Goblin's
[Setup as barktown-api analyzer](https://github.com/enchartme/barktown-goblin#setup-as-barktown-api-analyzer).

`training-samples-index.json` in MinIO is regenerated after each mutation on
a best-effort basis (the database is the source of truth, and
`ingest-service.mjs` regenerates it anyway on every new upload).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_API_HOST` | `127.0.0.1` | Public API bind interface |
| `PUBLIC_API_PORT` | `8091` | Public API port; point `barktown-api.enchart.me` here through cloudflared |
| `PRIVATE_API_HOST` | legacy `API_HOST`, then `127.0.0.1` | Private API bind interface |
| `PRIVATE_API_PORT` | legacy `API_PORT`, then `8090` | Private API port; expose only through Tailscale |
| `REANALYZE_PYTHON_BIN` | `python3` | Python environment containing Goblin's inference dependencies |
| `REANALYZE_SCRIPT_PATH` | sibling `barktown-goblin/tools/analyze_wav.py` | Goblin offline analyzer |
| `REANALYZE_MODEL_DIR` | sibling `barktown-goblin/models` | Directory containing YAMNet and the classifier metadata pair |
| `REANALYZE_TIMEOUT_MS` | `300000` | Maximum time for one synchronous re-analysis request |
| `REANALYZE_MAX_STDOUT_BYTES` | `2097152` | Kill an analyzer whose JSON/stdout exceeds this size |
| `REANALYZE_MAX_STDERR_BYTES` | `131072` | Kill an analyzer whose diagnostic output exceeds this size |
| `REANALYZE_CONCURRENCY` | `4` | Maximum concurrent analyzer processes; also used by the bulk CLI worker pool |
| `BULK_REANALYZE_PUBLIC_API_URL` | `http://127.0.0.1:$PUBLIC_API_PORT` | Read API used by `npm run bulk-reanalyze` |
| `BULK_REANALYZE_PRIVATE_API_URL` | `http://127.0.0.1:$PRIVATE_API_PORT` | Mutation API used by `npm run bulk-reanalyze` |

Deploy both unit files and enable both processes:

```bash
sudo cp ~/git/enchartme/barktown-server/barktown-api.service /etc/systemd/system/
sudo cp ~/git/enchartme/barktown-server/barktown-api-private.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barktown-api barktown-api-private
```

Configure cloudflared to route `barktown-api.enchart.me` to
`http://127.0.0.1:8091`. The existing Tailscale Serve route for
`masmopi.tail523149.ts.net` can remain on `http://127.0.0.1:8090`. Do not
publish the private port through cloudflared.

Once the units are installed, control the complete three-service stack with:

```bash
npm run serve
npm stop
npm restart
```

The corresponding per-service commands are `npm run serve:ingest`,
`serve:public`, `serve:private`, and the matching `stop:*` and `restart:*`
variants. `npm start`, `npm run server`, and `npm run server:private` remain
foreground commands for local development and debugging.

---

## Tests

```bash
npm test
```

`test/api.test.mjs` runs both real API processes against one throwaway WAL
database (no mocking). It verifies mutually exclusive route ownership,
read-after-write behavior across processes, health checks, CORS preflight,
sample lookup, and annotation CRUD. No external services are needed for the
mutations under test.

`test/export-fragments.test.mjs` additionally smoke-tests
`barktown-goblin`'s `tools/export_fragments.py` end to end: fresh export,
idempotent re-run, relabel-only move (no re-download/re-slice), and
delete-triggered orphan + cache pruning. It seeds a sample + fragment,
serves a fixture WAV over a local static file server standing in for the
public asset bucket, then drives the Python script as a subprocess and
inspects its output files. This suite is skipped automatically unless
`python3` and a sibling `../barktown-goblin` checkout (with
`tools/export_fragments.py`) are both present.

Fixtures and test helpers live under `test/fixtures/` (synthetic WAV
generation) and `test/helpers/` (spawning either API, a static file server,
and free-port allocation) — nothing is checked in as binary data.

---

## Running manually

```bash
node ingest-service.mjs
# or
npm start
```

It reads env vars from the shell, so you can pass overrides inline:
```bash
MINIO_ACCESS_KEY=yourkey MINIO_SECRET_KEY=yoursecret node ingest-service.mjs
```

---

## Deploy as a systemd service

### 1 — Create your `.env` file

```bash
cd ~/git/enchartme/barktown-server
cp .env.example .env
nano .env          # set MINIO_ACCESS_KEY, MINIO_SECRET_KEY, and anything else
```

`.env` is gitignored — it stays on the Pi only.

### 2 — Install the service unit

The unit file uses `%h` (systemd's home-directory specifier for the `User=` account) so paths resolve automatically as long as your clone is at `~/git/enchartme/barktown-server`.

```bash
sudo cp ~/git/enchartme/barktown-server/barktown-ingest.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barktown-ingest
```

### 3 — Check it's running

```bash
systemctl status barktown-ingest
journalctl -u barktown-ingest -f    # live log tail
```

### Updating after a `git pull`

No reinstall needed — just restart the service:

```bash
cd ~/git/enchartme/barktown-server
git pull
npm install                          # only needed if package.json changed
sudo systemctl restart barktown-ingest
```

---

## MinIO bucket setup

> On this Pi `minio-client` is the CLI (not `mc`, which is Midnight Commander).

Create the bucket and the `upload-here/` prefix marker:

```bash
# Configure alias (once)
minio-client alias set local http://localhost:9000 minioadmin minioadmin

# Create bucket
minio-client mb local/barktown

# Create the upload-here/ prefix (upload an empty marker object)
echo "" | minio-client pipe local/barktown/upload-here/.keep

# Make the bucket publicly readable (so the SvelteKit app can fetch assets)
minio-client anonymous set download local/barktown
```

To manually inspect or remove a stuck file:

```bash
minio-client ls local/barktown/upload-here/
minio-client rm local/barktown/upload-here/"2026-01-17 15-42-00 bad name.m4a"
```

---

## Filename pattern

```
YYYY-MM-DD HH-MM-SS optional comment.m4a
YYYY-MM-DD HH-MM-SS optional comment.aac
```

Automatically detected clips use the stable marker-only form below. Detection
confidence, density, hit count, and loudness are stored in `hit_metadata` and
must not be embedded in filenames or IDs.

```text
YYYY-MM-DD HH-MM-SS -A-.wav
```

- No trailing space before `.ext`
- Files not matching this pattern stay in `upload-here/` untouched

Examples of valid names:
```
2026-01-17 15-42-00 bark bark bark shot.m4a
2025-12-11 05-32-00.aac
2026-02-07 17-25-00 barks and yaps.m4a
```
