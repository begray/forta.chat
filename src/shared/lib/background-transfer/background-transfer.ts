/**
 * Background transfers: keeps media sends going with the screen off.
 *
 * Android cuts the network of a backgrounded app within minutes of the screen
 * locking (Doze), so an upload that is still running dies and restarts from
 * byte 0 on unlock. While any send is in progress we therefore run a small
 * native keep-alive foreground service (BackgroundUploadPlugin) with an
 * ongoing "Sending 3 of 12 · 40%" notification. It does not upload anything
 * itself: it only keeps the process, and with it the WebView's XHRs, the Tor
 * transfer and the video encoder, at foreground priority.
 *
 * Several parts of the send pipeline report what they are working on, each as
 * a "source" (the composer's send call, the batch runner, the video
 * compressor, the SyncEngine queue). An item (keyed by the message clientId)
 * counts as active while any source still holds it, so the hand-offs between
 * them never look like "all done". The service:
 *  - starts once work has been active for START_DELAY_MS (a small photo that
 *    is sent within a second never flashes a notification), or at once when
 *    the app is about to go to the background. Android 12+ only allows the
 *    start while the app is visible; a refused start is logged (fgs:denied)
 *    and the old resume-on-unlock restart still covers the upload;
 *  - is updated at most once per UPDATE_MIN_MS with the run's progress;
 *  - stops STOP_GRACE_MS after the last item finished.
 * Its notification's Cancel action cancels every send (the cancel handler).
 * While it runs, the native side sends a heartbeat that nudges the timers
 * Chromium throttles in a hidden page (batch ticker, queue kicks).
 *
 * Every transition is written to the upload log as fgs:* events. iOS and web
 * have no service; there the module only keeps its bookkeeping.
 */
import { logUpload, describeError } from "@/shared/lib/upload-log/upload-log";
import { tRaw } from "@/shared/lib/i18n";
import {
  BackgroundUpload,
  isBackgroundUploadAvailable,
  type KeepAliveNotice,
  type KeepAliveStopReason,
  type NotificationPermissionState,
} from "./background-transfer-plugin";

export type TransferPhase = "waiting" | "compressing" | "uploading";

export interface TransferItem {
  /** The send's clientId. */
  id: string;
  phase: TransferPhase;
  /** 0-100 of the current phase. */
  percent?: number;
  /** The item goes (went) through the compressor: half its way is the encode. */
  compressed?: boolean;
}

export interface TransferHandlers {
  /** The notification's Cancel: stop every send in `ids`. */
  cancelAll?: (ids: string[]) => void | Promise<void>;
  /** Native heartbeat while the service runs (screen off included). */
  heartbeat?: () => void;
}

export interface BackgroundTransferDeps {
  available: () => boolean;
  start: (notice: KeepAliveNotice) => Promise<void>;
  update: (notice: KeepAliveNotice) => Promise<void>;
  stop: () => Promise<void>;
  notificationPermission: () => Promise<NotificationPermissionState>;
  requestNotificationPermission: () => Promise<NotificationPermissionState>;
  /** Subscribe to the native events once. */
  listen: (events: {
    cancelAll: () => void;
    heartbeat: () => void;
    stopped: (reason: KeepAliveStopReason) => void;
  }) => void;
  isVisible: () => boolean;
  /** Subscribe to page visibility changes. */
  onVisibilityChange: (cb: (visible: boolean) => void) => void;
  now: () => number;
}

export const START_DELAY_MS = 1000;
export const STOP_GRACE_MS = 2000;
export const UPDATE_MIN_MS = 1000;
/** Runs this big (or with a video to compress) are worth the permission ask. */
const BIG_RUN_ITEMS = 2;
const NOTIF_ASKED_KEY = "forta.bg-upload.notif-asked.v1";

const nativeDeps: BackgroundTransferDeps = {
  available: isBackgroundUploadAvailable,
  start: (n) => BackgroundUpload.start(n),
  update: (n) => BackgroundUpload.update(n),
  stop: () => BackgroundUpload.stop(),
  notificationPermission: async () => (await BackgroundUpload.notificationPermission()).state,
  requestNotificationPermission: async () => (await BackgroundUpload.requestNotificationPermission()).state,
  listen: (events) => {
    void BackgroundUpload.addListener("cancelAll", events.cancelAll);
    void BackgroundUpload.addListener("heartbeat", events.heartbeat);
    void BackgroundUpload.addListener("stopped", (d) => events.stopped(d.reason));
  },
  isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  onVisibilityChange: (cb) => {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => cb(document.visibilityState !== "hidden"));
  },
  now: () => Date.now(),
};

let deps: BackgroundTransferDeps = nativeDeps;
let handlers: TransferHandlers = {};

// --- State -------------------------------------------------------------------

