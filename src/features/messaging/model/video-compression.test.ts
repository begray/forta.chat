// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => ({}) }));

import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";
import { resetUploadLimitForTests } from "@/shared/lib/file-transfer/upload-limit";
import type { CompressVideoOptions, CompressVideoResult } from "@/shared/lib/video-compress/video-compress-plugin";
import { __resetSendErrorBusForTests, useSendErrorBus } from "./send-error-bus";
import {
  cancelVideoCompression,
  prepareVideoForSend,
  setVideoCompressionDepsForTests,
  useVideoCompressions,
  willCompressVideo,
  type VideoCompressionDeps,
} from "./video-compression";

const MiB = 1024 * 1024;
const LIMIT = 50 * MiB;

/** A File that reports `size` without allocating it. */
function fakeVideo(size: number, name = "clip.mp4", type = "video/mp4"): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

type Progress = (data: { id: string; percent: number }) => void;

function makeDeps(overrides: Partial<VideoCompressionDeps> = {}) {
  const listeners = new Set<Progress>();
  const deleted: string[] = [];
  const compressCalls: CompressVideoOptions[] = [];
  let outputSize = 30 * MiB;
  const deps: VideoCompressionDeps = {
    available: () => true,
    uploadLimit: async () => LIMIT,
    probe: async () => ({ durationMs: 60_000, width: 1080, height: 1920, rotation: 90, bitrate: 17_000_000 }),
    compress: vi.fn(async (o: CompressVideoOptions): Promise<CompressVideoResult> => {
      compressCalls.push(o);
      for (const l of listeners) l({ id: o.id, percent: 30 });
      for (const l of listeners) l({ id: o.id, percent: 80 });
      return { path: `/cache/video-compress/out-${o.id}.mp4`, uri: `file:///cache/out-${o.id}.mp4`, size: outputSize, durationMs: 60_000, width: 720, height: 1280, videoBitrate: o.videoBitrate ?? 0 };
    }),
    cancel: vi.fn(async () => {}),
    onProgress: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    copyToCache: async (_f, path) => `file:///cache/${path}`,
    readOutput: async (r, name) => fakeVideo(r.size, name),
    deleteCacheFile: async (p) => { deleted.push(p); },
    now: () => 0,
    ...overrides,
  };
  return {
    deps,
    deleted,
    compressCalls,
    setOutputSize: (n: number) => { outputSize = n; },
    listenerCount: () => listeners.size,
  };
}

const events = (id?: string) =>
  getUploadLog().filter((e) => !id || e.c === id.slice(0, 8)).map((e) => e.e);

beforeEach(() => {
  localStorage.clear();
  resetUploadLogForTests();
  resetUploadLimitForTests();
  __resetSendErrorBusForTests();
});
afterEach(() => setVideoCompressionDepsForTests(null));

