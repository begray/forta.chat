// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { describeVideoForSend, setVideoSendMetaDepsForTests } from "../video-send-meta";

afterEach(() => setVideoSendMetaDepsForTests(null));

const video = new Blob(["mp4"], { type: "video/mp4" });

describe("describeVideoForSend", () => {
  it("web/iOS: takes the frame and the facts from a <video> over the bytes", async () => {
    setVideoSendMetaDepsForTests({
      nativeAvailable: () => false,
      webFrame: async () => ({ blob: new Blob(["jpg"], { type: "image/jpeg" }), width: 270, height: 480, videoWidth: 1080, videoHeight: 1920, durationS: 12.34 }),
    });
    const meta = await describeVideoForSend(video, "c1", { uri: "file:///x.mp4" });
    expect(meta.facts).toEqual({ w: 1080, h: 1920, durationMs: 12_340 });
    expect(meta.thumbnail).toMatchObject({ w: 270, h: 480, mimetype: "image/jpeg", size: 3 });
  });

  it("prefers facts already measured (the compressor's output) over the frame grabber's", async () => {
    setVideoSendMetaDepsForTests({
      nativeAvailable: () => true,
      nativeThumbnail: async () => ({ path: "/t.jpg", uri: "file:///t.jpg", width: 480, height: 270, size: 9, durationMs: 1, videoWidth: 2, videoHeight: 3 }),
      readUri: async () => new Blob(["jpg"]),
      deleteFile: async () => {},
    });
    const meta = await describeVideoForSend(video, "c1", { uri: "file:///out.mp4", known: { w: 1280, h: 720, durationMs: 60_000 } });
    expect(meta.facts).toEqual({ w: 1280, h: 720, durationMs: 60_000 });
  });

  it("a grabber that hangs gives up after the timeout and keeps the known facts", async () => {
    vi.useFakeTimers();
    setVideoSendMetaDepsForTests({ nativeAvailable: () => false, webFrame: () => new Promise(() => {}), timeoutMs: 1000 });
    const pending = describeVideoForSend(video, "c1", { known: { durationMs: 5000 } });
    await vi.advanceTimersByTimeAsync(1001);
    const meta = await pending;
    vi.useRealTimers();
    expect(meta.thumbnail).toBeUndefined();
    expect(meta.facts).toEqual({ w: undefined, h: undefined, durationMs: 5000 });
  });
});
