import { ref, computed, shallowRef, reactive } from "vue";
import type { Message } from "@/entities/chat";
import { isNative } from "@/shared/lib/platform";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import { pinFileUrl, unpinFileUrl } from "./use-file-download";
import {
  cancelPrefetch,
  fetchVoiceUrl,
  findNextVoice,
  prefetchNextVoice,
  type VoiceCursor,
} from "./voice-queue";
import { ensureVoiceWaveform } from "./voice-waveform";
import { claimActivePlayer, releaseActivePlayer } from "@/shared/lib/active-video-player";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "failed";

export interface PlaybackInfo {
  /** Stable key (`_key || id`): playback tracking and the file-cache key. */
  messageId: string;
  roomId: string;
  objectUrl: string;
  duration: number;
  /** `Message.id`: the key of the "listened" mark and the timeline id. */
  listenedId: string;
  timestamp: number;
  senderId: string;
  /** Stored waveform (0-1), for the mini-player. */
  waveform?: number[];
}

/** What the player knows about the current message, for the mini-player and
 *  the auto-advance cursor. */
export type PlaybackMeta = Omit<PlaybackInfo, "objectUrl" | "duration">;

/** Build the player input for a voice message. */
export function playbackInfoFromMessage(message: Message, objectUrl: string, duration: number): PlaybackInfo {
  return {
    messageId: message._key || message.id,
    roomId: message.roomId,
    objectUrl,
    duration,
    listenedId: message.id,
    timestamp: message.timestamp,
    senderId: message.senderId,
    waveform: message.fileInfo?.waveform,
  };
}

// ---------------------------------------------------------------------------
// iOS Silent Mode bypass via AudioContext unlock
// ---------------------------------------------------------------------------
// On iOS WKWebView, HTML5 Audio plays as "ambient" sound — muted by the
// hardware Silent Mode switch. Creating and resuming an AudioContext within
// a user gesture forces the AVAudioSession into playback mode, making all
// subsequent audio (including HTML5 Audio) audible regardless of the switch.
// ---------------------------------------------------------------------------
let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

function getOrCreateAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * Must be called **synchronously** inside a click/tap handler.
 * Plays a 1-sample silent buffer to activate the iOS audio session.
 */
function unlockAudio(): void {
  if (audioUnlocked) return;

  try {
    const ctx = getOrCreateAudioContext();

    // Play a silent buffer to wake up the audio session
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {
        // Resume failed — allow re-attempt on next user gesture
        audioUnlocked = false;
      });
    }

    audioUnlocked = true;
    console.log("[audio] AudioContext unlocked, state:", ctx.state);
  } catch (e) {
    console.warn("[audio] AudioContext unlock failed:", e);
  }
}

// On iOS, backgrounding the app suspends the AudioContext. Re-unlock on foreground
// to restore the playback audio session, otherwise sound silently stops working.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && audioCtx?.state === "suspended") {
      audioUnlocked = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Codec support detection
// ---------------------------------------------------------------------------
const codecCache = new Map<string, boolean>();

function canPlay(mimeType: string): boolean {
  if (codecCache.has(mimeType)) return codecCache.get(mimeType)!;
  const el = document.createElement("audio");
  const result = el.canPlayType(mimeType);
  const ok = result === "probably" || result === "maybe";
  codecCache.set(mimeType, ok);
  return ok;
}

/** Returns codec support map for the current platform. */
export function checkCodecSupport() {
  return {
    mp3: canPlay("audio/mpeg"),
    ogg: canPlay("audio/ogg; codecs=opus"),
    webm: canPlay("audio/webm; codecs=opus"),
    wav: canPlay("audio/wav"),
    aac: canPlay("audio/aac"),
  };
}

// ---------------------------------------------------------------------------
// Global singleton state
// ---------------------------------------------------------------------------
const audio = shallowRef<HTMLAudioElement | null>(null);
const state = ref<PlaybackState>("idle");
const currentMessageId = ref<string | null>(null);
const currentRoomId = ref<string | null>(null);
const currentTime = ref(0);
const duration = ref(0);
const current = shallowRef<PlaybackMeta | null>(null);

const SPEEDS = [1, 1.5, 2];
const PLAYBACK_RATE_KEY = "forta-voice-playback-rate";

