#!/bin/sh
set -eu

if [ ! -s "${DB_PATH:?Set DB_PATH}" ]; then
  printf '%s\n' "Barktown database missing: $DB_PATH. Run deploy/database.sh init or restore first." >&2
  exit 1
fi
exec "$@"
