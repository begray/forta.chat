/**
 * Pure helpers for chat-video bubble layout (WEE-36 / forta-bugs#804).
 *
 * Vertical (9:16) videos were rendered with a fixed `aspect-video` (16:9)
 * container, stretching portrait clips into a horizontal letterbox. These
 * helpers compute the bubble width and the container aspect-ratio from the
 * known media dimensions so the original ratio is preserved.
 */

export interface VideoDimensions {
  w: number;
  h: number;
}

const DEFAULT_ASPECT_RATIO = "16 / 9";

/**
 * Choose the best-known video dimensions: prefer upload metadata
 * (`fileInfo.w/h`), fall back to the video element's natural size once
 * `loadedmetadata` has fired.
 */
export function resolveVideoDimensions(
  fileInfo: VideoDimensions | null | undefined,
  natural: VideoDimensions | null | undefined,
): VideoDimensions | null {
  if (fileInfo && fileInfo.w > 0 && fileInfo.h > 0) return { w: fileInfo.w, h: fileInfo.h };
  if (natural && natural.w > 0 && natural.h > 0) return { w: natural.w, h: natural.h };
  return null;
}

/**
 * Inline style for the bubble's video container. Locks aspect-ratio to the
 * original media so portrait clips stay portrait.
 */
export function computeVideoAspectStyle(
  dim: VideoDimensions | null | undefined,
): { aspectRatio: string } {
  if (dim && dim.w > 0 && dim.h > 0) {
    return { aspectRatio: `${dim.w} / ${dim.h}` };
  }
  return { aspectRatio: DEFAULT_ASPECT_RATIO };
}

/** Tallest a chat video may be, as a share of the viewport height. */
export const VIDEO_MAX_HEIGHT_VH = 60;
/** Widest a chat video may be on desktop (md+), in px. */
export const VIDEO_MAX_WIDTH_DESKTOP_PX = 640;

/**
 * CSS width of a chat video bubble. It fills its row (the row is 97% of the
 * chat on mobile) but never so wide that the height — set by the video's
 * ratio — passes 60vh; on desktop it also stops at 640px. Small videos are
 * scaled up to that size, unknown sizes count as 16:9.
 */
export function computeVideoBubbleWidth(
  dim: VideoDimensions | null | undefined,
  isDesktop: boolean,
): string {
  const ratio = dim && dim.w > 0 && dim.h > 0 ? dim.w / dim.h : 16 / 9;
  const byHeight = `calc(${VIDEO_MAX_HEIGHT_VH}vh * ${Number(ratio.toFixed(4))})`;
  return isDesktop
    ? `min(100%, ${byHeight}, ${VIDEO_MAX_WIDTH_DESKTOP_PX}px)`
    : `min(100%, ${byHeight})`;
}
