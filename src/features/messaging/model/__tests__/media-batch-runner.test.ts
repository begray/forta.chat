// @vitest-environment happy-dom
/**
 * The batch runner behind MediaBatchBar: at most two items in flight, no
 * bubble (send) for the rest until they start, cancel one / cancel all, and
 * one summary with a reason per kind of failure. Sends and bubble rows are
 * fakes the tests drive by hand.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => ({}) }));

import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";
import { __resetSendErrorBusForTests, reportSendError, useSendErrorBus } from "../send-error-bus";
import { SendError } from "../send-errors";
import {
  cancelBatch,
  cancelBatchItem,
  dismissBatch,
  retryBatchFailures,
  sendPickedBatch,
  setMediaBatchDepsForTests,
  useMediaBatch,
  type BatchOutcome,
  type BatchSendContext,
} from "../media-batch";
import type { BatchRow } from "../media-batch-model";

const ROOM = "!family:server";

/** A send the test resolves by hand; the bubble row appears when it does. */
interface FakeSend {
  file: File;
  ctx: BatchSendContext;
  isLast: boolean;
  resolve: (ok: boolean) => void;
}

let sends: FakeSend[];
let rows: Map<string, BatchRow>;
let cancelUpload: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let retryUpload: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;

function file(name: string, type = "video/mp4"): File {
  return new File(["x"], name, { type });
}

function send(f: File, _i: number, isLast: boolean, ctx: BatchSendContext): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    sends.push({
      file: f,
      ctx,
      isLast,
      resolve: (ok) => {
        if (ok) rows.set(ctx.clientId!, { clientId: ctx.clientId!, status: "pending", uploadProgress: 0 });
        resolve(ok);
      },
    });
  });
}

const view = () => useMediaBatch(() => ROOM).view.value;
const items = () => useMediaBatch(() => ROOM).items.value;
const sentNames = () => sends.map((s) => s.file.name);
const settle = () => new Promise((r) => setTimeout(r, 20));

function setRow(clientId: string, change: Partial<BatchRow>): void {
  rows.set(clientId, { ...rows.get(clientId)!, ...change });
}

function start(names: string[]): Promise<BatchOutcome> {
  return sendPickedBatch(names.map((n) => file(n)), (f) => f, (_, f) => f, send);
}

let ids = 0;
beforeEach(() => {
  sends = [];
  rows = new Map();
  ids = 0;
  cancelUpload = vi.fn<(id: string) => Promise<void>>(async (id) => { rows.delete(id); });
  retryUpload = vi.fn<(id: string) => Promise<void>>(async (id) => { setRow(id, { status: "pending", uploadProgress: 0 }); });
  resetUploadLogForTests();
  __resetSendErrorBusForTests();
  setMediaBatchDepsForTests(baseDeps());
});
afterEach(() => setMediaBatchDepsForTests(null));

function baseDeps(): Parameters<typeof setMediaBatchDepsForTests>[0] {
  return {
    snapshot: async (f) => f,
    readRows: async (wanted) => wanted.map((id) => rows.get(id)).filter((r): r is BatchRow => !!r),
    cancelUpload,
    retryUpload,
    currentRoomId: () => ROOM,
    newId: () => `c${++ids}`,
    thumbUrlFor: () => undefined,
    pollMs: 5,
    lingerMs: 50,
  };
}

