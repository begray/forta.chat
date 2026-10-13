/**
 * Can this WebView run the Video.js 10 HLS player?
 *
 * Video.js 10 targets Chrome 111 / Safari 16.4: its skin needs `@layer`,
 * `:has()`, container queries and `oklch()`, its elements need Custom Elements
 * and constructable stylesheets. Our floor is Android 7 WebView and iOS 15, so
 * anything older keeps the plain `<video>` player (FeedVideoPlayer). The chunk
 * is only imported after this check passes — an old engine never parses it.
 */
let cached: boolean | null = null;

/** The answer can't change during a session — probed once (chat lists ask per bubble). */
export function canUseModernPlayer(): boolean {
  if (cached === null) cached = probeModernPlayer();
  return cached;
}

/** Exported for test cleanup only. */
export function _resetModernPlayerSupport(): void {
  cached = null;
}

function probeModernPlayer(): boolean {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    if (typeof customElements === "undefined") return false;
    if (!Array.isArray((document as Document & { adoptedStyleSheets?: unknown }).adoptedStyleSheets)) {
      return false;
    }

    const css = window.CSS;
    if (!css || typeof css.supports !== "function") return false;
    if (!css.supports("selector(:has(a))")) return false;
    if (!css.supports("container-type: inline-size")) return false;
    if (!css.supports("color", "oklch(0 0 0)")) return false;

    return canPlayHls();
  } catch {
    return false;
  }
}

/** HLS through Media Source Extensions, or natively (Safari / WKWebView). */
function canPlayHls(): boolean {
  const w = window as Window & { MediaSource?: unknown; ManagedMediaSource?: unknown };
  if (typeof w.MediaSource === "function" || typeof w.ManagedMediaSource === "function") {
    return true;
  }
  const video = document.createElement("video");
  return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}
