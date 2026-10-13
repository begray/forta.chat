// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

// Mock platform detection
vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isIOS: false,
  isAndroid: false,
  isElectron: false,
  isWeb: true,
}));

// Mock bug-report so we can assert that the watchdog path doesn't fire it.
const mockBugReportOpen = vi.fn();
vi.mock("@/features/bug-report", () => ({
  useBugReport: () => ({ open: mockBugReportOpen }),
}));

// Mock i18n to keep error-context lookups deterministic.
vi.mock("@/shared/lib/i18n", () => ({
  tRaw: (k: string) => k,
}));

// Blob-URL pinning lives in the file-download module (heavy imports).
const mockPinFileUrl = vi.fn();
const mockUnpinFileUrl = vi.fn();
vi.mock("./use-file-download", () => ({
  pinFileUrl: (key: string) => mockPinFileUrl(key),
  unpinFileUrl: (key: string) => mockUnpinFileUrl(key),
}));

// Auto-advance queue (Dexie + downloads) and the listened store.
const mockFindNextVoice = vi.fn();
const mockFetchVoiceUrl = vi.fn();
const mockPrefetchNextVoice = vi.fn();
const mockCancelPrefetch = vi.fn();
vi.mock("./voice-queue", () => ({
  findNextVoice: (...a: unknown[]) => mockFindNextVoice(...a),
  fetchVoiceUrl: (...a: unknown[]) => mockFetchVoiceUrl(...a),
  prefetchNextVoice: (...a: unknown[]) => mockPrefetchNextVoice(...a),
  cancelPrefetch: () => mockCancelPrefetch(),
}));

const mockMarkListened = vi.fn(() => Promise.resolve());
vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: () => true,
  getChatDb: () => ({ listened: { markListened: mockMarkListened } }),
}));

// --- Mock Audio (must use regular function for `new` operator) ---
const mockPlay = vi.fn(() => Promise.resolve());
const mockPause = vi.fn();
const mockLoad = vi.fn();
const mockRemoveAttribute = vi.fn();

let lastAudio: Record<string, unknown>;

vi.stubGlobal("Audio", vi.fn(function MockAudio(this: Record<string, unknown>) {
  this.play = mockPlay;
  this.pause = mockPause;
  this.load = mockLoad;
  this.removeAttribute = mockRemoveAttribute;
  this.src = "";
  this.currentTime = 0;
  this.duration = 10;
  this.playbackRate = 1;
  this.paused = true;
  this.muted = false;
  this.volume = 1;
  this.error = null;
  this.networkState = 0;
  this.readyState = 0;
  this.ontimeupdate = null;
  this.onended = null;
  this.onerror = null;
  this.onloadedmetadata = null;
  this.onstalled = null;
  this.onsuspend = null;
  this.onwaiting = null;
  this.onabort = null;
  lastAudio = this;
}));

// --- Mock AudioContext (must use regular function for `new`) ---
const mockCtxStart = vi.fn();
const mockCtxConnect = vi.fn();
const mockCtxResume = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal("AudioContext", vi.fn(function MockAudioContext(this: Record<string, unknown>) {
  this.state = "running";
  this.resume = mockCtxResume;
  this.createBuffer = vi.fn(() => ({}));
  this.createBufferSource = vi.fn(() => ({
    buffer: null,
    connect: mockCtxConnect,
    start: mockCtxStart,
  }));
  this.destination = {};
}));

// Import AFTER mocks are set up
import {
  useAudioPlayback,
  checkCodecSupport,
  resetAudioPlaybackForLogout,
  interruptVoicePlayback,
} from "./use-audio-playback";

const baseInfo = {
  messageId: "msg-1",
  roomId: "room-1",
  objectUrl: "blob:http://localhost/abc",
  duration: 10,
  listenedId: "$msg-1",
  timestamp: 1000,
  senderId: "peer",
};

