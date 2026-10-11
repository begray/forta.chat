import { reactive } from "vue";

/** Samples a voice waveform carries (recorded, sent and decoded alike). */
export const WAVEFORM_SAMPLES = 50;

/** Bar height of the placeholder shown until a waveform is known. */
const PLACEHOLDER_HEIGHT = 0.15;
/** Floor for a bar after normalization, so silence still draws a dot. */
const MIN_BAR_HEIGHT = 0.08;

/** Average `src` into `count` buckets. A shorter source is stretched by
 *  repeating its samples. */
export function resampleWaveform(src: number[], count: number): number[] {
  if (src.length === 0 || count <= 0) return [];
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * src.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * src.length) / count));
    let sum = 0;
    for (let j = start; j < end; j++) sum += src[j];
    result.push(sum / (end - start));
  }
  return result;
}

/** A waveform that has a shape. An empty, silent or perfectly flat one draws
 *  a row of equal dots, so the audio is decoded instead. */
export function hasWaveformShape(waveform: number[] | undefined): waveform is number[] {
  if (!waveform || waveform.length < 2) return false;
  const max = Math.max(...waveform);
  const min = Math.min(...waveform);
  return max > 0 && max - min > max * 0.05;
}

/** Bar heights (0-1) for `count` bars; a flat placeholder for no waveform. */
export function waveformBars(waveform: number[] | null, count: number): number[] {
  if (!waveform || waveform.length === 0) return Array(count).fill(PLACEHOLDER_HEIGHT);
  const bars = resampleWaveform(waveform, count);
  const max = Math.max(...bars, 0.01);
  return bars.map((v) => Math.max(MIN_BAR_HEIGHT, v / max));
}

/** Waveforms decoded from the audio, by the stable message key. Shared by the
 *  bubble and the mini-player, and kept across bubble remounts. */
const decoded = reactive(new Map<string, number[]>());
const decoding = new Set<string>();
/** One decode at a time: a chat full of voices must not decode them all at once. */
let decodeQueue: Promise<void> = Promise.resolve();

/** The waveform to draw: the stored one when it has a shape, else the decoded one. */
export function getVoiceWaveform(key: string, stored: number[] | undefined): number[] | null {
  if (hasWaveformShape(stored)) return stored;
  return decoded.get(key) ?? null;
}

/** Decode the waveform from the audio file when the stored one is missing or
 *  flat (other clients, old recordings). No-op once decoded or in flight. */
export function ensureVoiceWaveform(key: string, stored: number[] | undefined, url: string): void {
  if (hasWaveformShape(stored) || decoded.has(key) || decoding.has(key)) return;
  decoding.add(key);
  decodeQueue = decodeQueue.then(async () => {
    try {
      const waveform = await decodeWaveform(url);
      if (waveform) decoded.set(key, waveform);
    } catch (e) {
      console.warn("[voice-waveform] decode failed:", e);
    } finally {
      decoding.delete(key);
    }
  });
}

/** Mean amplitude per sample window. An OfflineAudioContext decodes without
 *  holding the audio output (browsers cap live AudioContexts). */
async function decodeWaveform(url: string): Promise<number[] | null> {
  const Offline = typeof OfflineAudioContext !== "undefined" ? OfflineAudioContext : null;
  const Live = typeof AudioContext !== "undefined" ? AudioContext : null;
  if (!Offline && !Live) return null;

  const data = await (await fetch(url)).arrayBuffer();
  const live = Offline ? null : new Live!();
  const ctx: BaseAudioContext = live ?? new Offline!(1, 1, 44100);
  try {
    const buffer = await ctx.decodeAudioData(data);
    const channel = buffer.getChannelData(0);
    const step = Math.floor(channel.length / WAVEFORM_SAMPLES);
    if (step === 0) return null;
    const samples: number[] = [];
    for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
      let sum = 0;
      for (let j = i * step; j < (i + 1) * step; j++) sum += Math.abs(channel[j]);
      samples.push(sum / step);
    }
    return hasWaveformShape(samples) ? samples : null;
  } finally {
    if (live) void live.close();
  }
}

/** Tests only. */
export function resetVoiceWaveformsForTest(): void {
  decoded.clear();
  decoding.clear();
  decodeQueue = Promise.resolve();
}
