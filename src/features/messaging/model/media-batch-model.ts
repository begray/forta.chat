/**
 * The state of a multi-item media send, for the one compact batch bar
 * (MediaBatchBar.vue) that replaces a banner or half-empty bubble per item.
 * Pure: media-batch.ts drives the transitions, this file only describes them.
 *
 * User feedback (2026-10-16): "The UI when multiple videos are uploaded is also
 * suboptimal. We can probably show just the current processing one and the
 * counter of how many are in the queue."
 */
import type { SendErrorContext, SendErrorKind } from "./send-errors";

export type BatchItemState =
  | "queued" // picked and secured, no bubble yet
  | "preparing" // being read / waiting for the compressor
  | "compressing"
  | "uploading" // bubble exists, SyncEngine is uploading it
  | "sent"
  | "failed"
  | "cancelled";

/** Why an item was not sent, one per kind of failure the summary names. */
export type BatchFailReason =
  | "unreadable" // the phone would not give us the file
  | "notCompressed" // compression failed and the original is over the limit
  | "tooLarge" // over the limit, no way to shrink it
  | "tooLong" // too long to fit even compressed
  | "upload" // the upload / send failed (bubble has Retry)
  | "serverTooLarge" // the server refused the size
  | "fileLost" // the local copy is gone, cannot retry
  | "notReady" // app not ready (db / matrix / crypto)
  | "unknown";

export interface BatchItem {
  /** The send's clientId (bubble, upload log, compression job). */
  id: string;
  /** Position in the pick. */
  index: number;
  roomId: string;
  name: string;
  kind: "image" | "video" | "file";
  thumbUrl?: string;
  state: BatchItemState;
  /** Percent of the current stage (compressing or uploading). */
  percent: number;
  /** It went through the compressor (half of its progress is the encode). */
  compressed?: boolean;
  reason?: BatchFailReason;
  /** Numbers for the summary text ("over the 52 MB limit"). */
  detail?: Pick<SendErrorContext, "sizeBytes" | "limitBytes" | "maxDurationMs" | "compressFailure">;
  /** The user asked to cancel it; applied once it reaches a cancellable step. */
  cancelRequested?: boolean;
}

export const ACTIVE_STATES: readonly BatchItemState[] = ["preparing", "compressing", "uploading"];
export const DONE_STATES: readonly BatchItemState[] = ["sent", "failed", "cancelled"];

export const isActive = (i: BatchItem): boolean => ACTIVE_STATES.includes(i.state);
export const isDone = (i: BatchItem): boolean => DONE_STATES.includes(i.state);

/** Failures the bubble can retry (its upload failed; the bytes are kept). */
export const RETRYABLE_REASONS: readonly BatchFailReason[] = ["upload"];
/** Failures where picking the file again may help. */
export const PICK_AGAIN_REASONS: readonly BatchFailReason[] = ["unreadable", "notCompressed", "notReady", "unknown"];

/** Fraction (0..1) of an item's way to "sent". A compressed video spends the
 *  first half compressing; finished items (any outcome) count as complete. */
function itemProgress(i: BatchItem): number {
  if (isDone(i)) return 1;
  const p = Math.max(0, Math.min(100, i.percent)) / 100;
  if (i.state === "compressing") return 0.5 * p;
  if (i.state === "uploading") return i.compressed ? 0.5 + 0.5 * p : p;
  return 0;
}

export interface BatchView {
  /** Items of the run, cancelled ones included. */
  total: number;
  /** Not cancelled: the N of "3 of N". */
  counted: number;
  sent: number;
  failed: number;
  cancelled: number;
  queued: number;
  active: number;
  /** The lowest-index active item: the one the bar shows. */
  current: BatchItem | null;
  /** 1-based position of `current` among the counted items. */
  position: number;
  /** 0..100 over the counted items. */
  overallPercent: number;
  finished: boolean;
  failuresByReason: Partial<Record<BatchFailReason, number>>;
  retryableIds: string[];
  canPickAgain: boolean;
}