describe("batch runner", () => {
  it("starts at most two items, in pick order, and none of the rest until a slot frees", async () => {
    const run = start(["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4"]);
    await settle();
    expect(sentNames()).toEqual(["a.mp4", "b.mp4"]);
    expect(view()).toMatchObject({ total: 5, queued: 3, active: 2, position: 1 });
    expect(sends[0].ctx).toEqual({ clientId: "c1", roomId: ROOM });

    sends[0].resolve(true); // a is uploading, b still preparing
    sends[1].resolve(true);
    await settle();
    expect(sentNames()).toEqual(["a.mp4", "b.mp4"]); // both still in flight
    setRow("c1", { uploadProgress: 40 });
    await settle();
    expect(view().current).toMatchObject({ id: "c1", state: "uploading", percent: 40 });

    setRow("c2", { status: "synced" });
    await settle();
    expect(sentNames()).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(view()).toMatchObject({ sent: 1, queued: 2 });

    // Each finished upload lets the next one start.
    sends[2].resolve(true);
    setRow("c1", { status: "synced" });
    await vi.waitFor(() => expect(sends).toHaveLength(4));
    sends[3].resolve(true);
    setRow("c3", { status: "synced" });
    await vi.waitFor(() => expect(sends).toHaveLength(5));
    sends[4].resolve(true);
    for (const id of ["c4", "c5"]) setRow(id, { status: "synced" });
    expect(await run).toEqual({ total: 5, sent: 5, unreadable: 0, failed: 0, cancelled: 0 });
    // The caption flag went to the last item only.
    expect(sends.map((s) => s.isLast)).toEqual([false, false, false, false, true]);
    expect(view()).toMatchObject({ finished: true, sent: 5 });
    const log = getUploadLog().map((e) => e.e);
    expect(log.filter((e) => e === "batch:start")).toHaveLength(1);
    expect(log.filter((e) => e === "batch:progress")).toHaveLength(5);
    expect(getUploadLog().find((e) => e.e === "batch:done")?.d).toMatchObject({ ok: 5, fail: 0, n: 5 });
    // "All 5 sent" goes away by itself.
    await new Promise((r) => setTimeout(r, 80));
    expect(view().total).toBe(0);
  });

  it("cancels one queued item without ever sending it", async () => {
    const run = start(["a.mp4", "b.mp4", "c.mp4"]);
    await settle();
    await cancelBatchItem("c3");
    expect(items().find((i) => i.id === "c3")?.state).toBe("cancelled");
    sends[0].resolve(true);
    sends[1].resolve(true);
    setRow("c1", { status: "synced" });
    setRow("c2", { status: "synced" });
    expect(await run).toMatchObject({ sent: 2, cancelled: 1, failed: 0 });
    expect(sentNames()).toEqual(["a.mp4", "b.mp4"]);
    expect(view().counted).toBe(2);
  });

  it("cancels one uploading item through the bubble's cancel", async () => {
    const run = start(["a.mp4", "b.mp4"]);
    await settle();
    sends[0].resolve(true);
    sends[1].resolve(true);
    await settle();
    await cancelBatchItem("c1");
    expect(cancelUpload).toHaveBeenCalledWith("c1");
    setRow("c2", { status: "synced" });
    expect(await run).toMatchObject({ sent: 1, cancelled: 1 });
  });

  it("an item cancelled while it was still preparing is cancelled once its send lands", async () => {
    const run = start(["a.mp4", "b.mp4"]);
    await settle();
    await cancelBatchItem("c1");
    sends[0].resolve(true); // the echo was already on its way
    sends[1].resolve(true);
    setRow("c2", { status: "synced" });
    expect(await run).toMatchObject({ sent: 1, cancelled: 1 });
    expect(cancelUpload).toHaveBeenCalledWith("c1");
  });

  it("cancel all stops the rest; what was sent stays sent", async () => {
    const run = start(["a.mp4", "b.mp4", "c.mp4", "d.mp4"]);
    await settle();
    sends[0].resolve(true);
    await settle();
    setRow("c1", { status: "synced" });
    await settle();
    expect(sentNames()).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    sends[2].resolve(true); // c uploading, b still preparing, d queued
    await settle();

    await cancelBatch(ROOM);
    sends[1].resolve(false); // b's prepare gave up after the cancel
    const outcome = await run;
    expect(outcome).toEqual({ total: 4, sent: 1, unreadable: 0, failed: 0, cancelled: 3 });
    expect(sentNames()).not.toContain("d.mp4");
    expect(cancelUpload).toHaveBeenCalledWith("c3");
    expect(getUploadLog().some((e) => e.e === "batch:cancel-all")).toBe(true);
  });

  it("ends with one summary that names each failure's own reason, and no banner", async () => {
    setMediaBatchDepsForTests({
      ...baseDeps(),
      snapshot: async (f) => {
        if (f.name === "broken.mp4") throw Object.assign(new Error("gone"), { name: "NotReadableError" });
        return f;
      },
    });
    const files = [file("a.mp4"), file("broken.mp4"), file("big.mp4"), file("long.mp4"), file("net.jpg", "image/jpeg")];
    const run = sendPickedBatch(
      files,
      (f) => f,
      (_, f) => f,
      async (f, i, last, ctx) => {
        if (f.name === "big.mp4") {
          // What prepareVideoForSend reports when the encode failed and the
          // original is over the limit (the 171 MB case of the screenshot).
          reportSendError(new SendError("fileTooLarge", "too large", {
            fileName: f.name, kind: "video", sizeBytes: 171e6, limitBytes: 52e6, compressFailure: "encode failed", clientId: ctx.clientId,
          }, false));
          return false;
        }
        if (f.name === "long.mp4") {
          reportSendError(new SendError("videoTooLong", "too long", { maxDurationMs: 600_000, clientId: ctx.clientId }, false));
          return false;
        }
        return send(f, i, last, ctx);
      },
    );
    // snapshot: broken.mp4 cannot be read
    void run;
    await settle();
    // a + net are the sends that reach the fake (big/long fail before a bubble)
    await vi.waitFor(() => expect(sentNames()).toEqual(["a.mp4", "net.jpg"]));
    sends[0].resolve(true);
    sends[1].resolve(true);
    await settle();
    setRow(sends[0].ctx.clientId!, { status: "synced" });
    setRow(sends[1].ctx.clientId!, { status: "failed" });
    const outcome = await run;
    expect(outcome).toMatchObject({ total: 5, sent: 1, failed: 4 });
    expect(useSendErrorBus().error.value).toBeNull();
    expect(view()).toMatchObject({
      finished: true,
      failed: 4,
      failuresByReason: { unreadable: 1, notCompressed: 1, tooLong: 1, upload: 1 },
      retryableIds: [sends[1].ctx.clientId],
      canPickAgain: true,
    });
    const big = items().find((i) => i.name === "big.mp4")!;
    expect(big.detail).toMatchObject({ sizeBytes: 171e6, limitBytes: 52e6, compressFailure: "encode failed" });
    expect(getUploadLog().find((e) => e.e === "batch:done")?.d).toMatchObject({ ok: 1, fail: 4 });
  });

  it("Retry re-sends the failed uploads and follows them again", async () => {
    const run = start(["a.mp4", "b.mp4"]);
    await settle();
    sends[0].resolve(true);
    sends[1].resolve(true);
    await settle();
    setRow("c1", { status: "synced" });
    setRow("c2", { status: "failed" });
    await run;
    expect(view().retryableIds).toEqual(["c2"]);

    await retryBatchFailures(ROOM);
    expect(retryUpload).toHaveBeenCalledWith("c2");
    expect(view()).toMatchObject({ finished: false, active: 1 });
    setRow("c2", { status: "synced" });
    await vi.waitFor(() => expect(view()).toMatchObject({ finished: true, sent: 2, failed: 0 }));
  });

  it("a send that throws fails its item instead of vanishing", async () => {
    const run = sendPickedBatch([file("a.mp4"), file("b.mp4")], (f) => f, (_, f) => f, async (f, i, last, ctx) => {
      if (f.name === "a.mp4") throw new SendError("matrixNotReady", "not ready", {});
      return send(f, i, last, ctx);
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    sends[0].resolve(true);
    await settle();
    setRow("c2", { status: "synced" });
    expect(await run).toMatchObject({ sent: 1, failed: 1 });
    expect(view().failuresByReason).toEqual({ notReady: 1 });
  });

  it("only shows the batch of the open chat, and a new batch there replaces an old summary", async () => {
    const run = start(["a.mp4", "b.mp4"]);
    await settle();
    expect(useMediaBatch(() => "!other:server").view.value.total).toBe(0);
    sends[0].resolve(true);
    sends[1].resolve(true);
    await settle();
    setRow("c1", { status: "failed" });
    setRow("c2", { status: "synced" });
    await run;
    expect(view()).toMatchObject({ finished: true, failed: 1 });

    void start(["c.mp4", "d.mp4"]);
    await settle();
    expect(view()).toMatchObject({ total: 2, failed: 0, finished: false });
    dismissBatch(ROOM); // only finished items go
    expect(view().total).toBe(2);
  });
});
