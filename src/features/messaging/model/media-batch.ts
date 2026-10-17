/**
 * Send a batch of picked files without losing any of them, behind one
 * compact progress bar.
 *
 * standbyfix6 field log (16:33, 19 items): the photos were read at once,
 * but every video waited for the serial compressor before its File was
 * first read. ~20 s after the pick every unread WebView File handle went
 * NotReadableError, and 14 of 19 items were dropped, 6 of them silently.
 *
 * So a batch runs in two phases:
 *  1. snapshot: every item is made independent of the picker before any
 *     compression starts. Native picks already are (our copy or a pinned
 *     URI); a big video from <input type=file> is copied into the cache
 *     (stageVideoForSend); everything else is read into memory.
 *  2. send: a batch of 2+ items is queued here, not dispatched at once.
 *     At most MAX_ACTIVE items are in flight (preparing, compressing or
 *     uploading); the rest wait with no bubble, so the chat does not fill
 *     with half-empty bubbles. Each item's errors go to the batch
 *     (captureSendErrors), and the bar ends with one summary that names
 *     the real reason per kind of failure, with Retry / Pick again.
 *
 * The queued items live in memory only: if Android kills the app mid-batch,
 * the ones that had not started yet have to be picked again (the started
 * ones are in the crash-safe upload queue as before).
 */
import { computed, ref, readonly, toRaw, type ComputedRef } from "vue";
import { describeError, fileLabel, logUpload } from "@/shared/lib/upload-log/upload-log";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import { useChatStore } from "@/entities/chat";
import { sendBatch } from "./send-batch";
import { SendError, type SendErrorContext } from "./send-errors";
import { captureSendErrors, reportSendError } from "./send-error-bus";
import { fileSourceOf, pickedAgoS, releaseFileSource, setPrepState } from "./picked-media";
import { readPickedFile } from "./read-picked-file";
import {
  cancelVideoCompression,
  stageVideoForSend,
  useVideoCompressions,
  wasCancelledByUser,
} from "./video-compression";
import {
  isActive,
  isDone,
  nextToStart,
  reasonFromSendError,
  stateFromRow,
  summarizeBatch,
  type BatchFailReason,
  type BatchItem,
  type BatchItemState,
  type BatchRow,
  type BatchView,
} from "./media-batch-model";

/** Items in flight at once: matches SyncEngine's 2 uploads per room, and
 *  lets the next video compress while the previous one uploads. */
const MAX_ACTIVE = 2;
const POLL_MS = 700;
/** "All 12 sent" stays this long before the bar goes away. */
const DONE_LINGER_MS = 2_500;

/** What a send gets from the batch: its clientId and room. */
export interface BatchSendContext {
  clientId?: string;
  roomId?: string;
}

export interface MediaBatchDeps {
  /** Make the file independent of the picker; resolves the file to send. */
  snapshot: (file: File) => Promise<File>;
  /** The bubbles' rows, or null when there is no local DB to follow them. */
  readRows: (clientIds: string[]) => Promise<BatchRow[] | null>;
  cancelUpload: (clientId: string) => Promise<void>;
  retryUpload: (clientId: string) => Promise<void>;
  currentRoomId: () => string | null;
  newId: () => string;
  /** A small URL for the bar's thumbnail (blob: ones are revoked with the item). */
  thumbUrlFor: (file: File) => string | undefined;
  pollMs: number;
  lingerMs: number;
}

async function snapshotFile(file: File): Promise<File> {
  if (fileSourceOf(file)) return file;
  if (await stageVideoForSend(file)) return file;
  return readPickedFile(file);
}

/** blob: thumbnails we created, by item id. */
const ownedUrls = new Map<string, string>();

const realDeps: MediaBatchDeps = {
  snapshot: snapshotFile,
  readRows: async (ids) => {
    if (!isChatDbReady()) return null;
    const rows = await getChatDb().db.messages.where("clientId").anyOf(ids).toArray();
    return rows.map((r) => ({
      clientId: r.clientId,
      status: r.status,
      uploadProgress: r.uploadProgress,
      uploadError: r.uploadError,
      localBlobUrl: r.localBlobUrl,
    }));
  },
  cancelUpload: async () => {},
  retryUpload: async () => {},
  currentRoomId: () => {
    try {
      return useChatStore().activeRoomId ?? null;
    } catch {
      return null;
    }
  },
  newId: () => crypto.randomUUID(),
  thumbUrlFor: (file) => {
    const source = fileSourceOf(file);
    if (source?.posterUrl) return source.posterUrl;
    if (!(file.type ?? "").startsWith("image/")) return undefined;
    if (source?.previewUrl) return source.previewUrl;
    try {
      return URL.createObjectURL(file);
    } catch {
      return undefined;
    }
  },
  pollMs: POLL_MS,
  lingerMs: DONE_LINGER_MS,
};