function loadPlaybackRate(): number {
  try {
    const saved = Number(localStorage.getItem(PLAYBACK_RATE_KEY));
    return SPEEDS.includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
}

const playbackRate = ref(loadPlaybackRate());

/** Voices the player marked listened in this session. Bubbles read the mark
 *  from Dexie once on mount; this set turns their dot off live, including
 *  bubbles that were not mounted while their voice played in the chain. */
const listenedThisSession = reactive(new Set<string>());

function markListened(listenedId: string) {
  if (listenedThisSession.has(listenedId)) return;
  listenedThisSession.add(listenedId);
  if (!isChatDbReady()) return;
  getChatDb().listened.markListened(listenedId).catch((e) => {
    console.warn("[audio] markListened failed:", e);
  });
}

/** Bumped by every play() and stop(): a pending auto-advance compares it to
 *  know the user acted in the meantime. */
let playGeneration = 0;

function cursorOf(meta: PlaybackMeta): VoiceCursor {
  return { roomId: meta.roomId, timestamp: meta.timestamp, id: meta.listenedId };
}

// Watchdog timeout for the loading → playing transition. encrypted blobs
// occasionally hang `<audio>` such that neither loadedmetadata nor an error
// event fires (issues #695, #671). 8s is long enough for slow Tor / 3G
// pipelines but short enough for the user to retry without confusion.
const LOADING_WATCHDOG_MS = 8_000;
// Heavy encrypted blobs on slow links can still be downloading/decoding when
// the first 8s window elapses — flipping straight to "failed" there is a false
// negative (WEE-62 / forta-bugs#901). When the element is still making progress
// we re-arm the window instead, bounded so a genuinely dead pipeline still
// surfaces a retry button within ~24s.
const MAX_WATCHDOG_REARMS = 2;
// HTMLMediaElement readyState / networkState enum values, inlined as plain
// numbers so the guard doesn't depend on the global existing (test stubs and
// non-DOM contexts don't expose HTMLMediaElement).
const READY_STATE_HAVE_METADATA = 1; // readyState ≥ 1 ⇒ metadata parsed
const NETWORK_STATE_LOADING = 2; // networkState === 2 ⇒ actively fetching bytes
let loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
let watchdogRearms = 0;

function clearLoadingWatchdog() {
  if (loadingWatchdog !== null) {
    clearTimeout(loadingWatchdog);
    loadingWatchdog = null;
  }
  watchdogRearms = 0;
}

/** Arm (or re-arm) the loading watchdog. When it fires, only declare the load
 *  failed if the `<audio>` element has made NO progress — no metadata yet AND
 *  not actively loading bytes. If it is still progressing we grant another
 *  window (bounded by MAX_WATCHDOG_REARMS) so a slow-but-healthy decode is not
 *  mistaken for a hang. */
function armLoadingWatchdog(messageId: string) {
  if (loadingWatchdog !== null) clearTimeout(loadingWatchdog);
  loadingWatchdog = setTimeout(() => {
    loadingWatchdog = null;
    if (state.value !== "loading") return;

    const el = audio.value;
    const stillProgressing =
      !!el &&
      (el.readyState >= READY_STATE_HAVE_METADATA ||
        el.networkState === NETWORK_STATE_LOADING);

    if (stillProgressing && watchdogRearms < MAX_WATCHDOG_REARMS) {
      watchdogRearms++;
      armLoadingWatchdog(messageId);
      return;
    }

    console.warn(
      "[audio] watchdog: loading stalled (no progress), marking failed (msg=" +
        messageId + ")",
    );
    state.value = "failed";
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
      try { el.removeAttribute("src"); } catch { /* ignore */ }
      try { el.load(); } catch { /* ignore */ }
    }
  }, LOADING_WATCHDOG_MS);
}

/** File-cache key pinned for the current message: playback outlives chat
 *  switches, so its blob URL must not be revoked with the chat's media. */
let pinnedKey: string | null = null;

function cleanup() {
  clearLoadingWatchdog();
  if (audio.value) {
    audio.value.pause();
    audio.value.removeAttribute("src");
    audio.value.load();
  }
  if (pinnedKey !== null) {
    unpinFileUrl(pinnedKey);
    pinnedKey = null;
  }
  cancelPrefetch();
  audio.value = null;
  state.value = "idle";
  current.value = null;
  currentMessageId.value = null;
  currentRoomId.value = null;
  currentTime.value = 0;
  duration.value = 0;
}

// The voice's <audio> lives outside the DOM, so the app-wide "one sound at a
// time" listener can't see it — it claims the slot itself (from play(), while
// still loading, and on every `play`), and a video that starts later stops it
// through this handle.
const VOICE_PLAYER = { pause: () => interruptVoicePlayback() };

