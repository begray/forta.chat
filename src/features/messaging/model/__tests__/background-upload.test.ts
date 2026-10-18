/**
 * The send pipeline's sources feed the background keep-alive: the engine's
 * queue, the batch items not sent yet, the compressor's jobs. The
 * notification's Cancel cancels everything; its heartbeat nudges the batch
 * ticker and the queue.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { BatchItem } from "../media-batch-model";
import type { CompressionJob } from "../video-compression";
import type { MediaWorkItem } from "@/shared/lib/local-db/sync-engine";

const transfer = vi.hoisted(() => ({
  setTransferSource: vi.fn(),
  setTransferHandlers: vi.fn(),
}));
vi.mock("@/shared/lib/background-transfer", () => transfer);

const batch = vi.hoisted(() => ({
  items: null as unknown as import("vue").Ref<BatchItem[]>,
  cancelAllMedia: vi.fn(async () => {}),
  nudgeMediaBatch: vi.fn(),
}));
vi.mock("../media-batch", () => ({
  useBatchItems: () => batch.items,
  cancelAllMedia: batch.cancelAllMedia,
  nudgeMediaBatch: batch.nudgeMediaBatch,
}));

const compress = vi.hoisted(() => ({ jobs: null as unknown as import("vue").Ref<CompressionJob[]> }));
vi.mock("../video-compression", () => ({
  useVideoCompressions: () => ({ jobs: compress.jobs }),
}));

import { batchItems, compressionItems, engineItems, initBackgroundUploads } from "../background-upload";

const item = (id: string, state: BatchItem["state"], percent = 0, compressed = false): BatchItem => ({
  id, index: 0, roomId: "!r", name: "x", kind: "video", state, percent, compressed,
});

describe("background-upload sources", () => {
  it("maps batch items, leaving out finished ones", () => {
    expect(batchItems([
      item("q", "queued"),
      item("p", "preparing"),
      item("c", "compressing", 40, true),
      item("u", "uploading", 70, true),
      item("s", "sent"),
      item("f", "failed"),
      item("x", "cancelled"),
    ])).toEqual([
      { id: "q", phase: "waiting", percent: undefined, compressed: false },
      { id: "p", phase: "waiting", percent: undefined, compressed: false },
      { id: "c", phase: "compressing", percent: 40, compressed: true },
      { id: "u", phase: "uploading", percent: 70, compressed: true },
    ]);
  });

  it("maps compression jobs and engine work", () => {
    expect(compressionItems([
      { id: "a", name: "a", stage: "queued", percent: 0 },
      { id: "b", name: "b", stage: "compressing", percent: 30 },
    ])).toEqual([
      { id: "a", phase: "waiting", percent: undefined, compressed: true },
      { id: "b", phase: "compressing", percent: 30, compressed: true },
    ]);
    const work: MediaWorkItem[] = [{ clientId: "e", phase: "uploading", percent: 12 }];
    expect(engineItems(work)).toEqual([{ id: "e", phase: "uploading", percent: 12 }]);
  });
});

describe("initBackgroundUploads", () => {
  let listener: ((w: MediaWorkItem[]) => void) | null;
  const engine = {
    setMediaWorkListener: vi.fn((cb: ((w: MediaWorkItem[]) => void) | null) => { listener = cb; }),
    processQueue: vi.fn(async () => {}),
    cancelMediaUpload: vi.fn(async () => {}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listener = null;
    batch.items = ref<BatchItem[]>([]);
    compress.jobs = ref<CompressionJob[]>([]);
  });

  it("feeds every source and tears down", async () => {
    const off = initBackgroundUploads(engine);
    listener?.([{ clientId: "e1", phase: "waiting" }]);
    expect(transfer.setTransferSource).toHaveBeenCalledWith("engine", [{ id: "e1", phase: "waiting", percent: undefined }]);

    batch.items.value = [item("b1", "queued")];
    compress.jobs.value = [{ id: "c1", name: "c", stage: "compressing", percent: 10 }];
    await nextTick();
    expect(transfer.setTransferSource).toHaveBeenCalledWith("batch", [expect.objectContaining({ id: "b1" })]);
    expect(transfer.setTransferSource).toHaveBeenCalledWith("compress", [expect.objectContaining({ id: "c1", phase: "compressing" })]);

    off();
    expect(engine.setMediaWorkListener).toHaveBeenLastCalledWith(null);
    expect(transfer.setTransferSource).toHaveBeenLastCalledWith("engine", []);
    expect(transfer.setTransferHandlers).toHaveBeenLastCalledWith({});
  });

  it("Cancel goes to cancelAllMedia with the engine as the fallback; the heartbeat nudges", async () => {
    initBackgroundUploads(engine);
    const handlers = transfer.setTransferHandlers.mock.calls[0][0];
    await handlers.cancelAll(["a", "b"]);
    expect(batch.cancelAllMedia).toHaveBeenCalledWith(["a", "b"], expect.any(Function));
    const fallback = (batch.cancelAllMedia.mock.calls[0] as unknown[])[1] as (id: string) => Promise<void>;
    await fallback("a");
    expect(engine.cancelMediaUpload).toHaveBeenCalledWith("a");

    handlers.heartbeat();
    expect(batch.nudgeMediaBatch).toHaveBeenCalledTimes(1);
    expect(engine.processQueue).toHaveBeenCalledTimes(1);
  });
});