let deps: MediaBatchDeps = realDeps;
/** configureMediaBatch ran: deps.cancelUpload is the composer's real one. */
let cancelConfigured = false;

/** Test hook (null restores the real dependencies); also clears the batch. */
export function setMediaBatchDepsForTests(next: Partial<MediaBatchDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
  resetBatchState();
}

/** The upload cancel/retry of use-messages (set by the composer). */
export function configureMediaBatch(hooks: Pick<MediaBatchDeps, "cancelUpload" | "retryUpload">): void {
  cancelConfigured = true;
  realDeps.cancelUpload = hooks.cancelUpload;
  realDeps.retryUpload = hooks.retryUpload;
}

export interface BatchOutcome {
  total: number;
  sent: number;
  unreadable: number;
  failed: number;
  cancelled: number;
}

// --- Batch state ------------------------------------------------------------

interface Run {
  id: number;
  roomId: string;
  itemIds: string[];
  done: (outcome: BatchOutcome) => void;
}

interface Pending {
  start: () => Promise<boolean>;
  files: File[];
  runId: number;
  stopCapture?: () => void;
}

const items = ref<BatchItem[]>([]);
const pending = new Map<string, Pending>();
const runs = new Map<number, Run>();
let nextRunId = 1;
let ticker: ReturnType<typeof setInterval> | null = null;
let ticking = false;
const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resetBatchState(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  ticking = false;
  for (const t of lingerTimers.values()) clearTimeout(t);
  lingerTimers.clear();
  for (const p of pending.values()) p.stopCapture?.();
  pending.clear();
  runs.clear();
  items.value = [];
  revokeOwned(Array.from(ownedUrls.keys()));
}

