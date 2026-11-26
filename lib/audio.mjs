// lib/audio.mjs — ffprobe/ffmpeg/audiowaveform wrappers shared across scripts.

import { spawn, spawnSync } from "child_process";

export const DEFAULT_WAVEFORM_PIXELS_PER_SECOND = 100;

/** Read duration (seconds) of an audio file via ffprobe. Returns 0 on failure. */
export function getDuration(ffprobeBin, filePath) {
  const r = spawnSync(
    ffprobeBin,
    ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) return 0;
  try {
    const data = JSON.parse(r.stdout);
    return parseFloat(data.format?.duration ?? "0");
  } catch {
    return 0;
  }
}

/**
 * Convert any audio file to WAV via ffmpeg so audiowaveform can read it.
 * Returns true on success, false on failure.
 */
export function convertToWav(inputPath, outputPath) {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outputPath],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    return false;
  }
  return true;
}

/**
 * Convert a WAV file to MP3 with volume boost and ID3 metadata tags.
 * Returns true on success, false on failure.
 *
 * @param {string} ffmpegBin
 * @param {string} inputPath    - source .wav
 * @param {string} outputPath   - destination .mp3
 * @param {object} [opts]
 * @param {number} [opts.volumePct=200]          - output volume as % of input (200 = 2×)
 * @param {number} [opts.bitrate=128]            - MP3 bitrate in kbps
 * @param {object} [opts.metadata={}]
 * @param {string} [opts.metadata.title]
 * @param {string} [opts.metadata.date]          - YYYY-MM-DD (year derived automatically)
 * @param {string} [opts.metadata.datetime]      - ISO local datetime
 * @param {string} [opts.metadata.location]      - e.g. "52.37°N, 4.90°E" or "Backyard, Amsterdam"
 * @param {string} [opts.metadata.direction]     - e.g. "facing north", "towards the street"
 * @param {string} [opts.metadata.artist]        - TPE1 artist tag
 * @param {string} [opts.metadata.album]         - TALB album tag
 * @param {string} [opts.metadata.copyright]     - TCOP copyright tag
 * @param {string} [opts.metadata.appUrl]         - WOAF tag: link back to the Barktown entry
 * @param {string} [opts.metadata.originalFilename]
 */
function mp3Args(inputPath, outputPath, opts = {}) {
  const { volumePct = 200, bitrate = 128, metadata = {} } = opts;
  const volumeFilter = (volumePct / 100).toFixed(6);

  const metaArgs = [];
  if (metadata.title) {
    metaArgs.push("-metadata", `title=${metadata.title}`);
  }
  if (metadata.date) {
    metaArgs.push("-metadata", `date=${metadata.date}`);
    // Standard year tag (TYER/TDRC) derived automatically from the recording date.
    metaArgs.push("-metadata", `year=${metadata.date.slice(0, 4)}`);
  }
  if (metadata.artist) {
    metaArgs.push("-metadata", `artist=${metadata.artist}`);
  }
  if (metadata.album) {
    metaArgs.push("-metadata", `album=${metadata.album}`);
  }
  if (metadata.copyright) {
    metaArgs.push("-metadata", `copyright=${metadata.copyright}`);
  }
  // WOAF — Official Audio File Webpage: links the MP3 back to the Barktown entry.
  if (metadata.appUrl) {
    metaArgs.push("-metadata", `WOAF=${metadata.appUrl}`);
  }
  // Build a human-readable comment with provenance.
  const commentParts = [];
  if (metadata.datetime)         commentParts.push(`Recorded: ${metadata.datetime} local time`);
  if (metadata.location)         commentParts.push(`Location: ${metadata.location}`);
  if (metadata.direction)        commentParts.push(`Direction: ${metadata.direction}`);
  if (metadata.appUrl)           commentParts.push(`Listen: ${metadata.appUrl}`);
  if (metadata.originalFilename) commentParts.push(`Source: ${metadata.originalFilename}`);
  if (commentParts.length > 0) {
    metaArgs.push("-metadata", `comment=${commentParts.join("  ")}`);
  }
  if (metadata.originalFilename) {
    metaArgs.push("-metadata", `TXXX:original_filename=${metadata.originalFilename}`);
  }
  metaArgs.push("-metadata", "encoded_by=Barktown");

  return [
      "-y", "-i", inputPath,
      "-af", `volume=${volumeFilter}`,
      "-codec:a", "libmp3lame",
      "-b:a", `${bitrate}k`,
      "-id3v2_version", "3",
      ...metaArgs,
      outputPath,
    ];
}

export function convertWavToMp3(ffmpegBin, inputPath, outputPath, opts = {}) {
  const r = spawnSync(ffmpegBin, mp3Args(inputPath, outputPath, opts), { encoding: "utf8" });
  return !(r.error || r.status !== 0);
}

/** Keep the private API responsive during long decodes, inference and encoding. */
export function runAudioCommand(bin, args, { timeoutMs = 3600000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} failed (${signal ?? code}): ${stderr}`));
    });
  });
}

export function convertWavToMp3Async(ffmpegBin, inputPath, outputPath, opts = {}) {
  return runAudioCommand(ffmpegBin, mp3Args(inputPath, outputPath, opts));
}

export async function getDurationAsync(ffprobeBin, filePath) {
  const output = await runAudioCommand(ffprobeBin, ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
  const duration = Number(JSON.parse(output).format?.duration);
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('Could not determine audio duration');
  return duration;
}

export function generateWaveformAsync(bin, audioPath, outPath) {
  return runAudioCommand(bin, ['-i', audioPath, '-o', outPath, '--pixels-per-second',
    String(DEFAULT_WAVEFORM_PIXELS_PER_SECOND), '--bits', '16']);
}

/** Generate a waveform peaks JSON file via audiowaveform. Returns true on success. */
export function generateWaveform(
  audiowaveformBin,
  audioPath,
  outPath,
  bits = 8,
  pixelsPerSecond = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
) {
  const r = spawnSync(
    audiowaveformBin,
    ["-i", audioPath, "-o", outPath, "--pixels-per-second", String(pixelsPerSecond), "--bits", String(bits)],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    return false;
  }
  return true;
}
