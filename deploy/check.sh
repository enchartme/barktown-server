#!/usr/bin/env bash
set -euo pipefail
public=${1:-http://127.0.0.1:8091}
private=${2:-http://127.0.0.1:8090}
for url in "${public%/}/health" "${private%/}/health" \
  "${public%/}/api/diary/latest-date" "${private%/}/api/monitor-params"; do
  curl --max-time 10 -fsS -o /dev/null "$url"
  printf 'OK %s\n' "$url"
done
status=$(curl --max-time 10 -sS -o /dev/null -w '%{http_code}' "${public%/}/api/monitor-params")
[[ "$status" == 404 ]] ||
  { echo "Public API must return 404 for the private endpoint; got $status" >&2; exit 1; }
echo "OK: private endpoint is absent from the public API"
