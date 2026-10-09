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
