import { Capacitor } from "@capacitor/core";
import { isNative } from "@/shared/lib/platform";
import { logUpload } from "@/shared/lib/upload-log/upload-log";

const STORAGE_KEY = "bastyon-chat-share-data";

export interface ExternalShareFile {
  uri: string;
  name: string;
  mimeType: string;
}

export interface ExternalShareData {
  text?: string;
  files?: ExternalShareFile[];
  /** Identity of the share intent (see shareKeyOf): repeats of the same
   *  intent are dropped, and one share is sent at most once. */
  key?: string;
}

/** Single-file shape persisted to localStorage by builds before multi-file
 *  sharing — still read back so a share pending across an update isn't lost. */
interface LegacyShareData {
  fileUri?: string;
  fileName?: string;
  mimeType?: string;
}

/** `content://` (Android provider), `file://`, or a bare absolute path —
 *  the capgo plugin (Android) and our Share Extension (iOS) both hand over
 *  bare paths to the copy they made inside the app sandbox. */
function isNativeFileUri(uri: string): boolean {
  return uri.startsWith("content://") || uri.startsWith("file://") || uri.startsWith("/");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A `file://` URI for a native file reference (bare path or `file://`),
 *  segments percent-encoded so `#`, `?` and `%` in names survive
 *  `Uri.parse` on the native side. `content://` stays as it is. */
export function toNativeFileUri(uri: string): string {
  if (uri.startsWith("content://")) return uri;
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  return "file://" + path
    .split("/")
    .map((segment) => encodeURIComponent(safeDecode(segment)))
    .join("/");
}

/** Map a native file reference to the WebView local-server URL. Path segments
 *  are re-encoded so names containing `#`, `?` or `%` don't truncate the URL. */
export function toWebViewUrl(uri: string): string {
  if (uri.startsWith("content://")) return Capacitor.convertFileSrc(uri);
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(safeDecode(segment)))
    .join("/");
  return Capacitor.convertFileSrc(encoded);
}

async function readViaFilesystem(uri: string, mimeType: string): Promise<Blob> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const result = await Filesystem.readFile({ path: uri });
  // On native, `data` is base64-encoded; on the web fallback it's already a Blob.
  if (typeof result.data !== "string") return result.data;
  const binary = atob(result.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Read a shared file into a Blob.
 *
 *  Native files are streamed through the WebView's local server
 *  (`Capacitor.convertFileSrc`). `Filesystem.readFile` moves the whole file
 *  over the bridge as a base64 string — ~1.33× the size, decoded again in a
 *  JS loop — which made screenshot shares crawl and OOM'd large files on old
 *  Android WebViews. It stays as the fallback when the local server can't
 *  serve the file.
 *
 *  On the web (browser PWA) the URL is a regular http(s) — plain `fetch`. */
export async function readShareUriAsBlob(uri: string, mimeType: string): Promise<Blob> {
  if (isNative && isNativeFileUri(uri)) {
    try {
      const response = await fetch(toWebViewUrl(uri));
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 0) {
          return blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
        }
      }
    } catch (e) {
      console.warn("[share-target] local-server read failed, falling back to Filesystem:", e);
    }
    return readViaFilesystem(uri, mimeType);
  }
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Share fetch failed: ${response.status}`);
  }
  return response.blob();
}

/** Save share data to localStorage for deferred processing (cold start / not authed) */
export function saveShareData(data: ExternalShareData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function normalizeShareData(data: ExternalShareData & LegacyShareData): ExternalShareData {
  const { fileUri, fileName, mimeType, ...rest } = data;
  if (!fileUri || rest.files?.length) return rest;
  return {
    ...rest,
    files: [
      {
        uri: fileUri,
        name: fileName || "shared_file",
        mimeType: mimeType || "application/octet-stream",
      },
    ],
  };
}

/** Read and clear deferred share data */
export function consumeShareData(): ExternalShareData | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  localStorage.removeItem(STORAGE_KEY);
  try {
    return normalizeShareData(JSON.parse(raw) as ExternalShareData & LegacyShareData);
  } catch {
    return null;
  }
}

/** Copy a `content://` file into the app's private cache directory and return
 *  the new file URI. Android 14+ revokes the UriPermission grant as soon as
 *  the calling app loses foreground — by the time the user picks a target
 *  room and taps Send, the original URI can already be `Permission Denied`
 *  (Session 48 / #710 #717). */
async function copyShareToCache(file: { uri: string; name: string }): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  // Sanitize filename — Filesystem rejects path separators, and a leaked
  // `..` would let a hostile sender write outside CacheDirectory.
  const safeName =
    file.name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^\.+/, "") || "shared_file";
  const cachedName = `share-${Date.now()}-${safeName}`;
  const read = await Filesystem.readFile({ path: file.uri });
  // Native Filesystem.readFile always returns base64-encoded string on
  // Android. A Blob here means we're on a web path that shouldn't be
  // hitting this function — bail loudly so the outer try/catch falls back
  // to the original URI instead of silently writing an empty cache file.
  if (typeof read.data !== "string") {
    throw new Error("share-target: expected base64 string from Filesystem.readFile, got Blob");
  }
  await Filesystem.writeFile({
    path: cachedName,
    data: read.data,
    directory: Directory.Cache,
  });
  const cached = await Filesystem.getUri({ path: cachedName, directory: Directory.Cache });
  return cached.uri;
}

/** The native side has normally already copied the bytes into our sandbox
 *  (Android `cache/shared_files`, iOS App Group `share-inbox`) and hands over
 *  a plain path — re-copying it through the base64 bridge only tripled the
 *  memory cost. A `content://` URI means that native copy failed and we
 *  still hold a revocable grant, so only then copy it ourselves. */
