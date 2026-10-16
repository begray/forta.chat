/**
 * File names worth showing to people, and the ones that are not.
 *
 * The Android photo picker and our own temp files hand out names like
 * "bb4dde02-5e74-4fbd-95c7-ef86c….mp4", "1000012345.mp4" or
 * "PXL_20261016_053312345.mp4". Relatives saw the UUID one as the caption
 * of a video (standbyfix6 screenshot). Such names are replaced by "Video"
 * in the event body and hidden in the bubble.
 */

const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const LONG_HEX = /[0-9a-f]{16,}/i;
/** Only digits and separators: "1000012345", "2026-10-16 05.33.12". */
const NUMERIC = /^[\d\s._-]+$/;
/** Camera / screen-recorder / messenger auto names ("VID_20261016_1234",
 *  "PXL_20261016_053312345.TS", "IMG-20261016-WA0003"), and our temp names. */
const AUTO_NAME =
  /^(vid|img|pxl|mvimg|mov|dsc|dcim|screen[_ ]?recording|screenrecorder|record|video|image|photo|file|in|out|in-stage|compressed)([-_ .]*[\da-z]{0,3}\d[\w .-]*)?$/i;

function baseName(name: string): string {
  return name.trim().replace(/\.[a-z0-9]{1,5}$/i, "").trim();
}

/** Would a person recognise this name ("Beach day.mp4"), or is it noise? */
export function isHumanReadableMediaName(name: string | null | undefined): boolean {
  if (!name) return false;
  const base = baseName(name);
  if (!base) return false;
  if (UUID.test(base) || LONG_HEX.test(base)) return false;
  if (NUMERIC.test(base)) return false;
  if (AUTO_NAME.test(base)) return false;
  return /\p{L}/u.test(base);
}

/** The body of an m.video event: the picked name when it means something,
 *  otherwise just "Video". */
export function videoBodyName(name: string | null | undefined): string {
  return name && isHumanReadableMediaName(name) ? name.trim() : "Video";
}

/** The name a media bubble may show under the picture, or null to show none. */
export function displayMediaName(name: string | null | undefined): string | null {
  if (!name || !isHumanReadableMediaName(name)) return null;
  // "Video.mp4", what the body "Video" turns into on the way back.
  if (/^video$/i.test(baseName(name))) return null;
  return name.trim();
}
