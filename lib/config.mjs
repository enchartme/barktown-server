// lib/config.mjs — shared configuration for ingest-service, migration and
// maintenance scripts.
//
// Call buildConfig() *after* loadEnv() (see lib/env.mjs) so CLI scripts that
// load a .env file pick up overrides; under systemd, EnvironmentFile already
// populates process.env before the process starts, so buildConfig() alone
// is sufficient there.

export function buildConfig() {
  return {
    minio: {
      endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
      port: parseInt(process.env.MINIO_PORT ?? "9000", 10),
      useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
      accessKey: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
      secretKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
    },
    bucket: process.env.MINIO_BUCKET ?? "barktown",

    newPrefix: "upload-here/",
    archivePrefix: "uncompressed-uploads-archive/",
    audioPrefix: "audio/",
    waveformPrefix: "waveforms/",
    indexKey: "index.json",

    samplesPrefix: "training-samples/",
    samplesWavePrefix: "training-samples-waveforms/",
    samplesIndexKey: "training-samples-index.json",

    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "20000", 10),
    stabilityDelayMs: parseInt(process.env.STABILITY_DELAY_MS ?? "30000", 10),

    ffprobeBin: process.env.FFPROBE_BIN ?? "ffprobe",
    ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
    audiowaveformBin: process.env.AUDIOWAVEFORM_BIN ?? "audiowaveform",
    waveformThreshSec: parseFloat(process.env.WAVEFORM_THRESHOLD_SEC ?? "5"),

    // WAV-to-MP3 pre-processing (applied to .wav files landing in upload-here/).
    // wavVolumeBoostPct: 200 = 2× amplitude (6 dB louder).  Set to 100 to skip.
    wavVolumeBoostPct: parseInt(process.env.WAV_VOLUME_BOOST_PCT ?? "200", 10),
    wavMp3Bitrate: parseInt(process.env.WAV_MP3_BITRATE ?? "128", 10),

    // ID3 tags embedded in every converted MP3.
    // recordingLocation / recordingDirection appear in the comment tag and a
    // TXXX provenance field.  artist, album, copyright are standard music tags.
    // Year is derived automatically from the recording date.
    recordingLocation:  process.env.RECORDING_LOCATION  ?? "",
    recordingDirection: process.env.RECORDING_DIRECTION ?? "",
    recordingArtist:    process.env.RECORDING_ARTIST    ?? "",
    recordingAlbum:     process.env.RECORDING_ALBUM     ?? "",
    recordingCopyright: process.env.RECORDING_COPYRIGHT ?? "",

    // Base URL of the Barktown web app — embedded as a WOAF (Official Audio File
    // Webpage) ID3 tag so opening the file in a player shows a clickable link.
    // The full entry URL is built as: barktownUrl + '/#' + entryId
    barktownUrl: process.env.BARKTOWN_URL ?? "https://barktown.enchart.me",

    // Local SQLite database — metadata store for training samples (and,
    // later, the full recordings corpus). Not uploaded to MinIO.
    dbPath: process.env.DB_PATH ?? "./data/barktown.db",

    // "Re-analyze" feature: spawns barktown-utils' tools/reanalyze_clip.py
    // as a subprocess to re-score a diary clip's archived source WAV with
    // YAMNet + the bark classifier, then upserts the result into
    // hit_metadata. Assumes barktown-utils is checked out next to this repo
    // unless overridden. Detection tuning (candidate_threshold etc.) is NOT
    // configured here — it lives in the monitor_params DB table (single
    // source of truth shared with barktown-goblin's live monitor), see
    // lib/db.mjs's getMonitorParamsMap() and the /api/monitor-params routes.
    reanalyze: {
      pythonBin: process.env.REANALYZE_PYTHON_BIN ?? "python3",
      scriptPath: process.env.REANALYZE_SCRIPT_PATH
        ?? new URL("../../barktown-utils/tools/reanalyze_clip.py", import.meta.url).pathname,
      modelDir: process.env.REANALYZE_MODEL_DIR
        ?? new URL("../../barktown-utils/models", import.meta.url).pathname,
      timeoutMs: parseInt(process.env.REANALYZE_TIMEOUT_MS ?? "300000", 10),
    },
  };
}