describe("prepareVideoForSend", () => {
  it("passes small videos and non-videos through untouched", async () => {
    const m = makeDeps();
    setVideoCompressionDepsForTests(m.deps);
    const small = fakeVideo(5 * MiB);
    expect((await prepareVideoForSend(small, "c-small"))?.file).toBe(small);
    const photo = fakeVideo(80 * MiB, "p.jpg", "image/jpeg");
    expect((await prepareVideoForSend(photo, "c-photo"))?.file).toBe(photo);
    expect(m.deps.compress).not.toHaveBeenCalled();
  });

  it("keeps the old behaviour where the plugin is missing (iOS, web)", async () => {
    const m = makeDeps({ available: () => false });
    setVideoCompressionDepsForTests(m.deps);
    const big = fakeVideo(90 * MiB);
    expect((await prepareVideoForSend(big, "c-ios"))?.file).toBe(big);
    expect(willCompressVideo(big)).toBe(false);
    expect(m.deps.compress).not.toHaveBeenCalled();
  });

  it("compresses a big video, logs the steps and cleans up", async () => {
    const m = makeDeps();
    setVideoCompressionDepsForTests(m.deps);
    const original = fakeVideo(92 * MiB, "VID_2026.mov", "video/quicktime");
    const prepared = await prepareVideoForSend(original, "c-big-0001");
    expect(prepared?.compressed).toBe(true);
    expect(prepared?.file).not.toBe(original);
    expect(prepared?.file.name).toBe("VID_2026.mp4");
    expect(prepared?.file.size).toBe(30 * MiB);

    const call = m.compressCalls[0];
    expect(call.path).toBe("file:///cache/video-compress/in-c-big-0001.mov");
    expect(call.targetHeight).toBe(720);
    expect(call.audioBitrate).toBe(128_000);
    expect(call.maxBytes).toBe(LIMIT);
    expect(call.videoBitrate).toBe(2_500_000);

    const log = events("c-big-0001");
    expect(log).toEqual(expect.arrayContaining(["compress:start", "compress:copied", "compress:encode", "compress:progress", "compress:ok"]));
    expect(log.indexOf("compress:start")).toBeLessThan(log.indexOf("compress:ok"));
    // The source copy goes right away, the output once the send is read.
    expect(m.deleted).toEqual(["video-compress/in-c-big-0001.mov"]);
    await prepared!.cleanup();
    expect(m.deleted).toContain("/cache/video-compress/out-c-big-0001.mp4");
    expect(useVideoCompressions().jobs.value).toEqual([]);
    expect(m.listenerCount()).toBe(0);
  });

  it("shows the running job in the banner", async () => {
    let release!: () => void;
    const m = makeDeps();
    const compress = m.deps.compress;
    m.deps.compress = async (o) => {
      await new Promise<void>((r) => { release = r; });
      return compress(o);
    };
    setVideoCompressionDepsForTests(m.deps);
    const run = prepareVideoForSend(fakeVideo(60 * MiB), "c-progress");
    await vi.waitFor(() => expect(useVideoCompressions().jobs.value[0]?.stage).toBe("compressing"));
    release();
    await run;
    expect(useVideoCompressions().jobs.value).toEqual([]);
  });

  it("compresses a video between the threshold and the limit too", async () => {
    const m = makeDeps();
    m.setOutputSize(8 * MiB);
    setVideoCompressionDepsForTests(m.deps);
    const prepared = await prepareVideoForSend(fakeVideo(30 * MiB), "c-mid");
    expect(prepared?.compressed).toBe(true);
  });

  it("retries once at a lower bitrate when the output overshoots", async () => {
    const m = makeDeps();
    const sizes = [60 * MiB, 40 * MiB];
    m.deps.compress = vi.fn(async (o: CompressVideoOptions) => {
      m.compressCalls.push(o);
      return { path: `/out-${m.compressCalls.length}.mp4`, uri: "file:///o", size: sizes[m.compressCalls.length - 1], durationMs: 1, width: 1, height: 1, videoBitrate: o.videoBitrate ?? 0 };
    });
    setVideoCompressionDepsForTests(m.deps);
    const prepared = await prepareVideoForSend(fakeVideo(120 * MiB), "c-over");
    expect(prepared?.file.size).toBe(40 * MiB);
    expect(m.compressCalls).toHaveLength(2);
    expect(m.compressCalls[1].videoBitrate!).toBeLessThan(m.compressCalls[0].videoBitrate!);
    expect(m.deleted).toContain("/out-1.mp4");
    expect(events("c-over")).toContain("compress:oversize");
  });

  it("refuses with the size banner when the output still does not fit", async () => {
    const m = makeDeps();
    m.setOutputSize(70 * MiB);
    setVideoCompressionDepsForTests(m.deps);
    expect(await prepareVideoForSend(fakeVideo(120 * MiB), "c-still")).toBeNull();
    expect(m.compressCalls).toHaveLength(2);
    expect(useSendErrorBus().error.value?.kind).toBe("fileTooLarge");
    expect(useSendErrorBus().error.value?.context.sizeBytes).toBe(120 * MiB);
    expect(events("c-still")).toContain("send:dropped");
  });

  it("falls back to the original when compression fails and it fits", async () => {
    const m = makeDeps({ compress: vi.fn(async () => { throw Object.assign(new Error("codec"), { code: "FAILED" }); }) });
    setVideoCompressionDepsForTests(m.deps);
    const original = fakeVideo(30 * MiB);
    const prepared = await prepareVideoForSend(original, "c-fail-fit");
    expect(prepared?.file).toBe(original);
    expect(prepared?.compressed).toBe(false);
    expect(events("c-fail-fit")).toEqual(expect.arrayContaining(["compress:fail", "compress:fallback"]));
    expect(useSendErrorBus().error.value).toBeNull();
    expect(m.deleted).toContain("video-compress/in-c-fail-fit.mp4");
  });

  it("retries an encode that failed while the app was in the background, once it is back", async () => {
    const m = makeDeps();
    const compress = m.deps.compress;
    let calls = 0;
    let foreground!: () => void;
    m.deps.compress = vi.fn(async (o: CompressVideoOptions) => {
      if (++calls === 1) throw Object.assign(new Error("codec reclaimed"), { code: "FAILED" });
      return compress(o);
    });
    m.deps.wasBackgrounded = () => true;
    m.deps.whenForeground = () => new Promise<void>((r) => { foreground = r; });
    setVideoCompressionDepsForTests(m.deps);
    const run = prepareVideoForSend(fakeVideo(90 * MiB), "c-locked");
    await vi.waitFor(() => expect(foreground).toBeTypeOf("function"));
    expect(m.deps.compress).toHaveBeenCalledTimes(1);
    foreground();
    expect((await run)?.compressed).toBe(true);
    expect(m.deps.compress).toHaveBeenCalledTimes(2);
    expect(events("c-locked")).toContain("compress:retry");
    expect(events("c-locked")).not.toContain("compress:fail");
  });

  it("does not retry a failed encode when the app stayed in the foreground", async () => {
    const m = makeDeps();
    m.deps.compress = vi.fn(async () => { throw Object.assign(new Error("bad input"), { code: "FAILED" }); });
    m.deps.wasBackgrounded = () => false;
    setVideoCompressionDepsForTests(m.deps);
    expect(await prepareVideoForSend(fakeVideo(90 * MiB), "c-fg")).toBeNull();
    expect(m.deps.compress).toHaveBeenCalledTimes(1);
  });

  it("shows the too-large banner when compression fails and the original is too big", async () => {
    const m = makeDeps({ probe: async () => { throw Object.assign(new Error("bad"), { code: "PROBE_FAILED" }); } });
    setVideoCompressionDepsForTests(m.deps);
    expect(await prepareVideoForSend(fakeVideo(92 * MiB), "c-fail-big")).toBeNull();
    expect(useSendErrorBus().error.value?.kind).toBe("fileTooLarge");
    expect(m.deps.compress).not.toHaveBeenCalled();
  });

  it("says how long a video may be when it is too long to fit", async () => {
    const m = makeDeps({ probe: async () => ({ durationMs: 30 * 60_000, width: 1920, height: 1080, rotation: 0, bitrate: 0 }) });
    setVideoCompressionDepsForTests(m.deps);
    expect(await prepareVideoForSend(fakeVideo(400 * MiB), "c-long")).toBeNull();
    const err = useSendErrorBus().error.value;
    expect(err?.kind).toBe("videoTooLong");
    expect(err?.context.maxDurationMs).toBeGreaterThan(9 * 60_000);
    expect(m.deps.compress).not.toHaveBeenCalled();
  });

  it("cancel while compressing drops the send and deletes the temp files", async () => {
    const m = makeDeps();
    let rejectCompress!: (e: unknown) => void;
    m.deps.compress = vi.fn(() => new Promise<CompressVideoResult>((_, reject) => { rejectCompress = reject; }));
    m.deps.cancel = vi.fn(async () => rejectCompress(Object.assign(new Error("cancelled"), { code: "CANCELLED" })));
    setVideoCompressionDepsForTests(m.deps);
    const run = prepareVideoForSend(fakeVideo(80 * MiB), "c-cancel");
    await vi.waitFor(() => expect(m.deps.compress).toHaveBeenCalled());
    await cancelVideoCompression("c-cancel");
    expect(await run).toBeNull();
    expect(m.deps.cancel).toHaveBeenCalledWith("c-cancel");
    expect(events("c-cancel")).toEqual(expect.arrayContaining(["compress:cancel", "compress:cancelled"]));
    expect(events("c-cancel")).not.toContain("compress:fallback");
    expect(useSendErrorBus().error.value).toBeNull();
    expect(m.deleted).toContain("video-compress/in-c-cancel.mp4");
    expect(useVideoCompressions().jobs.value).toEqual([]);
  });

  it("cancel while copying stops before the encoder starts", async () => {
    const m = makeDeps();
    let resume!: () => void;
    m.deps.copyToCache = async (_f, path, isCancelled) => {
      await new Promise<void>((r) => { resume = r; });
      if (isCancelled()) throw new Error("should be CompressionCancelled in the native deps");
      return path;
    };
    setVideoCompressionDepsForTests(m.deps);
    const run = prepareVideoForSend(fakeVideo(80 * MiB), "c-copy");
    await vi.waitFor(() => expect(useVideoCompressions().jobs.value[0]?.stage).toBe("copying"));
    await cancelVideoCompression("c-copy");
    resume();
    expect(await run).toBeNull();
    expect(m.deps.compress).not.toHaveBeenCalled();
    expect(events("c-copy")).toContain("compress:cancelled");
  });

  it("runs one compression at a time and a queued one can be cancelled", async () => {
    const m = makeDeps();
    let release!: () => void;
    const compress = m.deps.compress;
    let running = 0;
    let maxRunning = 0;
    m.deps.compress = vi.fn(async (o: CompressVideoOptions) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      if (o.id === "c-first") await new Promise<void>((r) => { release = r; });
      running--;
      return compress(o);
    });
    setVideoCompressionDepsForTests(m.deps);
    const first = prepareVideoForSend(fakeVideo(80 * MiB), "c-first");
    const second = prepareVideoForSend(fakeVideo(80 * MiB), "c-second");
    const third = prepareVideoForSend(fakeVideo(80 * MiB), "c-third");
    await vi.waitFor(() => expect(m.deps.compress).toHaveBeenCalledTimes(1));
    expect(useVideoCompressions().jobs.value.map((j) => j.stage)).toEqual(["compressing", "queued", "queued"]);
    await cancelVideoCompression("c-third");
    release();
    expect((await first)?.compressed).toBe(true);
    expect((await second)?.compressed).toBe(true);
    expect(await third).toBeNull();
    expect(maxRunning).toBe(1);
    expect(m.deps.compress).toHaveBeenCalledTimes(2);
  });
});
