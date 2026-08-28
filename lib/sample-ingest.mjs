// Pure routing rules for manual training samples entering through upload-here/.

import { parseSampleFilename } from "./filenames.mjs";
import { SAMPLE_LABELS } from "./sample-labels.mjs";

export function planSampleIngest(filename, cfg) {
  const parsed = parseSampleFilename(filename);
  if (!parsed) return null;
  if (!SAMPLE_LABELS.includes(parsed.label)) {
    return { parsed, error: `unknown sample label: ${parsed.label}` };
  }
  return {
    parsed,
    audioPath: `${cfg.samplesPrefix}${parsed.label}/${filename}`,
    waveformPath: `${cfg.samplesWavePrefix}${parsed.label}/${parsed.id}.json`,
  };
}
