# Auto-detection canonical-name migration

This pending one-off migration makes the timestamp plus `-A-` marker the stable
identity of every automatically detected diary clip. Mutable analysis values
remain in `hit_metadata` and are formatted for display by the Barktown client.

Example:

```text
2026-08-01 11-08-24 -A- C1 D11 W9 La1.4 Lm1.2.wav
-> 2026-08-01 11-08-24 -A-.wav

2026-08-01_11-08-24_-A-_C1_D11_W9_La1_4_Lm1_2
-> 2026-08-01_11-08-24_-A-
```

The operation updates:

- MinIO objects below `uncompressed-uploads-archive/`, `audio/`, and
  `waveforms/`, using staged copies before old keys are removed. Exact legacy
  archive WAVs are included even when their original diary row was moved or
  deleted and no longer references them.
- `diary_entries.id`, `filename`, `audio_path`, `waveform_path`, `label`, and
  `source_wav_path`.
- `samples.diary_id`, including an orphan legacy reference if one exists.
- `hit_metadata.clip_id`, including metadata that arrived before diary ingest.
- MinIO `index.json`, regenerated from the planned post-migration DB state.

## Safeguards

The runner is a dry run unless `--apply` is supplied. Preflight rejects missing
objects, unrepresented derived `audio/` or `waveforms/` objects, target
collisions, inconsistent DB paths, split identity collisions, and a previously
completed run. A standalone archive WAV is safe to include because its exact
legacy name deterministically yields the canonical archive name. Apply mode
also refuses to start while `barktown-ingest` or `barktown-api` is active.

Before mutation, it creates a consistent SQLite binary backup plus SQL/JSON
exports, the old `index.json`, and complete DB/MinIO migration plans. Objects
are copied to unique staging keys, then canonical target keys are published,
then `index.json` and SQLite are committed. A failure before the DB commit
removes published/staged copies and restores the old index. Source objects are
deleted only after the DB transaction commits.

## Procedure

Deploy the Goblin and ingest/API naming changes before applying the migration,
so new traffic cannot recreate legacy IDs.

From the `barktown-ingest` checkout on the Pi:

```bash
npm install
npm test
npm run migrate-auto-detection-names
```

Review the dry-run counts and examples. Then stop writers and apply:

```bash
sudo systemctl stop barktown-ingest barktown-api
npm run migrate-auto-detection-names -- --apply
sudo systemctl start barktown-ingest barktown-api
```

Afterward, check both services and the UI. The migration result and its backup
directory are printed by the runner. Keep that directory with the full backup
until the migrated corpus has been independently verified.

The focused migration tests can also be run directly:

```bash
node --test migrations/auto-detection-canonical-names/auto-detection-name-migration.test.mjs
```

Once the real migration is completed and recorded, move this directory under
`archive/` and add the actual counts/result to this README.
