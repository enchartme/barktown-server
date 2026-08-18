export const REANALYSIS_TRIM_PADDING_MS = 1500;

/**
 * Derive a canonical diary trim around newly analyzed bark timestamps.
 * Null bounds mean the complete recording, including when there are no hits
 * or the padded range already covers the complete source.
 */
export function trimBoundsAroundHits(
  timestamps,
  durationSec,
  paddingMs = REANALYSIS_TRIM_PADDING_MS,
) {
  const durationMs = Number.isFinite(durationSec)
    ? Math.max(0, Math.round(durationSec * 1000))
    : 0;
  const hits = Array.isArray(timestamps)
    ? timestamps.filter(timestamp => Number.isFinite(timestamp) && timestamp >= 0)
    : [];
  if (durationMs === 0 || hits.length === 0) {
    return { trimStartMs: null, trimStopMs: null };
  }

  const firstHitMs = Math.round(Math.min(...hits) * 1000);
  const lastHitMs = Math.round(Math.max(...hits) * 1000);
  const trimStartMs = Math.max(0, firstHitMs - paddingMs);
  const trimStopMs = Math.min(durationMs, lastHitMs + paddingMs);

  if (
    trimStopMs <= trimStartMs
    || (trimStartMs === 0 && trimStopMs === durationMs)
  ) {
    return { trimStartMs: null, trimStopMs: null };
  }
  return { trimStartMs, trimStopMs };
}