const sources = new Map<string, Map<string, TransferItem>>();
/** Every item seen since the service (run) started; finished = run - active. */
const run = new Set<string>();
const compressedInRun = new Set<string>();
let running = false;
/** The start was refused in this background stretch; retried when visible. */
let refused = false;
let startTimer: ReturnType<typeof setTimeout> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let lastUpdateAt = 0;
let lastNotice = "";
let askedThisSession = false;
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  if (!deps.available()) return;
  deps.listen({
    cancelAll: onNativeCancel,
    heartbeat: () => handlers.heartbeat?.(),
    stopped: onNativeStopped,
  });
  deps.onVisibilityChange((visible) => (visible ? noteVisible() : noteHidden()));
}

/** Items active right now, merged over the sources. */
function activeItems(): Map<string, TransferItem> {
  const rank: Record<TransferPhase, number> = { waiting: 0, compressing: 1, uploading: 2 };
  const merged = new Map<string, TransferItem>();
  for (const items of sources.values()) {
    for (const item of items.values()) {
      const prev = merged.get(item.id);
      const compressed = !!(prev?.compressed || item.compressed);
      if (!prev || rank[item.phase] > rank[prev.phase]) merged.set(item.id, { ...item, compressed });
      else if (compressed !== !!prev.compressed) merged.set(item.id, { ...prev, compressed });
    }
  }
  return merged;
}

/** Fraction (0..1) of an active item's way to sent. */
function itemFraction(item: TransferItem, compressed: boolean): number {
  const p = Math.max(0, Math.min(100, item.percent ?? 0)) / 100;
  if (item.phase === "compressing") return 0.5 * p;
  if (item.phase === "uploading") return compressed ? 0.5 + 0.5 * p : p;
  return compressed ? 0.5 : 0;
}

export interface RunProgress {
  total: number;
  finished: number;
  active: number;
  /** 1-based "n" of "n of total". */
  position: number;
  percent: number;
  phase: TransferPhase | null;
}

/** The run's progress, for the notification (and tests). */
export function describeRun(): RunProgress {
  const active = activeItems();
  const total = run.size;
  const finished = [...run].filter((id) => !active.has(id)).length;
  let sum = finished;
  let phase: TransferPhase | null = null;
  const rank: Record<TransferPhase, number> = { waiting: 0, compressing: 1, uploading: 2 };
  for (const item of active.values()) {
    sum += itemFraction(item, item.compressed || compressedInRun.has(item.id));
    if (phase === null || rank[item.phase] > rank[phase]) phase = item.phase;
  }
  return {
    total,
    finished,
    active: active.size,
    position: Math.min(total, finished + 1),
    percent: total ? Math.round((sum / total) * 100) : 100,
    phase,
  };
}

/** The notification's text for a run. */
export function noticeFor(p: RunProgress): KeepAliveNotice {
  const title = p.total <= 1
    ? tRaw("upload.background.titleOne", { percent: p.percent })
    : tRaw("upload.background.title", { n: p.position, total: p.total, percent: p.percent });
  const text = p.phase === "compressing"
    ? tRaw("upload.background.compressing")
    : p.phase === "uploading"
      ? tRaw("upload.background.uploading")
      : tRaw("upload.background.waiting");
  return { title, text, percent: p.percent, cancelLabel: tRaw("upload.background.cancel") };
}

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t !== null) clearTimeout(t);
  return null;
}

function recompute(): void {
  const active = activeItems();
  for (const [id, item] of active) {
    run.add(id);
    if (item.compressed || item.phase === "compressing") compressedInRun.add(id);
  }
  if (active.size > 0) {
    stopTimer = clearTimer(stopTimer);
    maybeAskNotifications(active);
    if (!deps.available()) return;
    if (running) {
      scheduleUpdate();
    } else if (!refused) {
      if (!deps.isVisible()) {
        startTimer = clearTimer(startTimer);
        void tryStart();
      } else if (startTimer === null) {
        startTimer = setTimeout(() => {
          startTimer = null;
          if (!running && activeItems().size > 0) void tryStart();
        }, START_DELAY_MS);
      }
    }
    return;
  }
  startTimer = clearTimer(startTimer);
  if (running) {
    if (stopTimer === null) {
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (activeItems().size === 0) void stopService("done");
      }, STOP_GRACE_MS);
    }
  } else {
    resetRun();
  }
}

function resetRun(): void {
  run.clear();
  compressedInRun.clear();
  lastNotice = "";
  // A new run gets a fresh start attempt.
  refused = false;
}

async function tryStart(): Promise<void> {
  if (running) return;
  running = true;
  const notice = noticeFor(describeRun());
  lastNotice = JSON.stringify(notice);
  lastUpdateAt = deps.now();
  logUpload("fgs:start", null, { items: activeItems().size, visible: deps.isVisible() });
  try {
    await deps.start(notice);
  } catch (e) {
    running = false;
    refused = true;
    logUpload("fgs:denied", null, { error: describeError(e), visible: deps.isVisible() });
  }
}