function revokeOwned(ids: string[]): void {
  for (const id of ids) {
    const url = ownedUrls.get(id);
    if (!url) continue;
    ownedUrls.delete(id);
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
}

function itemById(id: string): BatchItem | undefined {
  return items.value.find((i) => i.id === id);
}

function patch(id: string, change: Partial<BatchItem>): void {
  items.value = items.value.map((i) => (i.id === id ? { ...i, ...change } : i));
}

function runItems(run: Run): BatchItem[] {
  return items.value.filter((i) => run.itemIds.includes(i.id));
}

/** Move an item to a final state, log it, and start the next one. */
function settle(id: string, state: BatchItemState, reason?: BatchFailReason, detail?: BatchItem["detail"]): void {
  const item = itemById(id);
  if (!item || isDone(item)) return;
  const failReason = state === "failed" ? reason ?? item.reason ?? "unknown" : undefined;
  patch(id, { state, reason: failReason, detail: detail ?? item.detail });
  const p = pending.get(id);
  if (p) {
    p.stopCapture?.();
    pending.delete(id);
  }
  const run = [...runs.values()].find((r) => r.itemIds.includes(id));
  if (run) {
    const list = runItems(run);
    logUpload("batch:progress", id, {
      i: list.filter(isDone).length,
      n: list.length,
      state,
      ...(failReason ? { reason: failReason } : {}),
    });
    finishRunIfDone(run);
  }
  pump();
}

function finishRunIfDone(run: Run): void {
  const list = runItems(run);
  if (!list.every(isDone)) return;
  runs.delete(run.id);
  const view = summarizeBatch(list);
  const outcome: BatchOutcome = {
    total: list.length,
    sent: view.sent,
    unreadable: view.failuresByReason.unreadable ?? 0,
    failed: view.failed,
    cancelled: view.cancelled,
  };
  logUpload("batch:done", null, {
    ok: view.sent,
    fail: view.failed,
    cancelled: view.cancelled,
    n: list.length,
    ...(view.failed ? { reasons: JSON.stringify(view.failuresByReason) } : {}),
  });
  // Without failures the bar says "All sent" briefly and goes; otherwise
  // the summary stays until it is dismissed (or a new batch replaces it).
  if (view.failed === 0) scheduleClear(run.roomId);
  run.done(outcome);
}

function scheduleClear(roomId: string): void {
  const prev = lingerTimers.get(roomId);
  if (prev) clearTimeout(prev);
  lingerTimers.set(roomId, setTimeout(() => {
    lingerTimers.delete(roomId);
    const list = items.value.filter((i) => i.roomId === roomId);
    if (list.every(isDone) && summarizeBatch(list).failed === 0) dismissBatch(roomId);
  }, deps.lingerMs));
}

/** Start queued items while there is room. */
function pump(): void {
  for (const item of nextToStart(items.value, MAX_ACTIVE)) {
    // Marked before the await inside, so the next pump() counts it.
    patch(item.id, { state: "preparing", percent: 0 });
    void startItem(item.id);
  }
  ensureTicker();
}

async function startItem(id: string): Promise<void> {
  const p = pending.get(id);
  if (!p) return;
  let ok = false;
  let thrown: unknown;
  try {
    ok = await p.start();
  } catch (e) {
    thrown = e;
  }
  const item = itemById(id);
  if (!item || isDone(item)) return;
  if (ok) {
    if (item.cancelRequested) {
      await deps.cancelUpload(id).catch(() => {});
      settle(id, "cancelled");
      return;
    }
    patch(id, { state: "uploading", percent: 0 });
    ensureTicker();
    return;
  }
  if (item.cancelRequested || p.files.some((f) => wasCancelledByUser(f))) {
    settle(id, "cancelled");
    return;
  }
  if (thrown !== undefined) {
    logUpload("batch:send-threw", id, { error: describeError(thrown) });
    if (thrown instanceof SendError) {
      const mapped = reasonFromSendError(thrown.kind, thrown.context);
      settle(id, "failed", mapped.reason, mapped.detail);
    } else {
      settle(id, "failed", "unknown");
    }
    return;
  }
  // The send reported why (captured into the item), or nothing at all.
  settle(id, "failed", item.reason ?? "unknown", item.detail);
}

function ensureTicker(): void {
  const needed = items.value.some(isActive);
  if (needed && !ticker) ticker = setInterval(() => void tick(), deps.pollMs);
  if (!needed && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** Follow the compressor and the bubbles of the items in flight. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const { jobs } = useVideoCompressions();
    for (const item of items.value) {
      if (item.state !== "preparing" && item.state !== "compressing") continue;
      const job = jobs.value.find((j) => j.id === item.id);
      if (!job) continue;
      const state: BatchItemState = job.stage === "compressing" ? "compressing" : "preparing";
      if (state !== item.state || job.percent !== item.percent || !item.compressed) {
        patch(item.id, { state, percent: job.percent, compressed: true });
      }
    }
    const uploading = items.value.filter((i) => i.state === "uploading").map((i) => i.id);
    if (uploading.length) {
      const rows = await deps.readRows(uploading);
      for (const id of uploading) {
        const item = itemById(id);
        if (!item || item.state !== "uploading") continue;
        // No local DB to follow it: the hand-off is all we can know.
        if (rows === null) {
          settle(id, "sent");
          continue;
        }
        const row = rows.find((r) => r.clientId === id);
        if (row) {
          const change: Partial<BatchItem> = {};
          if (typeof row.uploadProgress === "number" && row.uploadProgress !== item.percent) change.percent = row.uploadProgress;
          // A photo's own (optimized) bytes outlive the picker copy.
          if (item.kind === "image" && row.localBlobUrl && item.thumbUrl !== row.localBlobUrl) change.thumbUrl = row.localBlobUrl;
          if (Object.keys(change).length) patch(id, change);
        }
        const next = stateFromRow(row);
        if (next) settle(id, next.state, next.reason);
      }
    }
  } catch (e) {
    console.warn("[media-batch] tick failed:", e);
  } finally {
    ticking = false;
    ensureTicker();
  }
}

// --- Public API ---------------------------------------------------------------

/** The batch bar's state for one room. */
export function useMediaBatch(roomId: () => string | null | undefined): {
  items: ComputedRef<BatchItem[]>;
  view: ComputedRef<BatchView>;
} {
  const roomItems = computed(() => {
    const id = roomId() ?? "";
    return items.value.filter((i) => i.roomId === id);
  });
  return { items: roomItems, view: computed(() => summarizeBatch(roomItems.value)) };
}

/** All batch items (read-only), e.g. to keep their compressions out of the
 *  single-video banner. */
export function useBatchItems() {
  return readonly(items);
}

/** Cancel one item: a queued one never starts, a running one is stopped. */
export async function cancelBatchItem(id: string): Promise<void> {
  const item = itemById(id);
  if (!item || isDone(item)) return;
  logUpload("batch:cancel", id, { state: item.state });
  if (item.state === "queued") {
    for (const f of pending.get(id)?.files ?? []) void releaseFileSource(f);
    settle(id, "cancelled");
    return;
  }
  patch(id, { cancelRequested: true });
  if (item.state === "uploading") {
    await deps.cancelUpload(id).catch(() => {});
    settle(id, "cancelled");
    return;
  }
  // Preparing / compressing: stop the encode; startItem settles it.
  await cancelVideoCompression(id);
}

/** Cancel everything in the room's batch that is not sent yet. */
export async function cancelBatch(roomId: string): Promise<void> {
  const open = items.value.filter((i) => i.roomId === roomId && !isDone(i));
  logUpload("batch:cancel-all", null, { n: open.length });
  // Queued first, so nothing new starts while the running ones stop.
  const ordered = [...open].sort((a, b) => Number(b.state === "queued") - Number(a.state === "queued"));
  for (const item of ordered) await cancelBatchItem(item.id);
}

/**
 * Cancel every send (the background notification's Cancel): every open batch
 * item in every room, then the other sends in `ids` (single sends, queue
 * items recovered after a restart). `fallbackCancel` is used for those when
 * the composer never configured its cancel (nothing was sent from it yet).
 */
export async function cancelAllMedia(
  ids: readonly string[],
  fallbackCancel?: (clientId: string) => Promise<void>,
): Promise<void> {
  const rooms = [...new Set(items.value.filter((i) => !isDone(i)).map((i) => i.roomId))];
  for (const roomId of rooms) await cancelBatch(roomId);
  const inBatch = new Set(items.value.map((i) => i.id));
  const cancel = cancelConfigured || deps !== realDeps || !fallbackCancel ? deps.cancelUpload : fallbackCancel;
  for (const id of ids) {
    if (inBatch.has(id)) continue;
    // A single video still compressing has no bubble yet; stopping the
    // encode drops the send.
    await cancelVideoCompression(id);
    await cancel(id).catch((e) => console.warn("[media-batch] cancel failed:", e));
  }
}

/** Follow the items in flight now (the background service's heartbeat: the
 *  ticker's interval is throttled while the page is hidden). */
export function nudgeMediaBatch(): void {
  if (items.value.some(isActive)) void tick();
}

/** Retry the items whose upload failed (their bubbles still have the bytes). */
export async function retryBatchFailures(roomId: string): Promise<void> {
  const view = summarizeBatch(items.value.filter((i) => i.roomId === roomId));
  if (!view.retryableIds.length) return;
  logUpload("batch:retry", null, { n: view.retryableIds.length });
  runs.set(nextRunId, { id: nextRunId, roomId, itemIds: [...view.retryableIds], done: () => {} });
  nextRunId++;
  for (const id of view.retryableIds) {
    patch(id, { state: "uploading", percent: 0, reason: undefined });
    await deps.retryUpload(id).catch((e) => console.warn("[media-batch] retry failed:", e));
  }
  ensureTicker();
}

/** Close the bar (summary read, or "All sent" timed out). */
export function dismissBatch(roomId: string): void {
  const gone = items.value.filter((i) => i.roomId === roomId && isDone(i)).map((i) => i.id);
  if (!gone.length) return;
  items.value = items.value.filter((i) => !gone.includes(i.id));
  revokeOwned(gone);
}

/**
 * `send` gets each item with its index in `list`, whether it is the last one
 * actually sent (unreadable ones are skipped) so a caption meant for the end
 * of the gallery is not lost, and the clientId/room to send it with.
 *
 * A single item is sent at once with the usual banner on failure. A batch
 * resolves once every item is sent, failed or cancelled; the composer does
 * not wait for that (it closes the preview as soon as the batch is queued).
 */
export async function sendPickedBatch<T>(
  list: readonly T[],
  fileOf: (item: T) => File,
  withFile: (item: T, file: File) => T,
  send: (item: T, index: number, isLast: boolean, ctx: BatchSendContext) => Promise<boolean>,
): Promise<BatchOutcome> {
  const total = list.length;
  if (total === 0) return { total: 0, sent: 0, unreadable: 0, failed: 0, cancelled: 0 };
  const d = deps;
  const roomId = d.currentRoomId() ?? "";

  // Phase 1: snapshot everything before anything slow runs.
  const ready: { item: T; original: File; index: number }[] = [];
  const unreadable: { file: File; index: number }[] = [];
  if (total > 1) setPrepState({ done: 0, total });
  try {
    for (let i = 0; i < total; i++) {
      const original = fileOf(list[i]);
      try {
        const snap = await d.snapshot(original);
        ready.push({ item: snap === original ? list[i] : withFile(list[i], snap), original, index: i });
        if (snap !== original) void releaseFileSource(original);
      } catch (e) {
        unreadable.push({ file: original, index: i });
        logUpload("read:fail", null, {
          stage: "snapshot",
          size: original.size,
          mime: original.type || "(none)",
          name: fileLabel(original.name),
          src: fileSourceOf(original)?.kind ?? "webview",
          agoS: pickedAgoS(original),
          err: describeError(e),
        });
        void releaseFileSource(original);
      }
      if (total > 1) setPrepState({ done: i + 1, total });
    }
  } finally {
    setPrepState(null);
  }

  if (total === 1) return sendOne(ready, unreadable, fileOf, send);

  // Phase 2: queue the batch; at most MAX_ACTIVE run at once. A finished
  // summary in this room makes way for the new batch; a running batch in
  // the same room just grows ("3 of 30").
  const lingering = lingerTimers.get(roomId);
  if (lingering) clearTimeout(lingering);
  lingerTimers.delete(roomId);
  const inRoom = items.value.filter((i) => i.roomId === roomId);
  if (inRoom.length && inRoom.every(isDone)) dismissBatch(roomId);

  const runId = nextRunId++;
  const offset = items.value.filter((i) => i.roomId === roomId).reduce((m, i) => Math.max(m, i.index + 1), 0);
  const kindOf = (f: File): BatchItem["kind"] =>
    (f.type ?? "").startsWith("image/") ? "image" : (f.type ?? "").startsWith("video/") ? "video" : "file";
  const newItems: BatchItem[] = unreadable.map((u) => ({
    id: d.newId(), index: offset + u.index, roomId, name: u.file.name, kind: kindOf(u.file),
    state: "failed", percent: 0, reason: "unreadable",
  }));
  ready.forEach((r, i) => {
    const id = d.newId();
    const file = fileOf(r.item);
    const thumbUrl = d.thumbUrlFor(file);
    if (thumbUrl?.startsWith("blob:")) ownedUrls.set(id, thumbUrl);
    newItems.push({ id, index: offset + r.index, roomId, name: file.name, kind: kindOf(file), thumbUrl, state: "queued", percent: 0 });
    const isLast = i === ready.length - 1;
    const p: Pending = {
      runId,
      files: [toRaw(file), toRaw(r.original)],
      start: () => {
        p.stopCapture = captureSendErrors(id, (err) => {
          const mapped = reasonFromSendError(err.kind, err.context as SendErrorContext);
          patch(id, { reason: mapped.reason, detail: mapped.detail });
        });
        return send(r.item, r.index, isLast, { clientId: id, roomId: roomId || undefined });
      },
    };
    pending.set(id, p);
  });

  let resolveOutcome!: (o: BatchOutcome) => void;
  const outcome = new Promise<BatchOutcome>((resolve) => { resolveOutcome = resolve; });
  const run: Run = { id: runId, roomId, itemIds: newItems.map((i) => i.id), done: resolveOutcome };
  runs.set(runId, run);
  items.value = [...items.value, ...newItems];
  logUpload("batch:start", null, { n: total, unreadable: unreadable.length });
  finishRunIfDone(run); // nothing readable at all
  pump();
  return outcome;
}

/** One item: sent at once, failures in the usual banner. */
async function sendOne<T>(
  ready: { item: T; original: File; index: number }[],
  unreadable: { file: File; index: number }[],
  fileOf: (item: T) => File,
  send: (item: T, index: number, isLast: boolean, ctx: BatchSendContext) => Promise<boolean>,
): Promise<BatchOutcome> {
  if (unreadable.length) {
    const name = unreadable[0].file.name;
    reportSendError(new SendError("fileUnreadable", `Cannot read ${name}`, { fileName: name }, false));
    const outcome: BatchOutcome = { total: 1, sent: 0, unreadable: 1, failed: 1, cancelled: 0 };
    logUpload("send:batch-done", null, { ...outcome });
    return outcome;
  }
  const r = ready[0];
  const [result] = await sendBatch([r.item], (item) => send(item, r.index, true, {}), (item) => fileOf(item).name);
  const sent = result.status === "fulfilled" && result.value ? 1 : 0;
  const cancelled = !sent && (wasCancelledByUser(fileOf(r.item)) || wasCancelledByUser(r.original)) ? 1 : 0;
  const outcome: BatchOutcome = { total: 1, sent, unreadable: 0, failed: 1 - sent - cancelled, cancelled };
  logUpload("send:batch-done", null, { ...outcome });
  return outcome;
}
