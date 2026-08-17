# Training samples UTC+2 migration (completed)

This one-time migration was completed on 2026-07-31. Do not run it again on
the migrated dataset.

Training samples had been named with UTC timestamps while the diary corpus and
historic manual recordings used local time. The operation shifted every sample
and waveform exactly two hours forward, including next-day rollover, then
updated sample IDs, filenames, object paths, dates, timestamps, and annotation
`sample_id` foreign keys in SQLite. Annotation integer IDs were preserved.

## Recorded result

- 1,001 audio objects renamed.
- 1,000 waveform objects renamed.
- 1,439 annotations retained with stable annotation IDs.
- 7 timestamps rolled over to the next day.
- SQLite integrity and foreign-key checks passed.
- The application services were restarted and their health check passed.

The on-device backup was written to:

```text
/home/pi/git/enchartme/barktown-server/data/backups/training-samples-utc-plus-2-20260731154952
```

It contains the consistent SQLite database backup, SQL and JSON exports, the
old samples index, the complete migration plan, checksums, and migration result.
Checksums and the backup database integrity were verified after the migration.

## Archived implementation

- `migrate-training-samples-utc-plus-2.mjs` is the guarded operation runner.
- `training-sample-time-migration.mjs` contains pure mapping and transactional
  database helpers.
- `time-migration.test.mjs` tests timestamp rollover, collision handling,
  annotation association, chained IDs, and backup/export integrity.

The archived tests remain directly runnable from the repository root:

```bash
node --test archive/training-samples-utc-plus-2/time-migration.test.mjs
```

The reusable SQLite backup/export implementation remains active at
`lib/sqlite-backup.mjs`; only migration-specific code was archived.

## Historical safeguards

The runner defaults to a read-only dry run and requires `--apply` for mutation.
It refuses missing, unexpected, or colliding database/object mappings. Before
the first mutation it exports the SQLite database and samples index, and it
uses unique MinIO staging keys to prevent overwrites where a target timestamp
was another sample's source timestamp. Pre-commit failures restore the original
object names and index.