async function stopService(reason: string): Promise<void> {
  if (!running) return;
  running = false;
  updateTimer = clearTimer(updateTimer);
  const p = describeRun();
  logUpload("fgs:stop", null, { reason, n: p.total });
  resetRun();
  try {
    await deps.stop();
  } catch (e) {
    logUpload("fgs:stop-failed", null, { error: describeError(e) });
  }
}

function scheduleUpdate(): void {
  if (updateTimer !== null) return;
  const wait = Math.max(0, lastUpdateAt + UPDATE_MIN_MS - deps.now());
  if (wait === 0) {
    sendUpdate();
    return;
  }
  updateTimer = setTimeout(() => {
    updateTimer = null;
    sendUpdate();
  }, wait);
}

function sendUpdate(): void {
  if (!running) return;
  const notice = noticeFor(describeRun());
  const key = JSON.stringify(notice);
  if (key === lastNotice) return;
  lastNotice = key;
  lastUpdateAt = deps.now();
  deps.update(notice).catch(() => { /* the service is gone; "stopped" says why */ });
}

function noteHidden(): void {
  if (running || refused || !deps.available() || activeItems().size === 0) return;
  // Leaving the screen: start now, while Android still counts us as visible.
  startTimer = clearTimer(startTimer);
  void tryStart();
}

function noteVisible(): void {
  refused = false;
  if (!running && deps.available() && activeItems().size > 0) {
    startTimer = clearTimer(startTimer);
    void tryStart();
  }
}

function onNativeStopped(reason: KeepAliveStopReason): void {
  if (!running) return;
  running = false;
  updateTimer = clearTimer(updateTimer);
  // Not restarted until the app is visible again (Android would refuse it).
  refused = true;
  if (reason === "timeout") logUpload("fgs:timeout", null, { items: activeItems().size });
  else logUpload("fgs:stop", null, { reason, items: activeItems().size });
}

function onNativeCancel(): void {
  const ids = [...activeItems().keys()];
  logUpload("fgs:cancel", null, { items: ids.length });
  if (!handlers.cancelAll) return;
  Promise.resolve(handlers.cancelAll(ids)).catch((e) => {
    logUpload("fgs:cancel-failed", null, { error: describeError(e) });
  });
}

/** Ask for the notification permission once, at the first big send. Without
 *  it the service still runs; the notification is just not shown. */
function maybeAskNotifications(active: Map<string, TransferItem>): void {
  if (askedThisSession || !deps.available()) return;
  const big = run.size >= BIG_RUN_ITEMS || [...active.values()].some((i) => i.compressed || i.phase === "compressing");
  if (!big) return;
  askedThisSession = true;
  void (async () => {
    try {
      const state = await deps.notificationPermission();
      if (state === "granted") return;
      let asked = false;
      try { asked = localStorage.getItem(NOTIF_ASKED_KEY) === "1"; } catch { /* ignore */ }
      if (state === "prompt" && !asked) {
        try { localStorage.setItem(NOTIF_ASKED_KEY, "1"); } catch { /* ignore */ }
        const result = await deps.requestNotificationPermission();
        logUpload("fgs:notif", null, { state: result, asked: true });
        return;
      }
      logUpload("fgs:notif", null, { state, asked: false });
    } catch (e) {
      logUpload("fgs:notif", null, { error: describeError(e) });
    }
  })();
}

// --- Public API ----------------------------------------------------------------

/** Replace everything `source` is working on. */
export function setTransferSource(source: string, items: readonly TransferItem[]): void {
  wire();
  const map = new Map<string, TransferItem>();
  for (const item of items) map.set(item.id, item);
  if (map.size) sources.set(source, map);
  else sources.delete(source);
  recompute();
}

/** Hold `id` as active (source "send") until the returned release runs. */
export function holdTransfer(id: string): () => void {
  wire();
  const map = sources.get("send") ?? new Map<string, TransferItem>();
  map.set(id, { id, phase: "waiting" });
  sources.set("send", map);
  recompute();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = sources.get("send");
    current?.delete(id);
    if (current && current.size === 0) sources.delete("send");
    recompute();
  };
}

export function setTransferHandlers(next: TransferHandlers): void {
  handlers = next;
}

/** True while the keep-alive service runs (or is being started). */
export function isKeepAliveRunning(): boolean {
  return running;
}

/** Test hook: swap the platform dependencies (null restores the native ones)
 *  and reset all state. */
export function setBackgroundTransferDepsForTests(next: BackgroundTransferDeps | null): void {
  startTimer = clearTimer(startTimer);
  stopTimer = clearTimer(stopTimer);
  updateTimer = clearTimer(updateTimer);
  sources.clear();
  resetRun();
  running = false;
  refused = false;
  lastUpdateAt = 0;
  askedThisSession = false;
  wired = false;
  handlers = {};
  deps = next ?? nativeDeps;
}
