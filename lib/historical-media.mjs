import path from 'node:path';
import { runAudioCommand, getDurationAsync, convertWavToMp3Async, generateWaveformAsync } from './audio.mjs';
import { historicalMp3Metadata } from './historical-recordings.mjs';

export async function decodeHistoricalSource(cfg, input, wav) {
  await runAudioCommand(cfg.ffmpegBin, ['-v', 'error', '-y', '-i', input,
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  return getDurationAsync(cfg.ffprobeBin, wav);
}

/** Shared media generation for Pi imports and external workers. */
export async function createHistoricalClipMedia({ cfg, clip, entry, archiveKey, wav, directory }) {
  const clipWav = path.join(directory, 'clip.wav');
  const mp3 = path.join(directory, 'clip.mp3');
  const waveform = path.join(directory, 'clip.json');
  await runAudioCommand(cfg.ffmpegBin, ['-v', 'error', '-y', '-ss', String(clip.start), '-i', wav,
    '-t', String(clip.durationSec), '-c:a', 'pcm_s16le', clipWav]);
  await convertWavToMp3Async(cfg.ffmpegBin, clipWav, mp3, {
    volumePct: cfg.wavVolumeBoostPct, bitrate: cfg.wavMp3Bitrate,
    metadata: historicalMp3Metadata({ ...clip, label: entry.label }, cfg, archiveKey),
  });
  await generateWaveformAsync(cfg.audiowaveformBin, clipWav, waveform);
  return [
    { path: clipWav, key: clip.sourceWavPath, extension: 'wav', contentType: 'audio/wav' },
    { path: mp3, key: clip.audioPath, extension: 'mp3', contentType: 'audio/mpeg' },
    { path: waveform, key: clip.waveformPath, extension: 'json', contentType: 'application/json' },
  ];
}

export function historicalStagingFiles(jobId, clips) {
  return clips.flatMap((clip, index) => [
    { key: clip.sourceWavPath, extension: 'wav', contentType: 'audio/wav' },
    { key: clip.audioPath, extension: 'mp3', contentType: 'audio/mpeg' },
    { key: clip.waveformPath, extension: 'json', contentType: 'application/json' },
  ].map(file => ({ ...file, clipIndex: index,
    stagingKey: `historical-import-staging/${jobId}/${index}.${file.extension}` })));
}
