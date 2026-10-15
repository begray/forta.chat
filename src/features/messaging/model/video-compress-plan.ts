/**
 * When to compress a picked video before sending, and at what bitrate.
 * Pure functions; the native side (VideoCompressPlan.kt) mirrors the bitrate
 * maths as a fallback. Design notes: docs/video-compression.md.
 */

/** Videos above this are compressed even when they would fit the server
 *  limit: a 1080p phone clip is ~2 MB/s, and 720p saves most of the data. */
export const COMPRESS_THRESHOLD_BYTES = 15 * 1024 * 1024;

/** Share of the limit left for the MP4 container, encoder overshoot and
 *  encryption padding. */
export const SIZE_MARGIN = 0.1;

export const AUDIO_BITRATE = 128_000;

/** Quality ladder: the first step whose minimum bitrate fits wins. */
export const COMPRESSION_STEPS = [
  { shortSide: 720, minBitrate: 1_000_000, maxBitrate: 2_500_000 },
  { shortSide: 480, minBitrate: 450_000, maxBitrate: 1_200_000 },
] as const;

export interface VideoCompressionPlan {
  shortSide: number;
  videoBitrate: number;
  audioBitrate: number;
}

export type PlanResult =
  | { ok: true; plan: VideoCompressionPlan }
  | { ok: false; reason: "too_long"; maxDurationMs: number }
  | { ok: false; reason: "unknown_duration" };

/** Should this file go through the compressor before it is sent? */
export function shouldCompressVideo(
  file: { size: number; type?: string },
  limitBytes: number,
  thresholdBytes = COMPRESS_THRESHOLD_BYTES,
): boolean {
  if (!(file.type ?? "").startsWith("video/")) return false;
  return file.size > Math.min(thresholdBytes, limitBytes);
}

/** Video bitrate that makes `durationMs` plus audio fit `maxBytes` with the
 *  margin to spare (bit/s, unclamped; may be negative for long videos). */
export function budgetVideoBitrate(durationMs: number, maxBytes: number, audioBitrate = AUDIO_BITRATE): number {
  return (maxBytes * 8 * (1 - SIZE_MARGIN)) / (durationMs / 1000) - audioBitrate;
}

/** Longest video that still fits at the lowest step's minimum bitrate. */
export function maxDurationMs(maxBytes: number, audioBitrate = AUDIO_BITRATE): number {
  const lowest = COMPRESSION_STEPS[COMPRESSION_STEPS.length - 1];
  return Math.floor(((maxBytes * 8 * (1 - SIZE_MARGIN)) / (lowest.minBitrate + audioBitrate)) * 1000);
}

/**
 * Pick the output size and bitrate for a video of `durationMs`.
 * `sourceBitrate` (overall, 0 = unknown) caps the result: re-encoding at a
 * higher bitrate than the source only adds bytes.
 */
export function planVideoCompression(
  durationMs: number,
  maxBytes: number,
  sourceBitrate = 0,
  audioBitrate = AUDIO_BITRATE,
): PlanResult {
  if (!(durationMs > 0)) return { ok: false, reason: "unknown_duration" };
  const budget = budgetVideoBitrate(durationMs, maxBytes, audioBitrate);
  for (const step of COMPRESSION_STEPS) {
    if (budget < step.minBitrate) continue;
    let videoBitrate = Math.min(budget, step.maxBitrate);
    if (sourceBitrate > 0) videoBitrate = Math.min(videoBitrate, Math.max(step.minBitrate, sourceBitrate - audioBitrate));
    return { ok: true, plan: { shortSide: step.shortSide, videoBitrate: Math.floor(videoBitrate), audioBitrate } };
  }
  return { ok: false, reason: "too_long", maxDurationMs: maxDurationMs(maxBytes, audioBitrate) };
}

/**
 * Bitrate for the one retry after an output came out too big: scale by how
 * much it overshot, with a further 10 %. Null when that drops below the
 * lowest step's minimum.
 */
export function retryBitrate(previousBitrate: number, outputBytes: number, maxBytes: number): number | null {
  const next = Math.floor(previousBitrate * (maxBytes / outputBytes) * 0.9);
  const floor = COMPRESSION_STEPS[COMPRESSION_STEPS.length - 1].minBitrate;
  return next >= floor ? next : null;
}