function setupAudioListeners(el: HTMLAudioElement) {
  el.onplay = () => claimActivePlayer(VOICE_PLAYER);
  el.onpause = () => releaseActivePlayer(VOICE_PLAYER);
  el.ontimeupdate = () => {
    currentTime.value = el.currentTime;
  };
  el.onended = () => {
    state.value = "ended";
    currentTime.value = 0;
    const meta = current.value;
    if (meta) void advanceFrom(meta, playGeneration);
  };
  el.onerror = () => {
    clearLoadingWatchdog();
    const err = el.error;
    console.error("[audio] playback error:", {
      code: err?.code,
      message: err?.message,
      codeName: ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"][err?.code ?? 0],
      networkState: el.networkState,
      readyState: el.readyState,
      src: el.src?.substring(0, 60),
    });
    state.value = "failed";
  };
  el.onloadedmetadata = () => {
    // Metadata parsed — real progress. If we're still in the loading phase
    // (decode/buffer not finished), re-arm a fresh window rather than leaving
    // the load unguarded: a post-metadata decode hang should still surface a
    // retry instead of spinning forever.
    if (state.value === "loading") {
      watchdogRearms = 0;
      armLoadingWatchdog(currentMessageId.value ?? "");
    } else {
      clearLoadingWatchdog();
    }
    // Only update if finite — Chromium reports Infinity for webm blobs
    if (Number.isFinite(el.duration) && el.duration > 0) {
      duration.value = el.duration;
    }
  };

  // Diagnostic listeners (mobile debugging)
  if (isNative) {
    el.onstalled = () => console.warn("[audio] stalled");
    el.onsuspend = () => console.log("[audio] suspend");
    el.onwaiting = () => console.log("[audio] waiting");
    el.onabort = () => console.warn("[audio] abort");
  }
}

/** Auto-advance: after a voice ends, play the next unlistened voice of the same
 *  chat, whether or not that chat is still open. When there is none, the
 *  player goes idle and the mini-player closes. */
async function advanceFrom(meta: PlaybackMeta, generation: number) {
  let next: Message | null = null;
  let url: string | null = null;
  try {
    next = await findNextVoice(cursorOf(meta));
    if (next) url = await fetchVoiceUrl(next);
  } catch (e) {
    console.warn("[audio] auto-advance failed:", e);
  }
  // The user replayed, picked another voice or stopped meanwhile. The
  // generation catches a replay of the same voice still awaiting play(),
  // while the state still reads "ended".
  if (generation !== playGeneration || current.value !== meta || state.value !== "ended") return;
  if (!next || !url) {
    cleanup();
    return;
  }
  await useAudioPlayback().play(playbackInfoFromMessage(next, url, next.fileInfo?.duration ?? 0));
}

/** Another sound source starts (a recording, a preview, a video, a call):
 *  pause the voice, with no auto-resume. A voice still loading, or between
 *  two voices of the chain, is stopped instead — its pending play() would
 *  start the sound anyway. */
export function interruptVoicePlayback(): void {
  if (state.value === "playing" && audio.value) {
    audio.value.pause();
    state.value = "paused";
  } else if (state.value === "loading" || state.value === "ended") {
    playGeneration++;
    cleanup();
  }
}

// Any page media element that becomes audible (MediaViewer, post and feed
// players, an unmuted video circle) stops the voice through the app-wide
// one-sound rule (active-video-player) and VOICE_PLAYER. Calls interrupt it
// separately (VoicePlayerBar).

/** Logout: stop the voice and forget this account's session listened marks,
 *  so the next account's bubbles do not inherit them. */
export function resetAudioPlaybackForLogout() {
  playGeneration++;
  cleanup();
  listenedThisSession.clear();
}

