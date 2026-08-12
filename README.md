# barktown-ingest

Pi-side ingest service for **barktown**. Watches the `upload-here/` prefix in a MinIO bucket, validates filenames, generates waveform data, organises audio into `audio/YYYY/MM/` and keeps `index.json` up to date.

---

## How it works

1. You upload `.m4a` or `.aac` files to `<bucket>/upload-here/`
2. The service polls that prefix every 20 s
3. Once a file's size and ETag have been stable for 30 s (upload complete), it is processed:
   - Filename is validated against `YYYY-MM-DD HH-MM-SS optional comment.ext`
   - Invalid names are left in `upload-here/` untouched — rename and re-upload
   - `ffprobe` reads the duration
   - `audiowaveform` generates peak data (skipped for clips < 5 s)
   - Waveform JSON is uploaded to `waveforms/YYYY/MM/<id>.json`
   - Audio is copied to `audio/YYYY/MM/<filename>` then removed from `upload-here/`
   - `index.json` is updated (appended + sorted)

It also watches `training-samples/` for short labeled clips uploaded directly
by `barktown-goblin` (mic calibration / manual bark samples). Metadata for
those samples lives in a local SQLite database (`data/barktown.db`, see
`lib/db.mjs`) — `training-samples-index.json` is regenerated from it after
every update, purely so the existing barktown client can keep fetching it as
a static file from the bucket.

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
git clone <this-repo> ~/barktown-ingest
cd ~/barktown-ingest
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

Completed one-time operations and their tests are retained under `archive/`.

---

## API server

`server.mjs` is a small Fastify app exposing HTTP endpoints (read + write)
over the training-samples database. It runs as a separate process from
`ingest-service.mjs` — SQLite's WAL mode plus a busy timeout (enabled in
`lib/db.mjs`) safely support multiple writers/readers across processes.

There is **no authentication**. This service is intended to be reachable only
over the trusted Tailscale network, using the same trust boundary as
barktown-goblin's status API.

```bash
node server.mjs
# or
npm run server
```

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check |
| `GET /api/diary` | List diary entries with a live `reanalyzable` indication |
| `GET /api/diary/:id` | Get one diary entry with a live `reanalyzable` indication |
| `GET /api/samples` | List active training samples (`?label=bark` to filter) |
| `GET /api/samples/:id` | Get one sample |
| `GET /api/samples/:id/annotations` | List fragment annotations for a sample |
| `GET /api/annotations` | List every annotation across all samples in one request (includes each annotation's sample `audioPath`/`durationSec`) — for laptop-side training export tooling |
| `DELETE /api/samples/:id` | Delete a sample (MinIO objects + DB row) |
| `PATCH /api/samples/:id` | Rename/move a sample to a different label (`{"label":"bark"}`) |
| `POST /api/samples/:id/annotations` | Add a fragment annotation (`{startSec, endSec, label, source?}`) |
| `PATCH /api/annotations/:id` | Update a fragment annotation (partial body) |
| `DELETE /api/annotations/:id` | Delete a fragment annotation |
| `GET /api/hit-metadata` | Bulk hit metadata, optionally filtered by inclusive `startDate`/`endDate`; 1-based `page`, max `pageSize` 1000 |
| `GET /api/diary/:id/hit-metadata` | Get hit metadata and analysis provenance for one clip |
| `POST /api/diary/:id/hit-metadata` | Upsert hit metadata produced automatically by Goblin |
| `POST /api/diary/:id/reanalyze` | Deterministically reclassify the available source WAV with Goblin and upsert a manually triggered result |

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

Manual re-analysis is deterministic window reclassification, not replay of
Goblin's callback-aligned live event state machine. It applies and records only
`candidate_threshold`, `hit_refractory_s`, `inference_window_s`, and
`score_interval_s`. Confirmation, silence-gap, cooldown, and event assembly do
not participate.

The API permits one re-analysis operation at a time. Different records wait in
FIFO order; another request for a record that is already queued or running
returns `409`. Each operation uses a unique temporary directory, and analyzer
stdout/stderr are capped as well as timed out.

`training-samples-index.json` in MinIO is regenerated after each mutation on
a best-effort basis (the database is the source of truth, and
`ingest-service.mjs` regenerates it anyway on every new upload).

| Variable | Default | Description |
|---|---|---|
| `API_HOST` | `127.0.0.1` | Interface to bind |
| `API_PORT` | `8090` | Port to listen on |
| `REANALYZE_PYTHON_BIN` | `python3` | Python environment containing Goblin's inference dependencies |
| `REANALYZE_SCRIPT_PATH` | sibling `barktown-goblin/tools/analyze_wav.py` | Goblin offline analyzer |
| `REANALYZE_MODEL_DIR` | sibling `barktown-goblin/models` | Directory containing YAMNet and the classifier metadata pair |
| `REANALYZE_TIMEOUT_MS` | `300000` | Maximum time for one synchronous re-analysis request |
| `REANALYZE_MAX_STDOUT_BYTES` | `2097152` | Kill an analyzer whose JSON/stdout exceeds this size |
| `REANALYZE_MAX_STDERR_BYTES` | `131072` | Kill an analyzer whose diagnostic output exceeds this size |

Deploy it the same way as the ingest service — copy `barktown-api.service` to
`/etc/systemd/system/` and enable it:

```bash
sudo cp ~/git/enchartme/barktown-ingest/barktown-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barktown-api
```

---

## Tests

```bash
npm test
```

`test/api.test.mjs` runs the real `server.mjs` as a child process against a
throwaway SQLite DB (no mocking) and exercises the HTTP API directly:
health check, CORS preflight (regression test for the `@fastify/cors`
default-methods gotcha that broke PATCH/DELETE from the browser), sample
lookup, and the full annotation CRUD flow including the aggregate
`GET /api/annotations`. No external services are needed — none of the
routes under test call MinIO.

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
generation) and `test/helpers/` (spawning `server.mjs`, a static file
server, and free-port allocation) — nothing is checked in as binary data.

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
cd ~/git/enchartme/barktown-ingest
cp .env.example .env
nano .env          # set MINIO_ACCESS_KEY, MINIO_SECRET_KEY, and anything else
```

`.env` is gitignored — it stays on the Pi only.

### 2 — Install the service unit

The unit file uses `%h` (systemd's home-directory specifier for the `User=` account) so paths resolve automatically as long as your clone is at `~/git/enchartme/barktown-ingest`.

```bash
sudo cp ~/git/enchartme/barktown-ingest/barktown-ingest.service /etc/systemd/system/
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
cd ~/git/enchartme/barktown-ingest
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

- No trailing space before `.ext`
- Files not matching this pattern stay in `upload-here/` untouched

Examples of valid names:
```
2026-01-17 15-42-00 bark bark bark shot.m4a
2025-12-11 05-32-00.aac
2026-02-07 17-25-00 barks and yaps.m4a
```
