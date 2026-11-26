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

### Bulk waveform resolution migration

`rebuild-samples-index.mjs` migrates active training-sample waveforms using
SQLite as its source of truth. It skips waveform JSON already at the current
default resolution, so an interrupted run can be resumed safely. The default
is a read-only dry run:

```bash
npm run migrate-sample-waveforms
npm run migrate-sample-waveforms -- --apply
```

Use `--limit N` for a small first batch or `--force` to regenerate matching
waveforms too. Apply mode overwrites only each sample's existing waveform
object and republishes `training-samples-index.json` from SQLite; it does not
change sample rows or discover samples by scanning object storage.

### Repair sample/diary connections

`repair-sample-diary-links.mjs` audits the relationship in both directions.
The stored link is `samples.diary_id`; the diary's `sampleId` is derived from
that field. The script matches the two tables by their local timestamp down to
the second, reports targets missing on either side, and refuses to guess when a
timestamp is duplicated. It is read-only unless `--apply` is supplied:

```bash
npm run repair-sample-diary-links
npm run repair-sample-diary-links -- --apply
```

Use `--db PATH` to inspect a specific database. The audit also compares audio
and waveform references for diary entries whose audio lives under
`training-samples/`. It reports old paths left behind by sample relabeling and
missing or stale diary waveform references, showing each proposed before/after
value. Repairs use the current active sample metadata, including when the link
itself needs repair in the same run.

Apply mode repairs safe, one-to-one active-sample links and these diary asset
references in one transaction, then verifies the result. Ambiguous matches and
conflicting active links are skipped. Independent diary encodings under `audio/`
retain their own audio and waveform paths. Diary IDs, labels, filenames, trims,
approvals, annotations, and hit metadata are preserved. Missing sample references
are reported instead of clearing diary references. Re-running after a repair
makes no further changes.

