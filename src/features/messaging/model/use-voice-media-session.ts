import { watch, onScopeDispose, type Ref } from "vue";
import { useAudioPlayback } from "./use-audio-playback";

export interface VoiceMediaInfo {
  /** Sender name. */
  title: string;
  /** Chat name. */
  artist: string;
  artworkUrl?: string;
}

/** Seek step for headset / system controls that send no offset. */
const DEFAULT_SEEK_OFFSET_S = 10;

const ACTIONS: MediaSessionAction[] = [
  "play", "pause", "stop", "seekto", "seekbackward", "seekforward", "nexttrack",
];

function getMediaSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return null;
  return navigator.mediaSession ?? null;
}

/** Expose the voice player to the OS through the Media Session API: media
 *  keys and the system overlay in Electron and Chrome, the lock screen on iOS
 *  15+ WKWebView. Old WebViews have no API, and an action the platform does
 *  not know throws from setActionHandler — every call is guarded. Android
 *  WebView shows no notification from it; that is the native service (stage 6).
 *  `info` is null while nothing plays. */
export function useVoiceMediaSession(info: Ref<VoiceMediaInfo | null>): void {
  const ms = getMediaSession();
  if (!ms) return;
  const playback = useAudioPlayback();

  const handlers: Record<string, MediaSessionActionHandler> = {
    play: () => void playback.resume(),
    pause: () => playback.pause(),
    stop: () => playback.stop(),
    seekto: (d) => {
      if (d.seekTime !== undefined) playback.seek(d.seekTime);
    },
    seekbackward: (d) => playback.skipBackward(d.seekOffset ?? DEFAULT_SEEK_OFFSET_S),
    seekforward: (d) => playback.skipForward(d.seekOffset ?? DEFAULT_SEEK_OFFSET_S),
    nexttrack: () => playback.playNext(),
  };

  const setHandlers = (on: boolean) => {
    for (const action of ACTIONS) {
      try {
        ms.setActionHandler(action, on ? handlers[action] : null);
      } catch { /* action not supported here */ }
    }
  };

  const clear = () => {
    setHandlers(false);
    try {
      ms.metadata = null;
      ms.playbackState = "none";
    } catch { /* ignore */ }
  };

  watch(info, (value) => {
    if (!value) {
      clear();
      return;
    }
    try {
      if (typeof MediaMetadata !== "undefined") {
        ms.metadata = new MediaMetadata({
          title: value.title,
          artist: value.artist,
          artwork: value.artworkUrl ? [{ src: value.artworkUrl }] : [],
        });
      }
    } catch (e) {
      console.warn("[voice-media-session] metadata failed:", e);
    }
    setHandlers(true);
  }, { immediate: true });

  watch(playback.state, (state) => {
    try {
      ms.playbackState = state === "playing" ? "playing" : state === "paused" ? "paused" : "none";
    } catch { /* ignore */ }
  }, { immediate: true });

  // Position for the system scrubber; the OS extrapolates between updates.
  watch([playback.currentTime, playback.duration, playback.playbackRate], ([position, duration, rate]) => {
    if (!ms.setPositionState || !Number.isFinite(duration) || duration <= 0) return;
    try {
      ms.setPositionState({ duration, playbackRate: rate, position: Math.min(position, duration) });
    } catch { /* ignore */ }
  });

  onScopeDispose(clear);
}
