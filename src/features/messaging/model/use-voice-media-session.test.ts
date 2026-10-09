// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { effectScope, ref, nextTick, type EffectScope } from "vue";

const state = ref("idle");
const currentTime = ref(0);
const duration = ref(0);
const playbackRate = ref(1);
const playback = {
  state, currentTime, duration, playbackRate,
  resume: vi.fn(), pause: vi.fn(), stop: vi.fn(), seek: vi.fn(),
  skipBackward: vi.fn(), skipForward: vi.fn(), playNext: vi.fn(),
};
vi.mock("./use-audio-playback", () => ({ useAudioPlayback: () => playback }));

const { useVoiceMediaSession } = await import("./use-voice-media-session");

type Handler = ((d: MediaSessionActionDetails) => void) | null;

function makeSession() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    metadata: null as unknown,
    playbackState: "none",
    setActionHandler: vi.fn((action: string, h: Handler) => {
      if (action === "seekforward" && h) throw new Error("not supported");
      handlers.set(action, h);
    }),
    setPositionState: vi.fn(),
  };
}

class FakeMediaMetadata {
  constructor(public init: Record<string, unknown>) {}
}

describe("useVoiceMediaSession", () => {
  let session: ReturnType<typeof makeSession>;
  let scope: EffectScope;

  beforeEach(() => {
    vi.clearAllMocks();
    state.value = "idle";
    duration.value = 0;
    currentTime.value = 0;
    session = makeSession();
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
  });

  it("sets metadata and handlers while a voice is active, and clears them after", async () => {
    const info = ref<{ title: string; artist: string; artworkUrl?: string } | null>(null);
    scope.run(() => useVoiceMediaSession(info));
    expect(session.metadata).toBeNull();

    info.value = { title: "Alice", artist: "Team", artworkUrl: "https://x/a.png" };
    await nextTick();
    expect((session.metadata as FakeMediaMetadata).init).toEqual({
      title: "Alice", artist: "Team", artwork: [{ src: "https://x/a.png" }],
    });
    expect(session.handlers.get("play")).toBeTypeOf("function");

    info.value = null;
    await nextTick();
    expect(session.metadata).toBeNull();
    expect(session.handlers.get("play")).toBeNull();
  });

  it("routes system actions to the player; an unsupported action does not break the rest", async () => {
    scope.run(() => useVoiceMediaSession(ref({ title: "A", artist: "B" })));
    const call = (a: string, d: Partial<MediaSessionActionDetails> = {}) =>
      session.handlers.get(a)?.({ action: a, ...d } as MediaSessionActionDetails);

    call("play");
    call("pause");
    call("seekto", { seekTime: 12 });
    call("seekbackward");
    call("nexttrack");
    call("stop");

    expect(playback.resume).toHaveBeenCalled();
    expect(playback.pause).toHaveBeenCalled();
    expect(playback.seek).toHaveBeenCalledWith(12);
    expect(playback.skipBackward).toHaveBeenCalledWith(10);
    expect(playback.playNext).toHaveBeenCalled();
    expect(playback.stop).toHaveBeenCalled();
  });

  it("mirrors playback state and position", async () => {
    scope.run(() => useVoiceMediaSession(ref({ title: "A", artist: "B" })));
    state.value = "playing";
    duration.value = 30;
    currentTime.value = 5;
    await nextTick();
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 30, playbackRate: 1, position: 5 });

    state.value = "paused";
    await nextTick();
    expect(session.playbackState).toBe("paused");
  });

  it("skips the position while the duration is unknown (webm reports Infinity)", async () => {
    scope.run(() => useVoiceMediaSession(ref({ title: "A", artist: "B" })));
    duration.value = Infinity;
    currentTime.value = 3;
    await nextTick();
    expect(session.setPositionState).not.toHaveBeenCalled();
  });

  it("is a no-op without the API (old WebView)", () => {
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: undefined });
    expect(() => scope.run(() => useVoiceMediaSession(ref({ title: "A", artist: "B" })))).not.toThrow();
  });
});