This is a SQLite metadata audit: it does not check whether MinIO objects exist,
move files, or regenerate waveforms. Its replacement paths come from the sample
rows; it does not infer filenames or guess object keys.

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
| `GET /api/data-quality` | List timeboxed capture-integrity and XRUN facts, with inclusive `startDate`/`endDate` filters and 1-based pagination (max `pageSize` 1000) |
| `GET /api/diary/:id/data-quality` | Get timeboxed capture-integrity and XRUN facts for one recording |
| `GET /api/samples` | List active training samples (`?label=bark` to filter) |
| `GET /api/samples/:id` | Get one sample |
| `GET /api/samples/:id/annotations` | List fragment annotations for a sample |
| `GET /api/samples/:id/data-quality` | Get capture-integrity facts retained with a moved sample |
| `GET /api/annotations` | List every annotation across all samples in one request (includes each annotation's sample `audioPath`/`durationSec`) — for laptop-side training export tooling |
| `GET /api/training/projection.csv` | Stream `training-set-projection.csv` from the configured MinIO bucket, with gzip when accepted by the client |

Public responses send `Cache-Control: no-store`; filtering and freshness come
from live database queries rather than an independently cached data dump.
The training projection route also uses `no-store` and streams the current
MinIO object without buffering the complete CSV. It negotiates gzip through
`Accept-Encoding` and sends `Vary: Accept-Encoding`; clients that do not accept
gzip receive the original CSV. The browser decompresses the response before
the UI parses it. The route returns `404` for a missing object and `502` when
storage cannot be reached. Audio continues to load directly from MinIO.
Diary entries include an `annotations` array containing only whole-recording
notes. Linked recordings expose their sample-wide `0..0` note annotations;
unlinked recordings expose the equivalent diary-scoped notes.

### Private API (`barktown-api-private`)

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check |
| `GET /api/monitor-params` | List Goblin monitor parameters |
| `PUT /api/diary/:id/comment` | Add or replace the whole-recording note, using the linked sample annotation when available |
| `DELETE /api/diary/:id/comment` | Clear the whole-recording note from the diary entry or its linked sample |
| `PATCH /api/diary/:id/trim` | Persist or clear non-destructive `trimStartMs`/`trimStopMs` playback bounds |
| `PATCH /api/monitor-params/:paramId` | Update one monitor parameter |
| `POST /api/diary/:id/hit-metadata` | Upsert hit metadata produced automatically by Goblin |
| `POST /api/diary/:id/data-quality` | Upsert Goblin's timeboxed capture-integrity and XRUN facts |
| `GET /api/reanalysis` | Current/last re-analysis job, progress counts, errors and currently processing recording IDs (private only) |
| `POST /api/diary/reanalyze-day` | Start a detached full-day job with `{ "date": "YYYY-MM-DD" }` and optional tuning overrides; returns `202` |
| `POST /api/diary/auto-approve-day` | Approve qualifying unapproved audio records for `{ "date": "YYYY-MM-DD" }` using saved thresholds; private only |
| `GET /api/diary/:id/approval-events` | Approval/withdrawal history with threshold and evidence snapshots; private only |
| `POST /api/diary/:id/reanalyze` | Reclassify the available source WAV and store the result |
| `DELETE /api/diary/:id` | Delete a diary entry |
| `POST /api/diary/:id/move-to-samples` | Publish a diary recording and waveform as a training sample |
| `POST /api/samples/:id/regenerate-waveform` | Regenerate a training-sample waveform |
| `POST /api/samples/:id/reanalyze` | Reclassify a sample WAV and atomically replace its bark/review/yap fragments with new review windows |
| `DELETE /api/samples/:id` | Delete a sample (MinIO objects + DB row) |
| `PATCH /api/samples/:id` | Rename/move a sample to a different label (`{"label":"bark"}`) |
| `POST /api/samples/:id/annotations` | Add a fragment annotation (`{startSec, endSec, label, source?}`) |
| `PATCH /api/annotations/:id` | Update a fragment annotation (partial body) |
| `POST /api/annotations/:id/window-review` | Keep, unkeep, or atomically trim/split a projection-matched bark/yap fragment |
| `DELETE /api/annotations/:id` | Delete a fragment annotation |

Training samples and annotations are public read-only metadata again. The
training UI and `barktown-utils/tools/export_fragments.py` use
`https://barktown-api.enchart.me`. Mutations and operator-only reads remain on
the named Tailscale endpoint `https://barktown-private.tail523149.ts.net`.

Bulk hit-metadata responses contain `items`, pagination fields including
`hasNextPage`, `isLastPage`, and `complete`, plus `links.next`/`links.previous`.
The same navigation links are advertised in the HTTP `Link` header. Date bounds
use the linked diary recording's `YYYY-MM-DD` date; without bounds, orphaned
metadata that has not yet acquired a diary row is included as well.
Each record also exposes `modelTrainedAt`, `analysisSettings`, nullable `analyzedAt`, and
`analysisTrigger`. `analysisSettings` contains the classifier identity and the
settings actually applied during that run. Existing records
migrate with an unknown model timestamp, empty settings, and an `automatic`
trigger.

`hit_metadata.analyzed_at` is a nullable UTC timestamp exposed as `analyzedAt`.
For new results it records when the server saves the completed analysis;
it is not the recording timestamp or the classifier training timestamp.
Historical rows remain NULL until replaced by a new analysis. The timestamp
is included in approval evidence so later analysis replacements cannot change
the historical basis of an approval.

Hit metadata also supports optional per-hit multilabel diagnostics. Classifier
submissions to `POST /api/diary/:id/hit-metadata` and offline analyzer output
use `multilabel_scores`. Both `GET /api/diary/:id/hit-metadata` and the `items`
in `GET /api/hit-metadata` return the field as `multilabelScores`, following
the existing camel-case response convention. The POST response uses the same
shape. For example, a classifier may submit:

```json
{
  "timestamps": [1.5, 5.5],
  "confidences": [0.99, 0.97],
  "loudnesses": [1.2, 1.4],
  "multilabel_scores": [
    {"bark": 0.45, "yap": 0.4, "wildlife": 0.98},
    {"bark": 0.6, "wrongdog": 0.8, "wind": 0.2}
  ]
}
```

When supplied, the array must match `timestamps` in length. Every entry must
be a nonempty JSON object with canonical sample label names (`bark`, `yap`,
`background`, `wind`, `homestead`, `traffic`, `wildlife`, `gunshot`, `wrongdog`)
and finite numeric scores in [0, 1]. A subset of labels is accepted; a missing
label means unavailable, not zero. Shortcuts and workflow-only labels are not
accepted. Scores are independent and need not sum to one. Binary confidences
are stored unchanged; the server does not derive decisions or apply vetoes.
The classifier must align each diagnostic object with the same binary hit and
underlying inference patch. Existing `analysis_settings` preserves both head
identities and scoring settings.

The nullable SQLite `hit_metadata.multilabel_scores` TEXT column stores JSON.
Existing databases migrate automatically when a writable process calls
`openDb()`; old rows remain SQL NULL and read as `multilabelScores: null`.
Omitted or explicit-null diagnostics are accepted from older classifiers.
A zero-hit result may supply `[]`; null means diagnostics are unavailable.
Every upsert replaces the whole result: a new binary-only result clears any
previous diagnostic array, preventing stale score/timestamp alignment. Manual
reanalysis passes the optional array through the same validation and atomic
metadata/trim/approval update. No full-window scores are stored.

On deployment, start/restart a writable process (ingest or private API) before
restarting the public API, so the shared database is migrated first. The public
API remains read-only and does not perform schema migrations. This change
supports the receive/read contract; the independently deployed Goblin analyzer
emits these scores. Waveform UI rendering remains separate work.

Diary responses include a live `reanalyzable` boolean. For Goblin clips, it is true when a
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

Docker deployments call the independent Goblin analyzer over its private HTTP
endpoint. See [the one-time Dokploy setup](deploy/README.md#re-analyze-independently-deployed-goblin-service).
Goblin main auto-deploys independently after setup.

Manual re-analysis of existing Goblin clips is deterministic window reclassification, not replay of
Goblin's callback-aligned live event state machine. It applies and records only
`candidate_threshold`, `hit_refractory_s`, `inference_window_s`, and
`score_interval_s`. Confirmation, silence-gap, cooldown, and event assembly do
not participate. A successful re-analysis clears the recording's approval,
because the previously reviewed hit set and automatic trim have been replaced.
Training-sample re-analysis uses the same deterministic analyzer and tuning
overrides. It preserves notes and non-bark/review/yap fragments, removes every
existing bark/review/yap fragment, then adds one model-sourced review fragment for
each newly accepted classifier window.

The private API accepts one re-analysis job at a time: a single diary recording,
a training sample, or a full day. All competing re-analysis requests return `409`
until that job finishes. Only day jobs schedule several recordings internally,
within the configured worker-slot budget. Other API routes and ingestion remain
available. Each operation uses a unique temporary directory, and analyzer
stdout/stderr are capped as well as timed out.

### Historical phone and voice-recorder imports

The same **Re-analyze** button accepts timestamped `.aac` and `.m4a` diary entries
under `audio/YYYY/MM/`. Their diary response includes `reanalysisMode: "historical"`;
no archived WAV is required. This path:

1. Copies the complete original to
   `historical-recordings-archive/YYYY/MM/<original filename>` in the same bucket.
   A retry reuses an identical archived original and refuses a conflicting one.
2. Decodes to a temporary 16 kHz mono PCM WAV and replays trailing inference windows
   through Goblin's actual `BarkEventAssembler`, in recording order. Settings are
   frozen at job start: confidence, refractory, confirmation hits and window,
   silence gap, cooldown, maximum clip length, padding, and upload gates. Upload
   cooldown uses elapsed recording time. Confirmed events are flushed at EOF;
   unconfirmed candidates are discarded.
3. Creates one `YYYY-MM-DD HH-MM-SS -A-.mp3` per accepted event, with the same volume,
   bitrate, ID3 provenance, date, artist, album, copyright and Barktown link tags as
   ordinary Goblin ingest. Each event has its own archived PCM WAV, waveform,
   aligned hit metadata, classifier diagnostics, and replay provenance.
4. Publishes every event object before atomically replacing the original diary row
   with the new clips. New clips start unapproved. The old public audio and waveform
   are removed afterwards; the complete original remains archived. Source filename
   comments and diary notes are copied to each event's note.

The filename timestamp means **local recording start time**. Clip timestamps add
the elapsed offset of the first sample, including pre-event padding; clock arithmetic
does not apply the server's timezone or a UTC conversion. Day, month, and year
boundaries select the resulting clip's own `YYYY/MM/` directory. The exact fractional
offset remains in provenance even though filenames have whole-second precision.
Hit timestamps are relative to the extracted clip. The final maximum-length cap
matches Goblin's uploader by retaining the tail.

`POST /api/diary/:id/reanalyze` returns **202** immediately for these imports.
`GET /api/reanalysis` exposes stages, event counts, errors and replacement IDs;
the UI polls it and refreshes the diary/report when the job completes. Day jobs also
include available historical sources. Existing Goblin/sample re-analysis keeps its
current behavior. With no accepted events, the original diary entry and public audio
remain available for review, with empty hit metadata. A failure retains the original
entry and rolls back newly published event objects. Existing clip filenames are never
deliberately overwritten; collisions fail the import.

Deploy **Goblin analyzer first, then server and UI**. No recording-Pi update or database
migration is needed for this feature. The server image already includes ffmpeg,
ffprobe and audiowaveform. Inference keeps one trailing window in RAM; the decoded
source lives on temporary disk. The default replay upload cap is 1 GiB (about nine
hours of 16 kHz mono PCM), and the analyzer processing timeout is 24 hours. Raise
`ANALYZER_REPLAY_MAX_UPLOAD_BYTES` and `ANALYZER_REPLAY_TIMEOUT_S` on Goblin, and
`REANALYZE_REPLAY_TIMEOUT_MS` on the server for larger jobs. Long HTTP replay avoids
fetch's response-header deadline. Jobs are process-local: keep the private API and
analyzer running during imports.

### Bulk re-analysis by date

On the Tailnet, use **Re-analyze day** in a report card header or diary day
label. The browser starts `POST /api/diary/reanalyze-day` on the private API.
The job snapshots that day's recordings, skips unavailable source WAVs, and
freezes detector settings for the run. Uploads arriving later remain outside
that snapshot. Each successful result is committed independently; failures
are counted and the rest of the day continues.

Connected clients poll `GET /api/reanalysis` once a second, disable all
re-analysis controls during any job, and refresh completed results in place.
The report replaces currently processing recordings' barcode lines with
“Processing…”. Playback, reads, uploads and other edits stay available.
Closing the initiating browser does not cancel the job. Job progress is kept
in the private API process's memory; restarting it interrupts the job and
clears progress, while already committed recording results remain saved.


In Dokploy's **private-api container terminal**, run:

```bash
cd /app
npm run bulk-reanalyze -- 2026-11-12
```

Replace the date as needed. The container uses the public metadata API to
select available recordings and its local private API to submit reanalysis.
The batch processes one recording at a time, while the HTTP analyzer uses the
configured per-record worker count (for example three). No threshold override
is needed to add diagnostic scores at the current production threshold.
Successful records have hit metadata/automatic trim replaced and approval
cleared, just like the individual UI action. Missing source WAVs are skipped.
Keep the terminal open until the final summary appears.


Run the server-local CLI with one real calendar date, or an explicit inclusive
date range. It loads the current diary, selects only matching entries whose
source WAV is currently available, and submits them through a bounded worker
pool:

```bash
cd ~/git/enchartme/barktown-server
npm run bulk-reanalyze -- 2026-08-20
npm run bulk-reanalyze -- --start-date 2026-08-20 --end-date 2026-08-27 -t 0.9
```

The `--` before named options is required by npm so it forwards those options
to the script. Both `--start-date` and `--end-date` are required for range mode,
and all dates must use `YYYY-MM-DD`. The CLI prints a `START` line as each worker
takes a record, an `OK` or `FAIL` line as it completes, and a final
succeeded/failed/unavailable summary. A failed recording does not stop the rest
of the selection. Entries without a discoverable archive or linked training WAV
are counted as unavailable and are not submitted.

Per-run analyzer overrides are optional:

| Option | API setting | Allowed value |
|---|---|---|
| `-t`, `--threshold` | `candidate_threshold` | `0..1` |
| `-r`, `--refractory` | `hit_refractory_s` | `>= 0` seconds |
| `-w`, `--window` | `inference_window_s` | `>= 0.1` seconds |
| `-s`, `--step` | `score_interval_s` | `>= 0.05` seconds |

Only supplied options override the current SQLite `monitor_params` values for
this CLI run. They are sent with every selected request and recorded in its
hit-metadata provenance; the database defaults themselves are not changed.

The CLI reads the diary from `http://127.0.0.1:$PUBLIC_API_PORT` and submits work to
`http://127.0.0.1:$PRIVATE_API_PORT` outside Docker. Compose sets the read
URL to `https://barktown-api.enchart.me` because public/private API containers
are isolated. Override `BULK_REANALYZE_PUBLIC_API_URL` for another public host.
`BULK_REANALYZE_CONCURRENCY` is accepted for compatibility, but CLI requests
are serialized to respect the API job lock. Use the UI day job to schedule
recordings within the private API worker-slot budget. With the HTTP
analyzer, each file uses the server's configured per-job worker count. Local
subprocess bulk mode retains one worker per file.

By default, re-analysis runs one worker at a time. `REANALYZE_CONCURRENCY`
controls how many worker slots may be active across all requests.
`REANALYZE_WORKERS_PER_JOB` limits the workers for one interactive diary or
training re-analysis and never exceeds the shared budget. Bulk requests use
the configured per-job workers with the HTTP service (one worker in legacy
local bulk mode). Each worker loads its own models; keep both settings
at `1` on the Pi unless parallel runs have been tested.

For the standalone analyzer image and one-time Dokploy setup, see
[the deployment guide](deploy/README.md#re-analyze-independently-deployed-goblin-service).
Python and models now belong to the Goblin service; the server image only
streams WAVs and receives results. The local subprocess remains available
outside Docker when `REANALYZE_URL` is omitted.

`training-samples-index.json` in MinIO is regenerated after each mutation on
a best-effort basis (the database is the source of truth, and
`ingest-service.mjs` regenerates it anyway on every new upload).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_API_HOST` | `127.0.0.1` | Public API bind interface |
| `PUBLIC_API_PORT` | `8091` | Public API port; point `barktown-api.enchart.me` here through cloudflared |
| `PRIVATE_API_HOST` | legacy `API_HOST`, then `127.0.0.1` | Private API bind interface |
| `PRIVATE_API_PORT` | legacy `API_PORT`, then `8090` | Private API port; expose only through Tailscale |
| `REANALYZE_URL` | Compose: `http://barktown-analyzer:8080`; otherwise unset | Independent analyzer service; unset selects the legacy local subprocess |
| `REANALYZE_PYTHON_BIN` | `python3` | Local-subprocess mode only: Python environment containing inference dependencies |
| `REANALYZE_SCRIPT_PATH` | sibling `barktown-goblin/tools/analyze_wav.py` | Local-subprocess mode only: Goblin offline analyzer |
| `REANALYZE_MODEL_DIR` | sibling `barktown-goblin/models` | Directory containing YAMNet and the classifier metadata pair |
| `REANALYZE_TIMEOUT_MS` | Compose: `330000`; local: `300000` | Maximum time for one synchronous re-analysis request |
| `REANALYZE_MAX_STDOUT_BYTES` | `2097152` | Reject oversized HTTP results or local subprocess stdout |
| `REANALYZE_MAX_STDERR_BYTES` | `131072` | Kill an analyzer whose diagnostic output exceeds this size |
| `REANALYZE_CONCURRENCY` | `1` | Total active worker slots across all requests |
| `REANALYZE_WORKERS_PER_JOB` | `1` | Workers for one interactive request, capped by the total; bulk requests always use one |
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
`http://127.0.0.1:8091`. Configure the named Tailscale Service
`svc:barktown-private` (`https://barktown-private.tail523149.ts.net`)
to forward HTTPS to `http://127.0.0.1:8090`. Do not publish the private port
through cloudflared.

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

Capture integrity is stored separately in `data_quality`, keyed by the same
record ID. It records the exact half-open recording interval `[start, end)`,
XRUN totals and reason counts, plus a bounded JSON list of XRUN offsets and
PortAudio details. PortAudio reports incidents, not the number of samples lost.

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

## Production deployment

See [the Pi and Dokploy runbook](deploy/README.md) for a fresh installation,
restoring SQLite and MinIO, or redeploying an existing Barktown service.

### Diary/report presentation filters

`settings` is a key/value SQLite table with `key`, `value` (TEXT), and
`description`. Writable `openDb()` calls create it and seed, without overwriting
saved values, `filter_<label>_min` and `filter_<label>_max` for all nine sample
labels, plus `positive`, `negative`, and `delta`. Positive is the maximum
of bark/yap; negative is the maximum of the other seven labels; delta is
positive minus negative. Defaults are 0–1 for individual/positive/negative
ranges, and −1–1 for delta. Both delta bounds can range over [−1, 1], with minimum ≤ maximum; all other
bounds are in [0, 1]. New settings are
seeded on the next writable `openDb()` without overwriting existing values.

`GET /api/settings` on the public API returns `{key, value, description}[]`
with numeric filter values. The private API also supports this read and accepts
`PATCH /api/settings` with a key/value object, e.g.
`{"filter_bark_min":0.7,"filter_homestead_max":0.5}`. Updates are atomic;
unknown keys, nonnumeric/out-of-range values, and min > max return 400.
Start/restart a writable service to migrate existing databases before using
settings updates. A public reader of a pre-migration database returns defaults.

The tailnet-only ⚙️ menu edits these shared filters. The browser applies them
to diary/report hit displays and bark counts, retaining each window only when
all available label and aggregate scores satisfy the inclusive ranges. Group
maxima use the available scores; an entirely missing group passes its filter.
Delta is unavailable unless both groups have scores. Missing diagnostics
pass through. Raw metadata, binary detection, recording durations, disturbance
counts, and training annotations are unchanged. Other open browsers refresh
settings when they regain focus. Slider changes save on release (including
keyboard adjustments); Reset ranges immediately restores the unfiltered defaults
(including −1–1 for delta) and saves, restoring all windows without reanalysis. The summary API itself remains unfiltered;
the report subtracts filtered windows from its totals after metadata loads.
On the tailnet, filtered windows remain visible in grey in the diary, report
barcodes, and player waveform; filtered diamonds use 0.3 idle opacity and 1
on hover. Operator waveform/day/week counts show the retained count followed
by the number filtered out. Public views continue to hide filtered windows.

### Day auto-approval and audit

The Tailnet gear menu has separate **Hide barks from view** and **Auto-approve**
tabs. Both use `GET /api/settings` and Tailnet-only `PATCH /api/settings`.
Automatic approval settings are seeded without replacing saved values:

| Key | Range | Default | Condition |
| --- | --- | --- | --- |
| `auto_approve_require_all` | Integer 0–1 | 1 | 1 = AND (all 4 conditions), 0 = OR (at least 1) |
| `auto_approve_mean_loudness_min` | 1–10 | 4 | Mean loudness ≥ threshold |
| `auto_approve_density_min` | 0–100 | 50 | Density percentage ≥ threshold |
| `auto_approve_delta_mean_min` | 0.5–1 | 0.9 | Mean delta ≥ threshold |
| `auto_approve_delta_sigma_max` | 0–1 | 0.1 | Population delta sigma ≤ threshold |
| `auto_approve_trim_sparse_tails_s` | 0–120 | 0 | Optional sparse-tail trimming time limit in seconds; 0 is off |
| `auto_approve_bundle_count` | Integer 1–5 | 1 | Windows in a compact bundle, plus one nearby supporting window |

`POST /api/diary/auto-approve-day` evaluates only currently unapproved audio
records for the supplied local diary date. It runs synchronously in one
transaction, freezing thresholds and evidence. Existing approvals are left
untouched. An active re-analysis returns 409. Nothing is automatically approved
on ingest, re-analysis, threshold changes, or page load; use the day button.
The response includes `evaluated`, `approved`, `trimmed`, `alreadyApproved`,
`skipped`, and `items` containing the newly approved IDs, timestamps, approval
sources, and saved trim bounds. Clients merge the bounds into diary/player
state and refresh report summaries after a trim.

Sparse-tail trimming is optional and off by default. For a time limit T > 0
and bundle count B, inspect chronologically ordered distinct hit timestamps
inside the current saved trim. A qualifying bundle contains B consecutive
hits spanning at most T seconds, with an additional hit strictly less than T
seconds before its first hit or after its last. Keep the range from the first
qualifying group through the last, including the supporting hits and every
session, gap, and isolated hit between them. An isolated B-hit bundle without
support does not qualify. For B=1 this requires a pair; B=2 requires a compact
pair plus a third nearby hit. No qualifying group leaves the trim unchanged.

For example, T=20 and B=2 with hits at
`0,40,45,100,110,125,180,240,250,265,320,360,365` retains the range anchored by
100 and 265. The isolated middle hit at 180 remains; both exterior pairs are
removed from view. Hit timestamps mark inference-window ends, so the saved
start retains the first full `window_s` of audio and the stop includes the
final timestamp under half-open bounds (one millisecond after its anchor).
Existing trim bounds are never expanded. Raw audio and hit metadata remain
unchanged.

Compute all approval metrics on this proposed range. Save its trim and approval
together only when the selected AND/OR approval rule passes. A failed approval leaves
the previous trim unchanged. Audit rule version 3 includes the before/after
trim bounds, both trimming settings, and the AND/OR setting. Changing settings alone never trims
a record or changes an existing approval.

Metrics use all detected hits inside the proposed trim (start inclusive, stop
exclusive), ignoring presentation filters. With no valid trim they use the
full recording. Density is `count * hit_metadata.window_s / duration * 100`,
without rounding before comparison or clamping overlapping windows to 100%.
Delta is `max(bark, yap) - max(other canonical labels)` and sigma is the
population standard deviation of those deltas. `auto_approve_require_all = 1`
(the default) requires all four thresholds to pass; `0` accepts at least one
passing threshold. An absent mode keeps AND behavior. The join applies only
to the four numerical approval conditions, including sigma's upper bound.
Missing metadata, invalid window duration, fewer than two retained hits, or
any retained hit without loudness and both label groups leave the record
unapproved. The sigma default is a strict starting point to tune against
reviewed records, rather than a calibrated probability of correctness.

`diary_entries.approved` remains the current UTC approval timestamp.
`diary_entries.approval_source` is nullable (`manual` or `auto`) and is exposed
as `approvalSource`. Historical approvals retain their original timestamp
and unknown source (NULL). New nullable fields are never backfilled with
invented historical provenance.

`approval_events` retains approvals and withdrawals with server timestamps,
source, and JSON evidence. Automatic approval evidence includes rule version,
thresholds, unrounded metrics, analysis timestamp, model settings, and trim.
Manual approvals/withdrawals also record the available analysis provenance.
History is available through the private approval-events endpoint and is
retained when current approval is cleared. Re-analysis clears any approval;
a replacement hit-metadata result or changed trim clears automatic approval.
Changing thresholds does not revoke existing approvals. Deleting the diary
record deletes its associated history.

Deploy a writable server process first so `openDb()` adds the nullable columns,
seeds thresholds, and creates the audit table before restarting public readers
or deploying the UI. Goblin's existing hit-metadata payload needs no change.
