// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const interruptVoicePlayback = vi.fn();
vi.mock("./use-audio-playback", () => ({
  interruptVoicePlayback: () => interruptVoicePlayback(),
}));

import { useVoiceRecorder } from "./use-voice-recorder";

describe("useVoiceRecorder — getUserMedia constraints", () => {
  let gumSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gumSpy = vi.fn(async () => ({
      getAudioTracks: () => [{ enabled: true, stop: () => {} }],
      getTracks: () => [{ stop: () => {} }],
    }));
    Object.defineProperty(global.navigator, "mediaDevices", {
      writable: true,
      configurable: true,
      value: { getUserMedia: gumSpy },
    });
    global.MediaRecorder = vi.fn(() => ({
      addEventListener: vi.fn(),
      start: vi.fn(),
      state: "recording",
      stop: vi.fn(),
    })) as unknown as typeof MediaRecorder;
    (global.MediaRecorder as unknown as { isTypeSupported: () => boolean }).isTypeSupported = vi.fn(() => true);
  });

  it("requests audio with autoGainControl: true", async () => {
    const recorder = useVoiceRecorder();
    await recorder.startRecording();
    expect(gumSpy).toHaveBeenCalled();
    const constraints = gumSpy.mock.calls[0][0] as { audio: { autoGainControl: boolean } };
    expect(constraints.audio.autoGainControl).toBe(true);
  });

  it("requests audio with echoCancellation: true", async () => {
    const recorder = useVoiceRecorder();
    await recorder.startRecording();
    const constraints = gumSpy.mock.calls[0][0] as { audio: { echoCancellation: boolean } };
    expect(constraints.audio.echoCancellation).toBe(true);
  });

  it("requests audio with noiseSuppression: true", async () => {
    const recorder = useVoiceRecorder();
    await recorder.startRecording();
    const constraints = gumSpy.mock.calls[0][0] as { audio: { noiseSuppression: boolean } };
    expect(constraints.audio.noiseSuppression).toBe(true);
  });
});

describe("useVoiceRecorder — voice playback", () => {
  it("interrupts the playing voice before the mic opens", async () => {
    const order: string[] = [];
    interruptVoicePlayback.mockImplementation(() => order.push("interrupt"));
    Object.defineProperty(global.navigator, "mediaDevices", {
      writable: true,
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          order.push("gum");
          return { getAudioTracks: () => [], getTracks: () => [] };
        }),
      },
    });
    await useVoiceRecorder().startRecording();
    expect(order.slice(0, 2)).toEqual(["interrupt", "gum"]);
  });
});

// Regression: only the last 50 samples (2.5 s) were sent, so a voice ending in
// silence got a waveform of zeros — a row of equal dots.
describe("useVoiceRecorder — sent waveform", () => {
  it("covers the whole recording, not its last 2.5 seconds", async () => {
    vi.useFakeTimers();
    let level = 255;
    class FakeAudioContext {
      createMediaStreamSource() { return { connect: () => {} }; }
      createAnalyser() {
        return { fftSize: 0, frequencyBinCount: 4, getByteFrequencyData: (a: Uint8Array) => a.fill(level) };
      }
      async decodeAudioData() { return { duration: 5 }; }
      close() {}
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    Object.defineProperty(global.navigator, "mediaDevices", {
      writable: true,
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [{ enabled: true, stop: () => {} }],
          getTracks: () => [{ stop: () => {} }],
        })),
      },
    });
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const rec = {
      state: "recording",
      addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
      start: vi.fn(),
      stop: () => {
        if (rec.state === "inactive") return;
        rec.state = "inactive";
        listeners.dataavailable?.forEach((fn) => fn({ data: new Blob(["x"], { type: "audio/webm" }) }));
        listeners.stop?.forEach((fn) => fn({}));
      },
    };
    global.MediaRecorder = vi.fn(function () { return rec; }) as unknown as typeof MediaRecorder;
    (global.MediaRecorder as unknown as { isTypeSupported: () => boolean }).isTypeSupported = vi.fn(() => true);

    try {
      const recorder = useVoiceRecorder();
      await recorder.startRecording();
      vi.advanceTimersByTime(2500); // 50 loud samples
      level = 0;
      vi.advanceTimersByTime(2500); // 50 silent samples

      const sending = recorder.stopAndSend();
      await vi.advanceTimersByTimeAsync(200);
      const result = await sending;

      expect(result!.waveform).toHaveLength(50);
      expect(result!.waveform[0]).toBeGreaterThan(0.9);
      expect(result!.waveform[49]).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