export function useAudioPlayback() {
  const isActive = (messageId: string) =>
    computed(() => currentMessageId.value === messageId);

  const isPlaying = (messageId: string) =>
    computed(() => currentMessageId.value === messageId && state.value === "playing");

  const progress = computed(() => {
    if (duration.value === 0) return 0;
    return currentTime.value / duration.value;
  });

  async function play(info: PlaybackInfo) {
    playGeneration++;
    // Unlock audio session on first play (must be synchronous in user gesture)
    unlockAudio();
    // Take the one-sound slot now, while still loading: a video that starts
    // meanwhile stops this voice instead of being talked over.
    claimActivePlayer(VOICE_PLAYER);

    if (currentMessageId.value === info.messageId && audio.value && state.value === "paused") {
      await audio.value.play();
      state.value = "playing";
      return;
    }
    if (currentMessageId.value === info.messageId && audio.value && state.value === "ended") {
      audio.value.currentTime = 0;
      await audio.value.play();
      state.value = "playing";
      return;
    }
    // Pin before cleanup(): it releases the prefetch pin, which on auto-advance
    // holds this very file — unpinned with its chat closed, the URL would be
    // revoked right before <audio> gets it.
    pinFileUrl(info.messageId);
    cleanup();
    pinnedKey = info.messageId;
    state.value = "loading";
    const meta: PlaybackMeta = {
      messageId: info.messageId,
      roomId: info.roomId,
      listenedId: info.listenedId,
      timestamp: info.timestamp,
      senderId: info.senderId,
      waveform: info.waveform,
    };
    current.value = meta;
    // A voice auto-advanced to has no bubble mounted to decode its waveform.
    ensureVoiceWaveform(info.messageId, info.waveform, info.objectUrl);
    currentMessageId.value = info.messageId;
    currentRoomId.value = info.roomId;
    duration.value = info.duration;

    // Arm a watchdog before the play() promise — if loadedmetadata / error
    // never fires (encrypted blob race, sw cache miss), flip to "failed" so
    // the retry UI surfaces instead of an indefinite spinner. The watchdog
    // re-arms while the element keeps making progress (see armLoadingWatchdog).
    watchdogRearms = 0;
    armLoadingWatchdog(info.messageId);

    try {
      const el = new Audio();
      el.playbackRate = playbackRate.value;
      setupAudioListeners(el);
      audio.value = el;

      // Set src and call play() synchronously — preserves user gesture chain.
      // The browser binds the play() Promise to the current user activation.
      el.src = info.objectUrl;
      await el.play();
      // A newer play() or stop() took over while this one was starting; the
      // watchdog now belongs to it.
      if (current.value !== meta) return;
      clearLoadingWatchdog();
      state.value = "playing";
      // Marked here, not in the bubble: the voice may play with no bubble
      // mounted (auto-advance in a chat that is no longer open).
      markListened(info.listenedId);
      prefetchNextVoice(cursorOf(meta));
    } catch (e: unknown) {
      // Superseded: the cleanup of a newer play() or stop() aborted this one.
      if (current.value !== meta) return;
      clearLoadingWatchdog();
      const err = e as Error;
      console.error("[audio] play() rejected:", err.name, err.message);

      // NotAllowedError = autoplay blocked / user gesture expired
      // NotSupportedError = codec not supported
      if (err.name === "NotAllowedError") {
        console.error("[audio] User gesture likely expired before play(). " +
          "Ensure no async operations between click and play().");
      }
      // If the watchdog already flipped state to "failed", the play() promise
      // rejection that follows is the watchdog's own abort (pause +
      // removeAttribute("src") + load()). Don't open a duplicate bug-report
      // modal in that case — the user already sees the retry UI.
      const playbackState = state.value as PlaybackState;
      if (playbackState !== "failed") {
        useBugReport().open({ context: tRaw("bugReport.ctx.audioPlayback"), error: e });
        state.value = "failed";
      }
    }
  }

  function pause() {
    if (audio.value && state.value === "playing") {
      audio.value.pause();
      state.value = "paused";
    }
  }

  /** Resume the paused voice — for controls that hold no object URL (the
   *  mini-player). */
  async function resume() {
    if (!audio.value || state.value !== "paused") return;
    // Same as play(): re-arms the iOS audio session after backgrounding.
    unlockAudio();
    claimActivePlayer(VOICE_PLAYER);
    try {
      await audio.value.play();
      state.value = "playing";
    } catch (e) {
      console.warn("[audio] resume failed:", e);
    }
  }

  /** Skip to the next voice of the chain, as if the current one ended (the
   *  system "next track" control). The current one stays listened. */
  function playNext() {
    const meta = current.value;
    if (!meta || !audio.value) return;
    if (state.value !== "playing" && state.value !== "paused") return;
    playGeneration++;
    audio.value.pause();
    state.value = "ended";
    currentTime.value = 0;
    void advanceFrom(meta, playGeneration);
  }

  function togglePlay(info: PlaybackInfo) {
    if (currentMessageId.value === info.messageId && state.value === "playing") {
      pause();
    } else {
      play(info);
    }
  }

  function seek(time: number) {
    if (audio.value) {
      audio.value.currentTime = Math.max(0, Math.min(time, duration.value));
      currentTime.value = audio.value.currentTime;
    }
  }

  function seekByRatio(ratio: number) {
    seek(ratio * duration.value);
  }

  function skipForward(seconds = 5) {
    if (audio.value) seek(audio.value.currentTime + seconds);
  }

  function skipBackward(seconds = 5) {
    if (audio.value) seek(audio.value.currentTime - seconds);
  }

  function cycleSpeed() {
    const idx = SPEEDS.indexOf(playbackRate.value);
    playbackRate.value = SPEEDS[(idx + 1) % SPEEDS.length];
    if (audio.value) audio.value.playbackRate = playbackRate.value;
    try {
      localStorage.setItem(PLAYBACK_RATE_KEY, String(playbackRate.value));
    } catch { /* storage unavailable: the speed lasts for the session */ }
  }

  /** Marked listened by the player in this session (see `listenedThisSession`). */
  const wasListened = (listenedId: string) => listenedThisSession.has(listenedId);

  function stop() {
    playGeneration++;
    cleanup();
  }

  return {
    state, current, currentMessageId, currentRoomId, currentTime, duration, playbackRate, progress,
    isActive, isPlaying, wasListened,
    play, pause, resume, playNext, togglePlay, seek, seekByRatio, skipForward, skipBackward, cycleSpeed, stop,
  };
}
