/**
 * Normalize a local SQLite timestamp to its second-precision identity.
 * No timezone conversion is performed: both tables store the same local wall
 * clock value, and that value is the deterministic cross-link key.
 */
export function localTimestampSecond(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  if (
    parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1
    || parsed.getUTCDate() !== Number(day)
    || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute)
    || parsed.getUTCSeconds() !== Number(second)
  ) return null;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function groupByTimestamp(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const timestamp = localTimestampSecond(row.datetimeLocal);
    if (!timestamp) continue;
    const group = grouped.get(timestamp) ?? [];
    group.push(row);
    grouped.set(timestamp, group);
  }
  return grouped;
}

function normalizedDiaryId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compareByTimestampAndId(a, b) {
  return String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""))
    || (a.sampleId ?? a.diaryId ?? "").localeCompare(b.sampleId ?? b.diaryId ?? "");
}

/**
 * Audit the single authoritative sample/diary relationship (`samples.diary_id`)
 * from both directions. Exact local timestamps, normalized to seconds, define
 * identity. A repair is proposed only for one active sample and one diary row
 * at the timestamp; duplicate timestamps are reported instead of guessed.
 */
export function auditSampleDiaryLinks(diaryRows, sampleRows) {
  const diaries = diaryRows
    .filter((row) => row.kind === undefined || row.kind === "audio")
    .map((row) => ({
      id: row.id,
      datetimeLocal: row.datetimeLocal ?? row.datetime_local,
    }));
  const activeSamples = sampleRows
    .filter((row) => row.status === "active")
    .map((row) => ({
      id: row.id,
      diaryId: normalizedDiaryId(row.diaryId ?? row.diary_id),
      datetimeLocal: row.datetimeLocal ?? row.datetime_local,
      status: row.status,
    }));

  const diaryById = new Map(diaries.map((row) => [row.id, row]));
  const diariesByTimestamp = groupByTimestamp(diaries);
  const samplesByTimestamp = groupByTimestamp(activeSamples);
  const currentSamplesByDiary = new Map();
  for (const sample of activeSamples) {
    if (!sample.diaryId) continue;
    const occupants = currentSamplesByDiary.get(sample.diaryId) ?? [];
    occupants.push(sample);
    currentSamplesByDiary.set(sample.diaryId, occupants);
  }

  const invalidTimestamps = [
    ...diaries
      .filter((row) => !localTimestampSecond(row.datetimeLocal))
      .map((row) => ({ side: "diary", id: row.id, value: row.datetimeLocal })),
    ...activeSamples
      .filter((row) => !localTimestampSecond(row.datetimeLocal))
      .map((row) => ({ side: "sample", id: row.id, value: row.datetimeLocal })),
  ].sort((a, b) => a.side.localeCompare(b.side) || a.id.localeCompare(b.id));

  const orphanedCurrentLinks = activeSamples
    .filter((sample) => sample.diaryId && !diaryById.has(sample.diaryId))
    .map((sample) => ({
      sampleId: sample.id,
      diaryId: sample.diaryId,
      timestamp: localTimestampSecond(sample.datetimeLocal),
    }))
    .sort(compareByTimestampAndId);

  const mismatchedCurrentLinks = activeSamples
    .filter((sample) => {
      if (!sample.diaryId) return false;
      const diary = diaryById.get(sample.diaryId);
      return diary
        && localTimestampSecond(sample.datetimeLocal) !== localTimestampSecond(diary.datetimeLocal);
    })
    .map((sample) => ({
      sampleId: sample.id,
      diaryId: sample.diaryId,
      sampleTimestamp: localTimestampSecond(sample.datetimeLocal),
      diaryTimestamp: localTimestampSecond(diaryById.get(sample.diaryId)?.datetimeLocal),
    }))
    .sort((a, b) => a.sampleId.localeCompare(b.sampleId));

  const duplicateCurrentTargets = [...currentSamplesByDiary.entries()]
    .filter(([, samples]) => samples.length > 1)
    .map(([diaryId, samples]) => ({
      diaryId,
      sampleIds: samples.map((sample) => sample.id).sort(),
    }))
    .sort((a, b) => a.diaryId.localeCompare(b.diaryId));

  const healthyLinks = [];
  const candidateRepairs = [];
  const sampleMissingTargets = [];
  const diaryMissingTargets = [];
  const ambiguousTimestamps = [];
  const timestamps = new Set([
    ...diariesByTimestamp.keys(),
    ...samplesByTimestamp.keys(),
  ]);

  for (const timestamp of [...timestamps].sort()) {
    const timestampDiaries = diariesByTimestamp.get(timestamp) ?? [];
    const timestampSamples = samplesByTimestamp.get(timestamp) ?? [];

    if (timestampDiaries.length > 1 || timestampSamples.length > 1) {
      ambiguousTimestamps.push({
        timestamp,
        diaryIds: timestampDiaries.map((row) => row.id).sort(),
        sampleIds: timestampSamples.map((row) => row.id).sort(),
      });
      continue;
    }

    if (timestampSamples.length === 1 && timestampDiaries.length === 0) {
      const sample = timestampSamples[0];
      sampleMissingTargets.push({
        timestamp,
        sampleId: sample.id,
        currentDiaryId: sample.diaryId,
      });
      continue;
    }

    if (timestampDiaries.length === 1 && timestampSamples.length === 0) {
      const diary = timestampDiaries[0];
      diaryMissingTargets.push({
        timestamp,
        diaryId: diary.id,
        currentSampleIds: (currentSamplesByDiary.get(diary.id) ?? [])
          .map((sample) => sample.id)
          .sort(),
      });
      continue;
    }

    if (timestampSamples.length === 1 && timestampDiaries.length === 1) {
      const sample = timestampSamples[0];
      const diary = timestampDiaries[0];
      if (sample.diaryId === diary.id) {
        healthyLinks.push({ timestamp, sampleId: sample.id, diaryId: diary.id });
        continue;
      }

      const reason = !sample.diaryId
        ? "unlinked"
        : diaryById.has(sample.diaryId)
          ? "timestamp-mismatch"
          : "orphaned-target";
      candidateRepairs.push({
        timestamp,
        sampleId: sample.id,
        diaryId: diary.id,
        previousDiaryId: sample.diaryId,
        reason,
      });
    }
  }

  // Do not attach a diary already occupied by another active sample unless
  // that sample is itself part of a safe deterministic move away. Repeating
  // to a fixed point keeps swaps safe while blocking dependency chains whose
  // final occupant has no timestamp-derived destination.
  const candidateBySample = new Map(candidateRepairs.map((repair) => [repair.sampleId, repair]));
  const safeSampleIds = new Set(candidateBySample.keys());
  let changed = true;
  while (changed) {
    changed = false;
    for (const repair of candidateRepairs) {
      if (!safeSampleIds.has(repair.sampleId)) continue;
      const occupiedByStayingSample = (currentSamplesByDiary.get(repair.diaryId) ?? [])
        .some((sample) => {
          if (sample.id === repair.sampleId) return false;
          const occupantRepair = candidateBySample.get(sample.id);
          return !occupantRepair
            || !safeSampleIds.has(sample.id)
            || occupantRepair.diaryId === repair.diaryId;
        });
      if (occupiedByStayingSample) {
        safeSampleIds.delete(repair.sampleId);
        changed = true;
      }
    }
  }

  const repairableLinks = candidateRepairs
    .filter((repair) => safeSampleIds.has(repair.sampleId))
    .sort(compareByTimestampAndId);
  const blockedRepairs = candidateRepairs
    .filter((repair) => !safeSampleIds.has(repair.sampleId))
    .map((repair) => ({
      ...repair,
      blockingSampleIds: (currentSamplesByDiary.get(repair.diaryId) ?? [])
        .filter((sample) => sample.id !== repair.sampleId && !safeSampleIds.has(sample.id))
        .map((sample) => sample.id)
        .sort(),
    }))
    .sort(compareByTimestampAndId);

  return {
    counts: {
      diaries: diaries.length,
      activeSamples: activeSamples.length,
      healthyLinks: healthyLinks.length,
      repairableLinks: repairableLinks.length,
      sampleMissingTargets: sampleMissingTargets.length,
      diaryMissingTargets: diaryMissingTargets.length,
      ambiguousTimestamps: ambiguousTimestamps.length,
      blockedRepairs: blockedRepairs.length,
    },
    healthyLinks: healthyLinks.sort(compareByTimestampAndId),
    repairableLinks,
    sampleMissingTargets: sampleMissingTargets.sort(compareByTimestampAndId),
    diaryMissingTargets: diaryMissingTargets.sort(compareByTimestampAndId),
    ambiguousTimestamps,
    blockedRepairs,
    invalidTimestamps,
    orphanedCurrentLinks,
    mismatchedCurrentLinks,
    duplicateCurrentTargets,
  };
}