async function resolveSharedFile(file: ExternalShareFile): Promise<ExternalShareFile> {
  const resolved: ExternalShareFile = { uri: file.uri, name: file.name, mimeType: file.mimeType };
  if (!file.uri.startsWith("content://")) return resolved;
  try {
    resolved.uri = await copyShareToCache(file);
  } catch (e) {
    // Best-effort: fall back to the original URI so the sender at least has
    // a chance to read it before the permission revoke kicks in.
    console.error("[share-target] cache copy failed, falling back to original URI:", e);
  }
  return resolved;
}

// --- Share identity ----------------------------------------------------------
//
// One share must reach the chat once. The capgo plugin hands the launch
// intent over from load() (getIntent) and again from onNewIntent, and keeps
// the event for late listeners; an Activity re-created mid-send (Bridge
// reload) would deliver the very same intent again. And the composer's Send
// may be tapped again while the first send is still preparing. So every
// share carries a key, and:
//  - the same share arriving again within SHARE_REPEAT_WINDOW_MS, or while
//    it is being sent, is dropped (acceptShare);
//  - a share is sent once: claimShareSend refuses while it is being sent and
//    for the window after.

export const SHARE_REPEAT_WINDOW_MS = 15_000;

interface ShareSeen {
  arrivedAt?: number;
  sending: boolean;
  sentAt?: number;
}

const seenShares = new Map<string, ShareSeen>();

/** The identity of a share: its text and its files (path, name, type) as
 *  the plugin delivered them. The plugin copies a shared item to
 *  cache/shared_files/<its name>, so the same intent gives the same paths. */
export function shareKeyOf(data: { text?: string; files?: { uri: string; name?: string; mimeType?: string }[] }): string {
  const files = (data.files ?? []).map((f) => `${f.uri}|${f.name ?? ""}|${f.mimeType ?? ""}`);
  return JSON.stringify([data.text ?? "", files]);
}

function pruneSeen(now: number): void {
  for (const [key, s] of seenShares) {
    const last = Math.max(s.arrivedAt ?? 0, s.sentAt ?? 0);
    if (!s.sending && now - last > SHARE_REPEAT_WINDOW_MS) seenShares.delete(key);
  }
}

function recently(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at < SHARE_REPEAT_WINDOW_MS;
}

/** A share arrived. False when it is a repeat of one that arrived within
 *  the window, is being sent, or was sent within the window. */
export function acceptShare(key: string, now: number = Date.now()): boolean {
  pruneSeen(now);
  const s = seenShares.get(key);
  if (s && (s.sending || recently(s.arrivedAt, now) || recently(s.sentAt, now))) return false;
  seenShares.set(key, { arrivedAt: now, sending: false });
  return true;
}

/** The composer is about to send the share. False when it is already being
 *  sent or was sent within the window: the second Send must do nothing. */
export function claimShareSend(key: string, now: number = Date.now()): boolean {
  pruneSeen(now);
  const s = seenShares.get(key);
  if (s && (s.sending || recently(s.sentAt, now))) return false;
  seenShares.set(key, { arrivedAt: s?.arrivedAt, sending: true });
  return true;
}

/** The share's send is through (whatever the outcome). */
export function finishShareSend(key: string, now: number = Date.now()): void {
  const s = seenShares.get(key);
  seenShares.set(key, { arrivedAt: s?.arrivedAt, sending: false, sentAt: now });
}

/** Nothing of the share went out: forget it, so sharing it again works. */
export function releaseShareClaim(key: string): void {
  seenShares.delete(key);
}

/** @internal */
export function __resetShareIdentityForTests(): void {
  seenShares.clear();
}

let listenerRegistered = false;

/** Initialize the share target listener (call once on app mount, native only).
 *  Calls `onShare` when content is received from the system Share Sheet.
 *
 *  Idempotent — `singleTask` launchMode can re-deliver Intents to an existing
 *  MainActivity, so the bootstrap path may run twice in one process. Without
 *  the guard the capgo bridge ends up with two listeners and dispatches
 *  `onShare` twice per share. */
export async function initShareTargetListener(
  onShare: (data: ExternalShareData) => void,
): Promise<void> {
  if (!isNative || listenerRegistered) return;
  listenerRegistered = true;

  const { CapacitorShareTarget } = await import("@capgo/capacitor-share-target");

  await CapacitorShareTarget.addListener("shareReceived", async (event) => {
    // Keyed on what the plugin delivered, before any copy of ours (those
    // get fresh names).
    const key = shareKeyOf({ text: event.texts?.join("\n"), files: event.files });
    if (!acceptShare(key)) {
      logUpload("share:repeat", null, { n: event.files?.length ?? 0 });
      return;
    }
    const data: ExternalShareData = { key };

    if (event.texts?.length) {
      data.text = event.texts.join("\n");
    }

    if (event.files?.length) {
      const files: ExternalShareFile[] = [];
      // Sequential: a content:// fallback copy goes through base64 — doing
      // several in parallel is what OOMs low-RAM devices.
      for (const file of event.files) {
        files.push(await resolveSharedFile(file));
      }
      data.files = files;
    }

    if (data.text || data.files?.length) {
      logUpload("share:received", null, { n: data.files?.length ?? 0, text: !!data.text });
      onShare(data);
    }
  });
}

/** Reset the idempotent guard so successive tests can re-register the
 *  listener against a fresh capgo mock. Production code must not call this —
 *  it bypasses the singleton protection the singleTask launchMode relies on.
 *  @internal */
export function __resetShareTargetListenerForTests(): void {
  listenerRegistered = false;
  seenShares.clear();
}
