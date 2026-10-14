import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ensureVoiceWaveform,
  getVoiceWaveform,
  hasWaveformShape,
  resampleWaveform,
  resetVoiceWaveformsForTest,
  waveformBars,
} from "./voice-waveform";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A decoded channel: loud first half, quiet second half. */
const channel = Float32Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0.8 : 0.1));

class FakeOfflineAudioContext {
  static decodes = 0;
  constructor(_channels: number, _length: number, _rate: number) {}
  async decodeAudioData() {
    FakeOfflineAudioContext.decodes++;
    return { getChannelData: () => channel };
  }
}

describe("voice-waveform", () => {
  beforeEach(() => {
    resetVoiceWaveformsForTest();
    FakeOfflineAudioContext.decodes = 0;
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resamples the whole source by bucket averages", () => {
    expect(resampleWaveform([0, 1, 2, 3], 2)).toEqual([0.5, 2.5]);
    expect(resampleWaveform([1, 2], 4)).toEqual([1, 1, 2, 2]);
    expect(resampleWaveform([], 4)).toEqual([]);
  });

  it("treats empty, silent and flat waveforms as shapeless", () => {
    expect(hasWaveformShape(undefined)).toBe(false);
    expect(hasWaveformShape([])).toBe(false);
    expect(hasWaveformShape([0, 0, 0])).toBe(false);
    expect(hasWaveformShape([0.3, 0.3, 0.3])).toBe(false);
    expect(hasWaveformShape([0.1, 0.4, 0.2])).toBe(true);
  });

  it("normalizes bars to the loudest one, with a floor for silence", () => {
    expect(waveformBars([0, 0.5, 1], 3)).toEqual([0.08, 0.5, 1]);
    expect(waveformBars(null, 3)).toEqual([0.15, 0.15, 0.15]);
  });

  it("decodes the audio when the stored waveform is missing, shared by key", async () => {
    expect(getVoiceWaveform("k1", undefined)).toBeNull();
    ensureVoiceWaveform("k1", undefined, "blob:x");
    ensureVoiceWaveform("k1", undefined, "blob:x");
    await flush();
    await flush();

    expect(FakeOfflineAudioContext.decodes).toBe(1);
    const waveform = getVoiceWaveform("k1", undefined)!;
    expect(waveform).toHaveLength(50);
    expect(waveform[0]).toBeCloseTo(0.8);
    expect(waveform[49]).toBeCloseTo(0.1);
  });

  // Regression: a stored waveform of zeros drew a row of equal dots.
  it("decodes over a flat stored waveform", async () => {
    ensureVoiceWaveform("k2", [0, 0, 0, 0], "blob:x");
    await flush();
    await flush();
    expect(getVoiceWaveform("k2", [0, 0, 0, 0])?.[0]).toBeCloseTo(0.8);
  });

  it("keeps a stored waveform that has a shape, without decoding", async () => {
    const stored = [0.1, 0.5, 0.2];
    ensureVoiceWaveform("k3", stored, "blob:x");
    await flush();
    expect(FakeOfflineAudioContext.decodes).toBe(0);
    expect(getVoiceWaveform("k3", stored)).toBe(stored);
  });

  it("a failed decode leaves the placeholder and can be retried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("gone"); }));
    ensureVoiceWaveform("k4", undefined, "blob:x");
    await flush();
    await flush();
    expect(getVoiceWaveform("k4", undefined)).toBeNull();
    expect(warn).toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })));
    ensureVoiceWaveform("k4", undefined, "blob:x");
    await flush();
    await flush();
    expect(getVoiceWaveform("k4", undefined)).not.toBeNull();
    warn.mockRestore();
  });
});
