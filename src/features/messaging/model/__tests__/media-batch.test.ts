// @vitest-environment happy-dom
/**
 * Batch sends of picked media (media-batch.ts), with the compressor's
 * platform calls mocked.
 *
 * The regression case replays the standbyfix6 field log (16:33): 19 items,
 * every WebView File handle not yet read turned NotReadableError right after
 * the first compression finished. The old flow (sendBatch straight into
 * sendFile) read most videos only after earlier ones were compressed and
 * lost them; the snapshot-first flow reads/stages everything before the
 * first encode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => ({}) }));

import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";
import { resetUploadLimitForTests } from "@/shared/lib/file-transfer/upload-limit";
import { en } from "@/shared/lib/i18n/locales/en";
import type { TranslationKey } from "@/shared/lib/i18n";
import type { CompressVideoOptions, CompressVideoResult } from "@/shared/lib/video-compress/video-compress-plugin";
import { __resetSendErrorBusForTests, useSendErrorBus } from "../send-error-bus";
import { sendBatch } from "../send-batch";
import { sendPickedBatch } from "../media-batch";
import { readPickedFile } from "../read-picked-file";
import { releaseFileSource } from "../picked-media";
import { sendErrorLabel } from "../send-error-label";
import {
  cancelVideoCompression,
  prepareVideoForSend,
  setVideoCompressionDepsForTests,
  useVideoCompressions,
  type VideoCompressionDeps,
} from "../video-compression";

const MiB = 1024 * 1024;
const LIMIT = 50 * MiB;

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key] as string);

function notReadable(): Error {
  const e = new Error("The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.");
  e.name = "NotReadableError";
  return e;
}

/** A picked WebView File: readable until `handles.stale` flips, like the
 *  content:// handles in the field log. Reports `size` without allocating. */
