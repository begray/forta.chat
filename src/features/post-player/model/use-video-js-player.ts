import { onBeforeUnmount } from "vue";
import { getVideoPosition, saveVideoPosition } from "@/shared/lib/video-position-store";

/**
 * The slice of the Video.js 10 player store (`<video-player>.store`) we use.
 * Declared structurally so the lazy Video.js chunk stays out of this module.
 */
export interface VideoJsStore {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly canPlay: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly error: unknown;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<number>;
  subscribe(listener: () => void): () => void;
}

export interface VideoJsPlayerOptions {
  /** Start playback once metadata is in (modal opened by a tap). */
  autoplay?: boolean;
  /** Persist the playback position under this key (WEE-82 / forta-bugs#964). */
  persistKey?: string;
  /** The source will not play — the host switches to its fallback player. */
  onFatalError?: () => void;
}

/** Save the position at most this often while playing. */
const SAVE_INTERVAL_MS = 5000;

/**
 * App-side behaviour around the Video.js player: position memory, autoplay and
 * fatal error hand-off. Android back from fullscreen lives in VideoJsFrame.
 * The player UI and HLS playback are Video.js's own.
 */
export function useVideoJsPlayer(options: VideoJsPlayerOptions = {}) {
  const { autoplay = false, persistKey, onFatalError } = options;

  let store: VideoJsStore | null = null;
  let unsubscribe: (() => void) | null = null;
  let wasPaused = true;
  let started = false;
  // Until the saved position is restored, currentTime (0) is not the user's
  // position — flushing it would erase the saved one.
  let restored = false;
  let failed = false;
  let lastSaveAt = 0;

  function flushPosition(): void {
    if (!persistKey || !store || failed || !restored) return;
    if (store.ended) {
      saveVideoPosition(persistKey, store.duration, store.duration);
      return;
    }
    saveVideoPosition(persistKey, store.currentTime, store.duration || 0);
  }

  function onReady(s: VideoJsStore): void {
    started = true;
    const saved = persistKey ? getVideoPosition(persistKey) : 0;
    const seek = (saved > 0 ? s.seek(saved).catch(() => saved) : Promise.resolve(0)).then(() => {
      restored = true;
    });
    if (!autoplay) return;
    // Autoplay can still be refused (no user activation, e.g. a deep link);
    // the skin's play button stays there for the user.
    void seek.then(() => s.play()).catch((e: unknown) => {
      console.warn("[PeerTubePlayer] autoplay refused:", e);
    });
  }

  function sync(): void {
    const s = store;
    if (!s || failed) return;

    if (s.error) {
      failed = true;
      console.warn("[PeerTubePlayer] playback error:", s.error);
      onFatalError?.();
      return;
    }

    // Metadata, not `canPlay`: with preload="metadata" the HLS element stops
    // after the manifest and never reports canPlay until someone presses play
    // — waiting for it made autoplay a no-op.
    if (!started && (s.duration > 0 || s.canPlay)) onReady(s);

    // One sound at a time is app-wide (active-video-player): <hls-video>
    // re-dispatches its media events, so the document listener sees it.
    if (s.paused !== wasPaused) {
      wasPaused = s.paused;
      if (s.paused) flushPosition();
    }

    if (!s.paused) {
      const now = Date.now();
      if (now - lastSaveAt >= SAVE_INTERVAL_MS) {
        lastSaveAt = now;
        flushPosition();
      }
    }
  }

  function attach(s: VideoJsStore): void {
    detach();
    store = s;
    wasPaused = s.paused;
    unsubscribe = s.subscribe(sync);
    sync();
  }

  function detach(): void {
    flushPosition();
    unsubscribe?.();
    unsubscribe = null;
    store = null;
  }

  // The WebView pauses media on background without a pause event reaching us
  // — flush when the page hides, the "minimize app" moment (WEE-82).
  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") flushPosition();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    detach();
  });

  return { attach, detach };
}
