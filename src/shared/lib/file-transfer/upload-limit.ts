/**
 * The largest file the homeserver accepts, so a send can be refused before a
 * phone burns its mobile data on an upload the server will drop.
 *
 * pocketnet's media repo answers bodies over ~50 MiB with an nginx 502 that
 * carries no CORS header, so the WebView XHR only sees "network error" after
 * the whole body went out, and every retry sends it again. The limit comes
 * from the media config endpoint (`m.upload.size`), cached in localStorage;
 * until that answers, 50 MiB (Synapse's default) is assumed. An upload that
 * dies right after its last byte lowers the known limit for the session and
 * the next launches.
 */

/** Hard client cap, whatever the server says (upstream's MAX_UPLOAD_SIZE). */
export const APP_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Assumed while the server limit is unknown (Synapse's default). */
export const FALLBACK_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
/** A failure after the full body was sent on a file at least this big is
 *  taken as the server refusing its size, not as a network blip. */
export const TOO_LARGE_SUSPECT_BYTES = 45 * 1024 * 1024;
/** Encryption pads the file (AES-CBC block + header); leave room for it. */
export const ENCRYPTION_OVERHEAD_BYTES = 64;

const STORAGE_KEY = "forta.upload-limit.v1";
const SERVER_LIMIT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

interface StoredLimit {
  /** m.upload.size from the server, when it reported one. */
  server?: number;
  serverAt?: number;
  /** Largest size known to fail (an upload that died after its last byte). */
  learned?: number;
}

let state: StoredLimit | null = null;
let inFlight: Promise<number> | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function isSize(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function load(): StoredLimit {
  if (state) return state;
  state = {};
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredLimit) : null;
    if (parsed && typeof parsed === "object") {
      if (isSize(parsed.server)) state.server = parsed.server;
      if (isSize(parsed.serverAt)) state.serverAt = parsed.serverAt;
      if (isSize(parsed.learned)) state.learned = parsed.learned;
    }
  } catch {
    // Corrupt entry: start over.
  }
  return state;
}

function save(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch {
    // Quota / private mode: the in-memory value still applies.
  }
}

/** The limit in bytes as known right now (never waits for the network). */
export function getUploadLimitBytes(): number {
  const s = load();
  const server = isSize(s.server) ? s.server : FALLBACK_UPLOAD_LIMIT_BYTES;
  return Math.min(APP_MAX_UPLOAD_BYTES, server, s.learned ?? Infinity);
}

/** Ask the server for its limit at most once a day; resolve with the limit
 *  to apply. `fetchLimit` returns `m.upload.size` (or undefined). Never
 *  rejects: on any failure the cached or fallback limit applies. */
export function refreshUploadLimit(fetchLimit: () => Promise<number | undefined>): Promise<number> {
  const s = load();
  if (isSize(s.server) && s.serverAt && Date.now() - s.serverAt < SERVER_LIMIT_TTL_MS) {
    return Promise.resolve(getUploadLimitBytes());
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const size = await Promise.race([
        fetchLimit(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), FETCH_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (isSize(size)) {
        const cur = load();
        cur.server = size;
        cur.serverAt = Date.now();
        // A learned limit below the server's stays: a proxy in front of the
        // media repo may cut bodies the server itself would accept.
        if (cur.learned !== undefined && size <= cur.learned) delete cur.learned;
        save();
      }
    } catch {
      // Offline, 401 before login, endpoint missing: keep what we have.
    } finally {
      inFlight = null;
    }
    return getUploadLimitBytes();
  })();
  return inFlight;
}

/** An upload of `bytes` died right after its last byte went out: remember
 *  that files this big do not get through. Only above the fallback limit,
 *  i.e. when the server claimed to take more: a file under 50 MiB that fails
 *  that way may just have lost its connection, and must not lower the limit
 *  for every later send. */
export function noteUploadTooLarge(bytes: number): void {
  if (!isSize(bytes) || bytes <= FALLBACK_UPLOAD_LIMIT_BYTES) return;
  const s = load();
  const learned = Math.max(1, bytes - 1);
  if (s.learned !== undefined && s.learned <= learned) return;
  s.learned = learned;
  save();
}

/** Would a file of `bytes` (before encryption) exceed the limit? */
export function exceedsUploadLimit(bytes: number, limit = getUploadLimitBytes()): boolean {
  return bytes + ENCRYPTION_OVERHEAD_BYTES > limit;
}

/** A file size in decimal MB with one decimal ("92.8"), as the Android
 *  gallery and file manager show it. */
export function formatFileMegabytes(bytes: number): string {
  return (Math.max(bytes, 100_000) / 1_000_000).toFixed(1);
}

/** The limit in whole decimal MB, rounded down so a file "under" it fits. */
export function formatLimitMegabytes(bytes: number): string {
  return String(Math.floor(bytes / 1_000_000));
}

/** Test helper: forget the cached state. */
export function resetUploadLimitForTests(): void {
  state = null;
  inFlight = null;
}