function picked(name: string, type: string, size: number, handles: { stale: boolean }, reads: string[]): File {
  const f = new File(["data"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  const read = async () => {
    reads.push(name);
    if (handles.stale) throw notReadable();
    return new TextEncoder().encode("data").buffer as ArrayBuffer;
  };
  Object.defineProperty(f, "arrayBuffer", { value: read });
  Object.defineProperty(f, "slice", {
    value: () => {
      const b = new Blob(["data"]);
      Object.defineProperty(b, "arrayBuffer", { value: read });
      return b;
    },
  });
  return f;
}

/** The compressor's platform calls; the first finished encode makes every
 *  picked handle stale (the moment the field log went bad). */
function makeDeps(handles: { stale: boolean }, order: string[]) {
  const deleted: string[] = [];
  const deps: VideoCompressionDeps = {
    available: () => true,
    uploadLimit: async () => LIMIT,
    probe: async () => ({ durationMs: 40_000, width: 1080, height: 1920, rotation: 90, bitrate: 20_000_000 }),
    compress: vi.fn(async (o: CompressVideoOptions): Promise<CompressVideoResult> => {
      order.push(`compress:${o.id}`);
      handles.stale = true;
      return { path: `/cache/video-compress/out-${o.id}.mp4`, uri: `file:///cache/video-compress/out-${o.id}.mp4`, size: 18 * MiB, durationMs: 40_000, width: 720, height: 1280, videoBitrate: 2_500_000 };
    }),
    cancel: vi.fn(async () => {}),
    onProgress: async () => () => {},
    copyToCache: async (file, path) => {
      // The real copy reads the File in slices.
      await file.slice(0, 3 * MiB).arrayBuffer();
      order.push(`copy:${file.name}`);
      return `file:///cache/${path}`;
    },
    readOutput: async (r, name) => new File(["compressed"], name, { type: "video/mp4" }),
    deleteCacheFile: async (p) => { deleted.push(p); },
    now: () => 0,
  };
  return { deps, deleted };
}

/** sendFile/sendImage reduced to what matters here: prepare, read, cleanup. */
function makeSend(sent: string[], order: string[]) {
  let n = 0;
  return async (file: File): Promise<boolean> => {
    const clientId = `c-${String(++n).padStart(4, "0")}`;
    try {
      const prepared = await prepareVideoForSend(file, clientId);
      if (!prepared) return false;
      try {
        await readPickedFile(prepared.file);
      } catch {
        return false;
      } finally {
        await prepared.cleanup();
      }
      order.push(`sent:${file.name}`);
      sent.push(file.name);
      return true;
    } finally {
      void releaseFileSource(file);
    }
  };
}

/** The 16:33 batch: 15 videos (3 small) and 4 photos. */
function fieldBatch(handles: { stale: boolean }, reads: string[]): File[] {
  const sizes = [92.8, 114.3, 156.7, 64, "p4.7", 49.5, 29.1, 27.2, 34.8, 9.3, 12.1, 38.5, 101.9, "p8.6", "p2.8", "p3.4", 65.2, 4.96, 171];
  return sizes.map((s, i) =>
    typeof s === "string"
      ? picked(`photo${i}.jpg`, "image/jpeg", Number(s.slice(1)) * 1e6, handles, reads)
      : picked(`video${i}.mp4`, "video/mp4", s * 1e6, handles, reads),
  );
}

const events = () => getUploadLog().map((e) => e.e);

beforeEach(() => {
  localStorage.clear();
  resetUploadLogForTests();
  resetUploadLimitForTests();
  __resetSendErrorBusForTests();
});
afterEach(() => setVideoCompressionDepsForTests(null));

describe("stale picked files mid-batch (standbyfix6 field log)", () => {
  it("the old flow loses every item it had not read before the first encode", async () => {
    const handles = { stale: false };
    const reads: string[] = [];
    const order: string[] = [];
    setVideoCompressionDepsForTests(makeDeps(handles, order).deps);
    const sent: string[] = [];
    const files = fieldBatch(handles, reads);
    await sendBatch(files, makeSend(sent, order), (f) => f.name);
    // Only what was read before the first compress made it.
    expect(sent.length).toBeLessThan(files.length);
    expect(sent).toContain("video0.mp4");
  });

  it("snapshot-first sends all 19, and every read happens before the first encode", async () => {
    const handles = { stale: false };
    const reads: string[] = [];
    const order: string[] = [];
    const { deps, deleted } = makeDeps(handles, order);
    setVideoCompressionDepsForTests(deps);
    const sent: string[] = [];
    const files = fieldBatch(handles, reads);
    const outcome = await sendPickedBatch(files, (f) => f, (_, f) => f, makeSend(sent, order));

    expect(outcome).toEqual({ total: 19, sent: 19, unreadable: 0, failed: 0, cancelled: 0 });
    expect(sent).toHaveLength(19);
    const firstEncode = order.findIndex((o) => o.startsWith("compress:"));
    const lastCopy = order.map((o) => o.startsWith("copy:")).lastIndexOf(true);
    expect(firstEncode).toBeGreaterThan(lastCopy);
    // 12 big videos staged once each, before the first encode; 7 read into memory.
    expect(order.filter((o) => o.startsWith("copy:"))).toHaveLength(12);
    expect(deps.compress).toHaveBeenCalledTimes(12);
    // Cleanup only ever touches our own cache files.
    expect(deleted.length).toBeGreaterThan(0);
    for (const p of deleted) expect(p).toMatch(/video-compress\/(in-stage-|out-)/);
    expect(events()).toContain("send:batch-done");
    expect(useSendErrorBus().error.value).toBeNull();
    expect(useVideoCompressions().jobs.value).toEqual([]);
  });
});

describe("sendPickedBatch", () => {
  it("reports the items it could not read in one banner, and logs them", async () => {
    const handles = { stale: false };
    const reads: string[] = [];
    const order: string[] = [];
    setVideoCompressionDepsForTests(makeDeps(handles, order).deps);
    const broken = { stale: true };
    const files = [
      picked("a.jpg", "image/jpeg", 2e6, handles, reads),
      picked("b.mp4", "video/mp4", 5e6, broken, reads),
      picked("c.jpg", "image/jpeg", 2e6, handles, reads),
      picked("d.mp4", "video/mp4", 90e6, broken, reads),
      picked("e.mp4", "video/mp4", 3e6, handles, reads),
    ];
    const sent: string[] = [];
    const outcome = await sendPickedBatch(files, (f) => f, (_, f) => f, makeSend(sent, order));

    expect(outcome).toMatchObject({ total: 5, sent: 3, unreadable: 2, failed: 2 });
    expect(sent).toEqual(expect.arrayContaining(["a.jpg", "c.jpg", "e.mp4"]));
    const err = useSendErrorBus().error.value!;
    expect(err.kind).toBe("batchIncomplete");
    expect(sendErrorLabel(err, t)).toBe("2 of 5 couldn't be read. Pick them again.");
    const failures = getUploadLog().filter((e) => e.e === "read:fail");
    expect(failures).toHaveLength(2);
    expect(failures[0].d).toMatchObject({ stage: "snapshot", src: "webview" });
    expect(getUploadLog().find((e) => e.e === "send:batch-done")?.d).toMatchObject({ total: 5, sent: 3, unreadable: 2 });
  });

  it("names the other failures too, with the last reason", async () => {
    const handles = { stale: false };
    const order: string[] = [];
    setVideoCompressionDepsForTests(makeDeps(handles, order).deps);
    const files = [
      picked("a.jpg", "image/jpeg", 2e6, handles, []),
      picked("b.mp4", "video/mp4", 5e6, { stale: true }, []),
      picked("c.pdf", "application/pdf", 2e6, handles, []),
    ];
    const { reportSendError } = await import("../send-error-bus");
    const { tooLargeError } = await import("../upload-size");
    const outcome = await sendPickedBatch(files, (f) => f, (_, f) => f, async (f) => {
      if (f.name !== "c.pdf") return true;
      reportSendError(tooLargeError({ name: f.name, size: 80e6, type: f.type }, LIMIT, "file"));
      return false;
    });
    expect(outcome).toMatchObject({ sent: 1, unreadable: 1, failed: 2 });
    expect(sendErrorLabel(useSendErrorBus().error.value!, t)).toBe(
      "2 of 3 were not sent. 1 couldn't be read: pick them again. File is 80.0 MB; the limit is 52 MB. It was not sent.",
    );
  });

  it("does not count a compression the user cancelled as a failure", async () => {
    const handles = { stale: false };
    const order: string[] = [];
    const { deps } = makeDeps(handles, order);
    let release!: () => void;
    const compress = deps.compress;
    deps.compress = vi.fn(async (o: CompressVideoOptions) => {
      if (o.id === "c-0001") await new Promise<void>((r) => { release = r; });
      return compress(o);
    });
    setVideoCompressionDepsForTests(deps);
    const files = [picked("a.mp4", "video/mp4", 80e6, handles, []), picked("b.mp4", "video/mp4", 80e6, handles, [])];
    const run = sendPickedBatch(files, (f) => f, (_, f) => f, makeSend([], order));
    await vi.waitFor(() => expect(useVideoCompressions().jobs.value.map((j) => j.stage)).toEqual(["compressing", "queued"]));
    await cancelVideoCompression("c-0002");
    release();
    expect(await run).toMatchObject({ sent: 1, cancelled: 1, failed: 0 });
    expect(useSendErrorBus().error.value).toBeNull();
  });

  it("passes the caption flag to the last item it can send", async () => {
    const handles = { stale: false };
    setVideoCompressionDepsForTests(makeDeps(handles, []).deps);
    const files = [picked("a.jpg", "image/jpeg", 1e6, handles, []), picked("b.jpg", "image/jpeg", 1e6, handles, []), picked("c.jpg", "image/jpeg", 1e6, { stale: true }, [])];
    const calls: [string, number, boolean][] = [];
    await sendPickedBatch(files, (f) => f, (_, f) => f, async (f, i, isLast) => {
      calls.push([f.name, i, isLast]);
      return true;
    });
    expect(calls).toEqual([["a.jpg", 0, false], ["b.jpg", 1, true]]);
  });

  it("a single unreadable file gets the plain unreadable banner", async () => {
    setVideoCompressionDepsForTests(makeDeps({ stale: false }, []).deps);
    const outcome = await sendPickedBatch([picked("a.jpg", "image/jpeg", 1e6, { stale: true }, [])], (f) => f, (_, f) => f, async () => true);
    expect(outcome).toMatchObject({ total: 1, sent: 0, unreadable: 1 });
    expect(useSendErrorBus().error.value?.kind).toBe("fileUnreadable");
  });
});
