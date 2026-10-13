/**
 * Lazy loader for the Video.js 10 player (`<media-i18n>`, `<video-player>`,
 * `<forta-video-skin>`, `<hls-video>`; a plain `<video>` works inside the skin
 * too). Its chunk (~180 KB gzip) stays out of the
 * startup bundle and is only fetched when a PeerTube video is about to play. Call
 * `canUseModernPlayer()` first — an old WebView must never parse this chunk.
 */
const importVideoJs = () =>
  Promise.all([
    import("@videojs/html/video/player"),
    // Our subclass of the packaged skin; it brings the skin (and its
    // shadow-root styles) along.
    import("./forta-video-skin"),
    import("@videojs/html/media/hls-video"),
    // The skin also defines <media-i18n>, which gives the controls inside it
    // their language. English is built in; Russian is registered up front so
    // it doesn't need a second lazy fetch.
    import("@videojs/html/i18n/locales/ru/register"),
  ]);

/** One shared load per app run; a failed load can be retried. Exported for tests. */
export function createVideoJsLoader(importModules: () => Promise<unknown>): () => Promise<void> {
  let loading: Promise<void> | null = null;
  return () => {
    if (!loading) {
      loading = importModules().then(
        () => undefined,
        (e: unknown) => {
          // A failed chunk fetch (offline, deploy swapped hashes) must be
          // retryable on the next open, not cached forever.
          loading = null;
          throw e;
        },
      );
    }
    return loading;
  };
}

export const loadVideoJs = createVideoJsLoader(importVideoJs);
