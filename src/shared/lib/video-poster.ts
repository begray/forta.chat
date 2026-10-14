/**
 * 1×1 black GIF for `<video poster>` when there is no real preview.
 *
 * Android WebView draws its own grey "play" placeholder on a `<video>` without
 * a poster until the first frame is decoded, and it flashes on every mount.
 * A black pixel, scaled by the element, matches the black frame behind the
 * video instead.
 */
export const BLANK_VIDEO_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=";