/** Let the auto-advance chain (awaits on mocked promises) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useAudioPlayback", () => {
  let playback: ReturnType<typeof useAudioPlayback>;

  beforeEach(() => {
    playback = useAudioPlayback();
    playback.stop();
    mockPlay.mockClear();
    mockPlay.mockImplementation(() => Promise.resolve());
    mockPause.mockClear();
    mockLoad.mockClear();
    mockRemoveAttribute.mockClear();
    (Audio as unknown as Mock).mockClear();
  });

  describe("play()", () => {
    it("should transition to playing state on successful play", async () => {
      await playback.play(baseInfo);

      expect(playback.state.value).toBe("playing");
      expect(playback.currentMessageId.value).toBe("msg-1");
      expect(playback.currentRoomId.value).toBe("room-1");
    });

    it("should set src on Audio element before calling play()", async () => {
      await playback.play(baseInfo);

      expect(Audio).toHaveBeenCalled();
      expect(lastAudio.src).toBe("blob:http://localhost/abc");
      expect(mockPlay).toHaveBeenCalled();
    });

    it("should unlock AudioContext on first play", async () => {
      // AudioContext is created during the first play() call
      await playback.play(baseInfo);

      expect(AudioContext).toHaveBeenCalled();
    });

    it("should set failed state when play() rejects with NotAllowedError", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockPlay.mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));

      await playback.play(baseInfo);

      expect(playback.state.value).toBe("failed");
      consoleSpy.mockRestore();
    });

    it("should resume from paused state without creating new Audio", async () => {
      await playback.play(baseInfo);
      playback.pause();
      expect(playback.state.value).toBe("paused");

      const callCountBefore = (Audio as unknown as Mock).mock.calls.length;
      await playback.play(baseInfo);

      expect(playback.state.value).toBe("playing");
      expect((Audio as unknown as Mock).mock.calls.length).toBe(callCountBefore);
    });

    it("should restart from ended state", async () => {
      await playback.play(baseInfo);

      // Simulate ended event
      const onended = lastAudio.onended as (() => void) | null;
      onended?.();
      expect(playback.state.value).toBe("ended");

      await playback.play(baseInfo);
      expect(playback.state.value).toBe("playing");
      expect(lastAudio.currentTime).toBe(0);
    });

    it("should cleanup previous audio when playing a different message", async () => {
      await playback.play(baseInfo);

      await playback.play({ ...baseInfo, messageId: "msg-2" });

      expect(mockPause).toHaveBeenCalled();
      expect(mockRemoveAttribute).toHaveBeenCalledWith("src");
      expect(playback.currentMessageId.value).toBe("msg-2");
    });
  });

  describe("pause()", () => {
    it("should pause and set paused state", async () => {
      await playback.play(baseInfo);
      playback.pause();

      expect(mockPause).toHaveBeenCalled();
      expect(playback.state.value).toBe("paused");
    });

    it("should do nothing when not playing", () => {
      playback.pause();
      expect(playback.state.value).not.toBe("paused");
    });
  });

  describe("togglePlay()", () => {
    it("should pause if currently playing same message", async () => {
      await playback.play(baseInfo);
      playback.togglePlay(baseInfo);

      expect(playback.state.value).toBe("paused");
    });
  });

  describe("seek()", () => {
    it("should clamp seek within valid range", async () => {
      await playback.play(baseInfo);
      playback.duration.value = 10;

      playback.seek(-5);
      expect(lastAudio.currentTime).toBe(0);

      playback.seek(15);
      expect(lastAudio.currentTime).toBe(10);

      playback.seek(5);
      expect(lastAudio.currentTime).toBe(5);
    });
  });

  describe("seekByRatio()", () => {
    it("should seek to correct position based on ratio", async () => {
      await playback.play(baseInfo);
      playback.duration.value = 20;

      playback.seekByRatio(0.5);
      expect(lastAudio.currentTime).toBe(10);
    });
  });

  describe("cycleSpeed()", () => {
    it("should cycle through 1 -> 1.5 -> 2 -> 1", async () => {
      await playback.play(baseInfo);

      expect(playback.playbackRate.value).toBe(1);
      playback.cycleSpeed();
      expect(playback.playbackRate.value).toBe(1.5);
      playback.cycleSpeed();
      expect(playback.playbackRate.value).toBe(2);
      playback.cycleSpeed();
      expect(playback.playbackRate.value).toBe(1);
    });

    it("should apply playbackRate to audio element", async () => {
      await playback.play(baseInfo);
      playback.cycleSpeed();
      expect(lastAudio.playbackRate).toBe(1.5);
    });
  });

  describe("auto-advance (voice queue)", () => {
    const nextMessage = {
      id: "$msg-2",
      _key: "msg-2",
      roomId: "room-1",
      senderId: "peer",
      timestamp: 2000,
      fileInfo: { duration: 7 },
    };

    beforeEach(() => {
      mockFindNextVoice.mockReset();
      mockFetchVoiceUrl.mockReset();
      mockPrefetchNextVoice.mockClear();
      mockMarkListened.mockClear();
    });

    it("plays the next voice of the same chat when the current one ends", async () => {
      mockFindNextVoice.mockResolvedValue(nextMessage);
      mockFetchVoiceUrl.mockResolvedValue("blob:next");
      await playback.play(baseInfo);

      (lastAudio.onended as () => void)();
      await flush();

      expect(mockFindNextVoice).toHaveBeenCalledWith({ roomId: "room-1", timestamp: 1000, id: "$msg-1" });
      expect(playback.currentMessageId.value).toBe("msg-2");
      expect(playback.state.value).toBe("playing");
      expect(playback.current.value).toMatchObject({ listenedId: "$msg-2", timestamp: 2000 });
      expect(lastAudio.src).toBe("blob:next");
    });

    it("pins the next file before releasing the prefetch pin that holds it", async () => {
      mockFindNextVoice.mockResolvedValue(nextMessage);
      mockFetchVoiceUrl.mockResolvedValue("blob:next");
      await playback.play(baseInfo);
      mockPinFileUrl.mockClear();
      mockCancelPrefetch.mockClear();

      (lastAudio.onended as () => void)();
      await flush();

      const pinOrder = mockPinFileUrl.mock.invocationCallOrder[0];
      const cancelOrder = mockCancelPrefetch.mock.invocationCallOrder[0];
      expect(mockPinFileUrl).toHaveBeenCalledWith("msg-2");
      expect(pinOrder).toBeLessThan(cancelOrder);
    });

    it("a replay of the ended voice wins over a pending auto-advance", async () => {
      let resolveNext: (m: unknown) => void = () => {};
      mockFindNextVoice.mockReturnValue(new Promise((r) => { resolveNext = r; }));
      mockFetchVoiceUrl.mockResolvedValue("blob:next");
      await playback.play(baseInfo);
      const first = lastAudio;
      (first.onended as () => void)();

      // Replay the same voice; its play() is still pending while the
      // advance resolves (state still reads "ended").
      let finishReplay: () => void = () => {};
      mockPlay.mockReturnValueOnce(new Promise<void>((r) => { finishReplay = r; }));
      const replay = playback.play(baseInfo);
      resolveNext(nextMessage);
      await flush();
      finishReplay();
      await replay;

      expect(playback.currentMessageId.value).toBe("msg-1");
      expect(playback.state.value).toBe("playing");
      expect(lastAudio).toBe(first);
    });

    it("playNext (system next-track) skips to the next voice of the chain", async () => {
      mockFindNextVoice.mockResolvedValue(nextMessage);
      mockFetchVoiceUrl.mockResolvedValue("blob:next");
      await playback.play(baseInfo);

      playback.playNext();
      await flush();

      expect(mockPause).toHaveBeenCalled();
      expect(playback.currentMessageId.value).toBe("msg-2");
      expect(playback.state.value).toBe("playing");
    });

    it("logout reset stops playback and forgets the session listened marks", async () => {
      await playback.play({ ...baseInfo, messageId: "lo", listenedId: "$lo" });
      expect(playback.wasListened("$lo")).toBe(true);
      resetAudioPlaybackForLogout();
      expect(playback.state.value).toBe("idle");
      expect(playback.wasListened("$lo")).toBe(false);
    });

    it("goes idle at the end of the chain", async () => {
      mockFindNextVoice.mockResolvedValue(null);
      await playback.play(baseInfo);

      (lastAudio.onended as () => void)();
      await flush();

      expect(playback.state.value).toBe("idle");
      expect(playback.current.value).toBeNull();
    });

    it("does not advance when the user picked another voice meanwhile", async () => {
      let resolveNext: (m: unknown) => void = () => {};
      mockFindNextVoice.mockReturnValue(new Promise((r) => { resolveNext = r; }));
      mockFetchVoiceUrl.mockResolvedValue("blob:next");
      await playback.play(baseInfo);
      (lastAudio.onended as () => void)();

      await playback.play({ ...baseInfo, messageId: "msg-9", listenedId: "$msg-9" });
      resolveNext(nextMessage);
      await flush();

      expect(playback.currentMessageId.value).toBe("msg-9");
    });

    it("marks the voice listened when it starts playing, with no bubble involved", async () => {
      expect(playback.wasListened("$fresh")).toBe(false);
      await playback.play({ ...baseInfo, messageId: "fresh", listenedId: "$fresh" });
      expect(mockMarkListened).toHaveBeenCalledWith("$fresh");
      expect(playback.wasListened("$fresh")).toBe(true);
    });

    it("prefetches the next voice once playback starts", async () => {
      await playback.play(baseInfo);
      expect(mockPrefetchNextVoice).toHaveBeenCalledWith({ roomId: "room-1", timestamp: 1000, id: "$msg-1" });
    });

    it("cancels the prefetch on stop", async () => {
      await playback.play(baseInfo);
      mockCancelPrefetch.mockClear();
      playback.stop();
      expect(mockCancelPrefetch).toHaveBeenCalled();
    });
  });

  describe("other sound sources", () => {
    it("interrupt pauses a playing voice and does not resume it", async () => {
      await playback.play(baseInfo);
      interruptVoicePlayback();
      expect(playback.state.value).toBe("paused");
      expect(mockPause).toHaveBeenCalled();
    });

    it("interrupt stops a voice that is still loading", async () => {
      mockPlay.mockReturnValueOnce(new Promise(() => {}));
      void playback.play(baseInfo);
      expect(playback.state.value).toBe("loading");
      interruptVoicePlayback();
      expect(playback.state.value).toBe("idle");
    });

    it("interrupt between two chained voices cancels the advance", async () => {
      let resolveNext: (m: unknown) => void = () => {};
      mockFindNextVoice.mockReturnValue(new Promise((r) => { resolveNext = r; }));
      mockFetchVoiceUrl.mockResolvedValue("blob:next");
      await playback.play(baseInfo);
      (lastAudio.onended as () => void)();

      interruptVoicePlayback();
      resolveNext({ id: "$msg-2", _key: "msg-2", roomId: "room-1", senderId: "peer", timestamp: 2000 });
      await flush();
      expect(playback.state.value).toBe("idle");
    });

    it("an audible page video starting playback pauses the voice", async () => {
      await playback.play(baseInfo);
      const video = document.createElement("video");
      document.body.appendChild(video);
      video.dispatchEvent(new Event("play"));
      expect(playback.state.value).toBe("paused");
      video.remove();
    });

    it("unmuting a playing video circle pauses the voice", async () => {
      await playback.play(baseInfo);
      const video = document.createElement("video");
      video.muted = true;
      Object.defineProperty(video, "paused", { configurable: true, get: () => false });
      document.body.appendChild(video);
      video.muted = false;
      video.dispatchEvent(new Event("volumechange"));
      expect(playback.state.value).toBe("paused");
      video.remove();
    });

    it("unmuting a paused video does not pause the voice", async () => {
      await playback.play(baseInfo);
      const video = document.createElement("video");
      Object.defineProperty(video, "paused", { configurable: true, get: () => true });
      document.body.appendChild(video);
      video.dispatchEvent(new Event("volumechange"));
      expect(playback.state.value).toBe("playing");
      video.remove();
    });

    it("a muted autoplay video does not pause the voice", async () => {
      await playback.play(baseInfo);
      const video = document.createElement("video");
      video.muted = true;
      document.body.appendChild(video);
      video.dispatchEvent(new Event("play"));
      expect(playback.state.value).toBe("playing");
      video.remove();
    });

    // Video.js keeps the <video> in a shadow root; the custom element host
    // (`<hls-video>`) re-dispatches `play` on itself (PeerTubePlayer).
    function customMediaHost(muted: boolean): HTMLElement {
      const host: HTMLElement = document.createElement("x-media");
      Object.assign(host, { muted, volume: 1, paused: false, pause: () => {} });
      document.body.appendChild(host);
      return host;
    }

    it("an audible custom media element (Video.js) pauses the voice", async () => {
      await playback.play(baseInfo);
      const host = customMediaHost(false);
      host.dispatchEvent(new Event("play"));
      expect(playback.state.value).toBe("paused");
      host.remove();
    });

    it("a muted custom media element does not pause the voice", async () => {
      await playback.play(baseInfo);
      const host = customMediaHost(true);
      host.dispatchEvent(new Event("play"));
      expect(playback.state.value).toBe("playing");
      host.remove();
    });

    it("a page video starting while the voice is still loading stops the voice", async () => {
      mockPlay.mockReturnValueOnce(new Promise(() => {}));
      void playback.play(baseInfo);
      expect(playback.state.value).toBe("loading");

      const video = document.createElement("video");
      document.body.appendChild(video);
      video.dispatchEvent(new Event("play"));

      expect(playback.state.value).toBe("idle");
      video.remove();
    });

    it("a voice starting pauses a playing page video (one sound at a time)", async () => {
      const video = document.createElement("video");
      const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
      Object.defineProperty(video, "paused", { configurable: true, get: () => false });
      document.body.appendChild(video);
      video.dispatchEvent(new Event("play"));

      await playback.play(baseInfo);
      (lastAudio.onplay as () => void)();

      expect(pause).toHaveBeenCalled();
      video.remove();
    });

    it("a `play` event from a non-media element is ignored", async () => {
      await playback.play(baseInfo);
      const div = document.createElement("div");
      document.body.appendChild(div);
      div.dispatchEvent(new Event("play"));
      expect(playback.state.value).toBe("playing");
      div.remove();
    });
  });

  describe("playback speed", () => {
    it("remembers the chosen speed in localStorage", async () => {
      playback.playbackRate.value = 1;
      playback.cycleSpeed();
      expect(localStorage.getItem("forta-voice-playback-rate")).toBe("1.5");
      playback.cycleSpeed();
      playback.cycleSpeed();
      expect(localStorage.getItem("forta-voice-playback-rate")).toBe("1");
    });
  });

  describe("error diagnostics", () => {
    it("should log detailed error info on audio error event", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await playback.play(baseInfo);

      lastAudio.error = { code: 4, message: "Not supported" } as MediaError;
      const onerror = lastAudio.onerror as (() => void) | null;
      onerror?.();

      expect(playback.state.value).toBe("failed");
      expect(consoleSpy).toHaveBeenCalledWith(
        "[audio] playback error:",
        expect.objectContaining({
          code: 4,
          codeName: "SRC_NOT_SUPPORTED",
        }),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("progress computed", () => {
    it("should compute progress as ratio of currentTime/duration", async () => {
      await playback.play(baseInfo);
      playback.duration.value = 20;
      playback.currentTime.value = 5;

      expect(playback.progress.value).toBe(0.25);
    });

    it("should return 0 when duration is 0", () => {
      expect(playback.progress.value).toBe(0);
    });
  });

  describe("stop()", () => {
    it("should cleanup and reset to idle", async () => {
      await playback.play(baseInfo);
      playback.stop();

      expect(playback.state.value).toBe("idle");
      expect(playback.currentMessageId.value).toBeNull();
      expect(playback.currentTime.value).toBe(0);
    });

    it("should clear roomId — enables room-change detection for invisible playback prevention", async () => {
      await playback.play(baseInfo);
      expect(playback.currentRoomId.value).toBe("room-1");

      playback.stop();

      expect(playback.currentRoomId.value).toBeNull();
      expect(mockPause).toHaveBeenCalled();
      expect(mockRemoveAttribute).toHaveBeenCalledWith("src");
    });

    it("does not auto-advance after stop", async () => {
      mockFindNextVoice.mockClear();
      await playback.play(baseInfo);
      playback.stop();
      await flush();

      expect(mockFindNextVoice).not.toHaveBeenCalled();
    });
  });

  describe("blob URL pinning", () => {
    it("pins the playing file and unpins it on stop", async () => {
      mockPinFileUrl.mockClear();
      mockUnpinFileUrl.mockClear();
      await playback.play(baseInfo);
      expect(mockPinFileUrl).toHaveBeenCalledWith("msg-1");
      expect(mockUnpinFileUrl).not.toHaveBeenCalled();

      playback.stop();
      expect(mockUnpinFileUrl).toHaveBeenCalledWith("msg-1");
    });

    it("moves the pin when another message starts", async () => {
      await playback.play(baseInfo);
      mockPinFileUrl.mockClear();
      mockUnpinFileUrl.mockClear();

      await playback.play({ ...baseInfo, messageId: "msg-2" });
      expect(mockUnpinFileUrl).toHaveBeenCalledWith("msg-1");
      expect(mockPinFileUrl).toHaveBeenCalledWith("msg-2");
    });
  });

  describe("isActive / isPlaying computed", () => {
    it("isActive should return true only for the playing message", async () => {
      const active1 = playback.isActive("msg-1");
      const active2 = playback.isActive("msg-2");

      await playback.play(baseInfo);

      expect(active1.value).toBe(true);
      expect(active2.value).toBe(false);
    });

    it("isPlaying should return false after stop", async () => {
      const playing1 = playback.isPlaying("msg-1");

      await playback.play(baseInfo);
      expect(playing1.value).toBe(true);

      playback.stop();
      expect(playing1.value).toBe(false);
    });
  });
});

describe("checkCodecSupport", () => {
  it("should return codec support map with boolean values", () => {
    const support = checkCodecSupport();

    expect(support).toHaveProperty("mp3");
    expect(support).toHaveProperty("ogg");
    expect(support).toHaveProperty("webm");
    expect(support).toHaveProperty("wav");
    expect(support).toHaveProperty("aac");
    expect(typeof support.mp3).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Watchdog regression — Session 44
// Reproduces issues #695, #671: voice message gets stuck in loading state
// when the encrypted blob's <audio> never reaches loadedmetadata. Without a
// watchdog, the user sees an infinite spinner; the cure is an 8s timeout
// that flips state → "failed" so the retry button is shown.
// ---------------------------------------------------------------------------
describe("useAudioPlayback watchdog (Session 44)", () => {
  let playback: ReturnType<typeof useAudioPlayback>;

  beforeEach(() => {
    vi.useFakeTimers();
    playback = useAudioPlayback();
    playback.stop();
    // Reset rate so tests don't inherit cycleSpeed leftovers from other blocks.
    playback.playbackRate.value = 1;
    mockPlay.mockClear();
    mockPause.mockClear();
    mockLoad.mockClear();
    mockRemoveAttribute.mockClear();
    mockBugReportOpen.mockClear();
    (Audio as unknown as Mock).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions to 'failed' if loadedmetadata never fires within 8s", async () => {
    // Simulate hung encrypted blob: play() returns a never-resolving promise.
    mockPlay.mockReturnValue(new Promise(() => {}));

    // Don't await — play() will hang on the never-resolving promise.
    void playback.play(baseInfo);
    // Allow the synchronous part of play() to run (state = "loading", el = new Audio()).
    await Promise.resolve();
    expect(playback.state.value).toBe("loading");

    // Advance past the 8s watchdog threshold.
    await vi.advanceTimersByTimeAsync(8000);

    expect(playback.state.value).toBe("failed");
  });

  it("does not transition to 'failed' if loadedmetadata fires before 8s", async () => {
    mockPlay.mockResolvedValueOnce(undefined);

    await playback.play(baseInfo);
    expect(playback.state.value).toBe("playing");

    // Fire loadedmetadata to clear the watchdog.
    const onloaded = lastAudio.onloadedmetadata as ((this: unknown) => void) | null;
    onloaded?.call(lastAudio);

    await vi.advanceTimersByTimeAsync(8000);

    expect(playback.state.value).not.toBe("failed");
    expect(playback.state.value).toBe("playing");
  });

  it("does not transition to 'failed' on watchdog if state has already moved on", async () => {
    mockPlay.mockResolvedValueOnce(undefined);

    await playback.play(baseInfo);
    // play() resolved → state = "playing"; user pauses before watchdog fires.
    playback.pause();
    expect(playback.state.value).toBe("paused");

    await vi.advanceTimersByTimeAsync(8000);

    // Watchdog must only flip state when it's still "loading".
    expect(playback.state.value).toBe("paused");
  });

  it("does not open the bug-report modal when the watchdog wins the race", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Simulate the encrypted-blob hang: play() never resolves on its own.
    // After the watchdog calls pause()/removeAttribute("src")/load(), the
    // browser would normally reject the play() promise with AbortError.
    let rejectPlay: (e: Error) => void = () => {};
    mockPlay.mockReturnValue(new Promise((_, reject) => { rejectPlay = reject; }));

    void playback.play(baseInfo);
    await Promise.resolve();
    expect(playback.state.value).toBe("loading");

    // Watchdog fires.
    await vi.advanceTimersByTimeAsync(8000);
    expect(playback.state.value).toBe("failed");

    // Now the browser rejects play() (deferred AbortError after src cleared).
    rejectPlay(new DOMException("The play() request was interrupted", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();

    // Must not show a bug-report modal — the watchdog already surfaced
    // the failure, and the AbortError is its own doing.
    expect(mockBugReportOpen).not.toHaveBeenCalled();
    expect(playback.state.value).toBe("failed");

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Watchdog re-arm — WEE-62 / forta-bugs#901
  // Heavy encrypted blobs on slow links can still be downloading/decoding when
  // the first 8s window elapses. The watchdog must NOT flip to "failed" while
  // the element keeps making progress (networkState=LOADING or metadata
  // parsed) — that false negative is the "ошибка воспроизведения" report.
  // -------------------------------------------------------------------------
  it("re-arms instead of failing while the element is still fetching bytes", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPlay.mockReturnValue(new Promise(() => {}));

    void playback.play(baseInfo);
    await Promise.resolve();
    expect(playback.state.value).toBe("loading");

    // Element is actively downloading the encrypted blob (networkState=LOADING).
    lastAudio.networkState = 2;
    lastAudio.readyState = 0;

    // First window elapses — must NOT fail, the load is still progressing.
    await vi.advanceTimersByTimeAsync(8000);
    expect(playback.state.value).toBe("loading");

    // Progress stalls: no metadata, network idle.
    lastAudio.networkState = 0;
    lastAudio.readyState = 0;

    // Next window with zero progress → genuinely stuck → failed.
    await vi.advanceTimersByTimeAsync(8000);
    expect(playback.state.value).toBe("failed");

    consoleWarnSpy.mockRestore();
  });

  it("re-arms on loadedmetadata so a post-metadata decode hang isn't failed at 8s", async () => {
    mockPlay.mockReturnValue(new Promise(() => {}));

    void playback.play(baseInfo);
    await Promise.resolve();
    expect(playback.state.value).toBe("loading");

    // Metadata arrives mid-load (real progress) but playback hasn't started.
    lastAudio.readyState = 1;
    const onloaded = lastAudio.onloadedmetadata as ((this: unknown) => void) | null;
    onloaded?.call(lastAudio);

    // The original flat 8s window would have failed here; with re-arm it does not.
    await vi.advanceTimersByTimeAsync(8000);
    expect(playback.state.value).toBe("loading");
  });

  it("still fails a genuinely dead pipeline within the bounded re-arm budget", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPlay.mockReturnValue(new Promise(() => {}));

    void playback.play(baseInfo);
    await Promise.resolve();

    // Element claims to be loading forever (stuck socket) — re-arms are bounded
    // so the user still gets a retry button rather than an infinite spinner.
    lastAudio.networkState = 2;
    lastAudio.readyState = 0;

    // 8s ×3 = initial window + MAX_WATCHDOG_REARMS(2) re-arms → failed.
    await vi.advanceTimersByTimeAsync(8000 * 3);
    expect(playback.state.value).toBe("failed");

    consoleWarnSpy.mockRestore();
  });
});
