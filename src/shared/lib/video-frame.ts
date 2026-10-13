/**
 * Video container geometry from the video's aspect ratio (width / height).
 *
 * Two modes: vertical (ratio < 0.9 — phone clips) and horizontal. The
 * container takes the full width with the video's own ratio; a vertical one
 * is capped in height so it never runs past the window it sits in. Whatever
 * the cap or the clamp below cuts off, the video fills with black bars
 * (`object-fit: contain`) — on the sides when capped, top and bottom for an
 * ultra-wide clip.
 */
export type VideoOrientation = "vertical" | "horizontal";

/** Below this ratio a video is vertical. */
export const VERTICAL_RATIO = 0.9;

const DEFAULT_RATIO = 16 / 9;
/** Containers stay within 9:21 … 21:9; more extreme clips get bars. */
const MIN_RATIO = 9 / 21;
const MAX_RATIO = 21 / 9;

function isValidRatio(ratio: number | null | undefined): ratio is number {
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0;
}

export function videoOrientation(ratio: number | null | undefined): VideoOrientation {
  return isValidRatio(ratio) && ratio < VERTICAL_RATIO ? "vertical" : "horizontal";
}

export interface VideoFrame {
  orientation: VideoOrientation;
  /** Tailwind classes for the container (add your own radius/background). */
  class: string;
  style: { aspectRatio: string };
}

export function videoFrame(ratio: number | null | undefined): VideoFrame {
  const value = isValidRatio(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : DEFAULT_RATIO;
  const orientation = videoOrientation(ratio);
  return {
    orientation,
    class: orientation === "vertical" ? "w-full max-h-[70vh]" : "w-full",
    style: { aspectRatio: String(Number(value.toFixed(4))) },
  };
}
