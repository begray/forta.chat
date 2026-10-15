/**
 * Upload log: a small, persisted, per-upload event log for diagnosing media
 * sends in the field (stuck photos, looping videos). Every step of the send
 * pipeline writes one line here — pick, read, local echo, op claim, encrypt,
 * upload start/progress/abort/error, event send, final state — tagged with
 * the message clientId. Users export it from Settings → About → Upload log.
 *
 * Privacy: only metadata is logged (sizes, MIME types, timings, error
 * messages). Never file contents, keys, tokens or file names: names are
 * reduced to their shape by `fileLabel`, and error text goes through
 * `redact` so URLs and bearer tokens do not leak into a shared log.
 *
 * Storage: an in-memory ring buffer mirrored to localStorage (debounced, and
 * flushed when the page is hidden), so the log survives a WebView kill or an
 * app restart. Independent of the chat DB: it also records failures that
 * happen while the DB is not ready. Logging never throws.
 */

export type UploadLogValue = string | number | boolean | null | undefined;

export interface UploadLogEntry {
  /** Epoch ms. */
  t: number;
  /** Event name, `phase:outcome` style (e.g. "upload:start"). */
  e: string;
  /** Message clientId, when the event belongs to one upload. */
  c?: string;
  /** Small key/value details. */
  d?: Record<string, string | number | boolean>;
}

const STORAGE_KEY = "forta.upload-log.v1";
export const UPLOAD_LOG_MAX_ENTRIES = 1500;
const MAX_VALUE_LENGTH = 300;
const PERSIST_DELAY_MS = 1000;

let entries: UploadLogEntry[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let flushHooked = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function load(): UploadLogEntry[] {
  if (entries) return entries;
  entries = [];
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed
          .filter((x): x is UploadLogEntry =>
            !!x && typeof x === "object" && typeof (x as UploadLogEntry).t === "number" &&
            typeof (x as UploadLogEntry).e === "string")
          .slice(-UPLOAD_LOG_MAX_ENTRIES);
      }
    }
  } catch {
    entries = [];
  }
  hookFlush();
  return entries;
}

function hookFlush(): void {
  if (flushHooked || typeof window === "undefined" || typeof document === "undefined") return;
  flushHooked = true;
  window.addEventListener("pagehide", flushUploadLog);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushUploadLog();
  });
}

/** Write the buffer to localStorage now. On a quota error keep the newer half. */
export function flushUploadLog(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const store = storage();
  if (!store || !entries) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    try {
      entries = entries.slice(-Math.floor(entries.length / 2));
      store.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Storage unavailable: the in-memory log still works for this session.
    }
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(flushUploadLog, PERSIST_DELAY_MS);
}

/** Strip URLs (keep the host), bearer tokens and access_token params. */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',]+/gi, "Bearer <redacted>")
    .replace(/(access_token=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/\b(https?|mxc|blob):\/\/([^/\s"']*)[^\s"']*/gi, "$1://$2/…")
    .slice(0, MAX_VALUE_LENGTH);
}

/** `Name: message` of any thrown value, redacted. */
export function describeError(err: unknown): string {
  if (err instanceof Error || (err && typeof err === "object" && "message" in err)) {
    const e = err as { name?: string; message?: string };
    const name = e.name && e.name !== "Error" ? `${e.name}: ` : "";
    return redact(`${name}${e.message ?? ""}`);
  }
  return redact(String(err));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape of a file name without the name itself: a UUID name becomes
 *  "uuid.jpg", "PXL_20261014_123456.jpg" becomes "name(19).jpg".
 *  A UUID name typically marks a cloud / photo-picker item. */
export function fileLabel(name: string | undefined | null): string {
  if (!name) return "(none)";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1, dot + 9).toLowerCase() : "";
  const shape = UUID_RE.test(base) ? "uuid" : `name(${base.length})`;
  return ext ? `${shape}.${ext}` : shape;
}

/** Shorten a clientId to its first 8 chars — unique enough within one log. */
function shortId(clientId: string | null | undefined): string | undefined {
  return clientId ? clientId.slice(0, 8) : undefined;
}

/** Record one upload event. Never throws. */
export function logUpload(
  event: string,
  clientId?: string | null,
  data?: Record<string, UploadLogValue>,
): void {
  try {
    const list = load();
    const entry: UploadLogEntry = { t: Date.now(), e: event };
    const c = shortId(clientId);
    if (c) entry.c = c;
    if (data) {
      const d: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined || v === null) continue;
        d[k] = typeof v === "string" ? redact(v) : typeof v === "number" ? Math.round(v * 100) / 100 : v;
      }
      if (Object.keys(d).length > 0) entry.d = d;
    }
    list.push(entry);
    if (list.length > UPLOAD_LOG_MAX_ENTRIES) list.splice(0, list.length - UPLOAD_LOG_MAX_ENTRIES);
    schedulePersist();
    for (const fn of listeners) fn();
  } catch {
    // Diagnostics must never break a send.
  }
}

/** Record a failed step: the error goes into `err`. */
export function logUploadError(
  event: string,
  clientId: string | null | undefined,
  err: unknown,
  data?: Record<string, UploadLogValue>,
): void {
  logUpload(event, clientId, { ...data, err: describeError(err) });
}

export function getUploadLog(): readonly UploadLogEntry[] {
  return load();
}

export function clearUploadLog(): void {
  entries = [];
  flushUploadLog();
  for (const fn of listeners) fn();
}

/** Subscribe to new entries (for a live count in the UI). Returns unsubscribe. */
export function onUploadLogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local time with ms: "2026-10-15 18:12:01.123". */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Plain-text export: a header, then one line per event. */
export function formatUploadLog(
  list: readonly UploadLogEntry[] = getUploadLog(),
  header: Record<string, string | undefined> = {},
): string {
  const offsetMin = -new Date().getTimezoneOffset();
  const tz = `UTC${offsetMin >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  const head = [
    `Forta Chat upload log, exported ${formatTime(Date.now())} (${tz})`,
    ...Object.entries(header)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`),
    `events: ${list.length}`,
    "",
  ];
  const lines = list.map((x) => {
    const details = x.d
      ? " " + Object.entries(x.d).map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : v}`).join(" ")
      : "";
    return `${formatTime(x.t)} [${x.c ?? "--------"}] ${x.e}${details}`;
  });
  return [...head, ...lines].join("\n") + "\n";
}

/** Test helper: drop in-memory state so the next call reloads from storage. */
export function resetUploadLogForTests(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = null;
  entries = null;
  listeners.clear();
}