/** Everything the bar needs, from the items of one room's run. */
export function summarizeBatch(items: readonly BatchItem[]): BatchView {
  const sorted = [...items].sort((a, b) => a.index - b.index);
  const counted = sorted.filter((i) => i.state !== "cancelled");
  const current = sorted.find(isActive) ?? null;
  const failuresByReason: Partial<Record<BatchFailReason, number>> = {};
  for (const i of sorted) {
    if (i.state !== "failed") continue;
    const r = i.reason ?? "unknown";
    failuresByReason[r] = (failuresByReason[r] ?? 0) + 1;
  }
  const failedItems = sorted.filter((i) => i.state === "failed");
  return {
    total: sorted.length,
    counted: counted.length,
    sent: sorted.filter((i) => i.state === "sent").length,
    failed: failedItems.length,
    cancelled: sorted.length - counted.length,
    queued: sorted.filter((i) => i.state === "queued").length,
    active: sorted.filter(isActive).length,
    current,
    position: current ? counted.findIndex((i) => i.id === current.id) + 1 : 0,
    overallPercent: counted.length
      ? Math.round((counted.reduce((sum, i) => sum + itemProgress(i), 0) / counted.length) * 100)
      : 100,
    finished: sorted.length > 0 && sorted.every(isDone),
    failuresByReason,
    retryableIds: failedItems.filter((i) => RETRYABLE_REASONS.includes(i.reason ?? "unknown")).map((i) => i.id),
    canPickAgain: failedItems.some((i) => PICK_AGAIN_REASONS.includes(i.reason ?? "unknown")),
  };
}

/** The next items to start: queued, in pick order, while fewer than
 *  `maxActive` are in flight (across all rooms: they share the uplink). */
export function nextToStart(items: readonly BatchItem[], maxActive: number): BatchItem[] {
  const free = maxActive - items.filter(isActive).length;
  if (free <= 0) return [];
  return items
    .filter((i) => i.state === "queued" && !i.cancelRequested)
    .sort((a, b) => a.index - b.index)
    .slice(0, free);
}

/** The failure an item's own send error stands for. */
export function reasonFromSendError(kind: SendErrorKind, ctx: SendErrorContext): {
  reason: BatchFailReason;
  detail?: BatchItem["detail"];
} {
  const detail = {
    sizeBytes: ctx.sizeBytes,
    limitBytes: ctx.limitBytes,
    maxDurationMs: ctx.maxDurationMs,
    compressFailure: ctx.compressFailure,
  };
  switch (kind) {
    case "fileUnreadable":
      return { reason: "unreadable" };
    case "fileTooLarge":
      return { reason: ctx.compressFailure ? "notCompressed" : "tooLarge", detail };
    case "videoTooLong":
      return { reason: "tooLong", detail };
    case "dbNotReady":
    case "matrixNotReady":
    case "cryptoNotReady":
      return { reason: "notReady" };
    case "uploadFailed":
    case "queueStuck":
      return { reason: "upload" };
    default:
      return { reason: "unknown" };
  }
}

/** A bubble's local row, as far as the batch cares. */
export interface BatchRow {
  clientId: string;
  status: string;
  uploadProgress?: number;
  uploadError?: string;
  localBlobUrl?: string;
}

/** The state an uploading item moves to from its bubble's row (null: still
 *  uploading). A row that is gone was cancelled (the bubble's X deletes it). */
export function stateFromRow(row: BatchRow | undefined): { state: BatchItemState; reason?: BatchFailReason } | null {
  if (!row) return { state: "cancelled" };
  switch (row.status) {
    case "synced":
    case "delivered":
    case "read":
      return { state: "sent" };
    case "cancelled":
      return { state: "cancelled" };
    case "failed":
      return {
        state: "failed",
        reason: row.uploadError === "too_large" ? "serverTooLarge" : row.uploadError === "file_lost" ? "fileLost" : "upload",
      };
    default:
      return null;
  }
}
