import { describe, it, expect } from "vitest";
import {
  nextToStart,
  reasonFromSendError,
  stateFromRow,
  summarizeBatch,
  type BatchItem,
} from "../media-batch-model";

function item(index: number, state: BatchItem["state"], extra: Partial<BatchItem> = {}): BatchItem {
  return { id: `c${index}`, index, roomId: "!r", name: `v${index}.mp4`, kind: "video", state, percent: 0, ...extra };
}

describe("summarizeBatch", () => {
  it("counts each state and points at the lowest-index active item", () => {
    const view = summarizeBatch([
      item(3, "queued"),
      item(0, "sent"),
      item(2, "uploading", { percent: 40 }),
      item(1, "compressing", { percent: 80, compressed: true }),
      item(4, "queued"),
    ]);
    expect(view).toMatchObject({ total: 5, counted: 5, sent: 1, failed: 0, cancelled: 0, queued: 2, active: 2, position: 2, finished: false });
    expect(view.current?.id).toBe("c1");
  });

  it("leaves cancelled items out of 'n of N' and the overall progress", () => {
    const view = summarizeBatch([
      item(0, "sent"),
      item(1, "cancelled"),
      item(2, "uploading", { percent: 50 }),
      item(3, "queued"),
    ]);
    expect(view.counted).toBe(3);
    expect(view.position).toBe(2); // "Uploading 2 of 3"
    // (1 + 0.5 + 0) / 3
    expect(view.overallPercent).toBe(50);
  });

  it("weights a compressed video: half encode, half upload", () => {
    expect(summarizeBatch([item(0, "compressing", { percent: 50, compressed: true })]).overallPercent).toBe(25);
    expect(summarizeBatch([item(0, "uploading", { percent: 50, compressed: true })]).overallPercent).toBe(75);
    expect(summarizeBatch([item(0, "uploading", { percent: 50 })]).overallPercent).toBe(50);
  });

  it("groups failures by reason for one summary, with what Retry / Pick again can fix", () => {
    const view = summarizeBatch([
      item(0, "sent"),
      item(1, "failed", { reason: "unreadable" }),
      item(2, "failed", { reason: "upload" }),
      item(3, "failed", { reason: "upload" }),
      item(4, "failed", { reason: "tooLong" }),
      item(5, "cancelled"),
    ]);
    expect(view.finished).toBe(true);
    expect(view.failed).toBe(4);
    expect(view.failuresByReason).toEqual({ unreadable: 1, upload: 2, tooLong: 1 });
    expect(view.retryableIds).toEqual(["c2", "c3"]);
    expect(view.canPickAgain).toBe(true);
  });

  it("offers no Pick again when nothing a new pick would fix failed", () => {
    const view = summarizeBatch([item(0, "failed", { reason: "tooLong" }), item(1, "failed", { reason: "serverTooLarge" })]);
    expect(view.canPickAgain).toBe(false);
    expect(view.retryableIds).toEqual([]);
  });

  it("an empty batch is not finished", () => {
    expect(summarizeBatch([]).finished).toBe(false);
  });
});

describe("nextToStart", () => {
  it("starts queued items in pick order while fewer than max are in flight", () => {
    const items = [item(2, "queued"), item(0, "uploading"), item(1, "queued"), item(3, "queued")];
    expect(nextToStart(items, 2).map((i) => i.id)).toEqual(["c1"]);
    expect(nextToStart(items, 3).map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(nextToStart([item(0, "uploading"), item(1, "compressing"), item(2, "queued")], 2)).toEqual([]);
  });

  it("skips an item whose cancel is pending", () => {
    expect(nextToStart([item(0, "queued", { cancelRequested: true }), item(1, "queued")], 2).map((i) => i.id)).toEqual(["c1"]);
  });
});

describe("reasonFromSendError", () => {
  it("tells a failed compression apart from a plain size refusal", () => {
    expect(reasonFromSendError("fileTooLarge", { sizeBytes: 171e6, limitBytes: 52e6, compressFailure: "encode failed" }))
      .toMatchObject({ reason: "notCompressed", detail: { sizeBytes: 171e6, limitBytes: 52e6 } });
    expect(reasonFromSendError("fileTooLarge", { sizeBytes: 80e6, limitBytes: 52e6 }).reason).toBe("tooLarge");
  });

  it("maps the other kinds", () => {
    expect(reasonFromSendError("fileUnreadable", {}).reason).toBe("unreadable");
    expect(reasonFromSendError("videoTooLong", { maxDurationMs: 600_000 })).toMatchObject({ reason: "tooLong", detail: { maxDurationMs: 600_000 } });
    expect(reasonFromSendError("matrixNotReady", {}).reason).toBe("notReady");
    expect(reasonFromSendError("unknown", {}).reason).toBe("unknown");
  });
});

describe("stateFromRow", () => {
  it("follows the bubble to its end state", () => {
    expect(stateFromRow({ clientId: "c", status: "pending" })).toBeNull();
    expect(stateFromRow({ clientId: "c", status: "syncing" })).toBeNull();
    expect(stateFromRow({ clientId: "c", status: "synced" })).toEqual({ state: "sent" });
    expect(stateFromRow({ clientId: "c", status: "failed" })).toEqual({ state: "failed", reason: "upload" });
    expect(stateFromRow({ clientId: "c", status: "failed", uploadError: "too_large" })).toEqual({ state: "failed", reason: "serverTooLarge" });
    expect(stateFromRow({ clientId: "c", status: "failed", uploadError: "file_lost" })).toEqual({ state: "failed", reason: "fileLost" });
    expect(stateFromRow({ clientId: "c", status: "cancelled" })).toEqual({ state: "cancelled" });
    // The bubble's X deletes the row.
    expect(stateFromRow(undefined)).toEqual({ state: "cancelled" });
  });
});
