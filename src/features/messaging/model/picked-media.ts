/**
 * Where a picked file's bytes really live, when that is not the File itself.
 *
 * On Android a gallery pick used to reach us as WebView File handles on the
 * picker's content:// URIs, read lazily. In a field-tested 19-item batch
 * (standbyfix6 log, 16:33) every handle not yet read went NotReadableError
 * about 20 s after the pick, mid-batch, and 14 items were lost. Now:
 *  - the native picker (MediaPickerPlugin) copies images and small videos
 *    into the app's files dir right after the pick, and keeps big videos on
 *    their URI (persisted grant) for Media3 to compress directly;
 *  - the composer gets light "sourced" File objects (right name, type and
 *    size, no bytes); readPickedFile() loads the bytes from the source when
 *    the send runs, and the source is released once the send is persisted
 *    or dropped;
 *  - on the web path a big video is copied into the cache up front
 *    ("staged") before any compression starts (see media-batch.ts).
 */
import { ref, readonly, toRaw } from "vue";
import { Capacitor } from "@capacitor/core";
import { logUpload } from "@/shared/lib/upload-log/upload-log";
import {
  MediaPicker,
  isNativeMediaPickerAvailable,
  type NativePickResult,
} from "@/shared/lib/media-picker/media-picker-plugin";

export interface FileSource {
  /** "copy": our copy in the files dir; "uri": the provider's content://
   *  URI (big video, persisted grant); "staged": a cache copy made by the
   *  web path before compressing. */
  kind: "copy" | "uri" | "staged";
  /** file:// or content:// URI the bytes are read from (native side). */
  uri: string;
  durationMs?: number;
  width?: number;
  height?: number;
  /** URL the composer preview can show (image or video). */
  previewUrl?: string;
  /** Video poster thumbnail URL. */
  posterUrl?: string;
  /** Delete our copy / give back the grant. Called once. */
  release: () => Promise<void>;
}

export interface PickedMediaDeps {
  available: () => boolean;
  pick: (copyVideosUpTo: number) => Promise<NativePickResult>;
  release: (paths: string[], uris: string[]) => Promise<void>;
  sweep: (olderThanMs: number) => Promise<void>;
  onProgress: (cb: (data: { done: number; total: number }) => void) => Promise<() => void>;
  /** A URL the WebView can fetch for a file:// or content:// URI. */
  webUrl: (uri: string) => string;
  fetchBlob: (url: string) => Promise<Blob>;
  now: () => number;
}

const nativeDeps: PickedMediaDeps = {
  available: isNativeMediaPickerAvailable,
  pick: (copyVideosUpTo) => MediaPicker.pick({ copyVideosUpTo }),
  release: async (paths, uris) => { await MediaPicker.release({ paths, uris }); },
  sweep: async (olderThanMs) => { await MediaPicker.sweep({ olderThanMs }); },
  onProgress: async (cb) => {
    const handle = await MediaPicker.addListener("pickProgress", cb);
    return () => { void handle.remove(); };
  },
  webUrl: (uri) => Capacitor.convertFileSrc(uri),
  fetchBlob: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Reading the picked file failed: HTTP ${response.status}`);
    return response.blob();
  },
  now: () => Date.now(),
};

let deps: PickedMediaDeps = nativeDeps;

const sources = new WeakMap<File, FileSource>();
const pickedAt = new WeakMap<File, number>();

/** "Preparing 3 of 19…" while picked items are being copied or read. */
const prepState = ref<{ done: number; total: number } | null>(null);

export function usePickedMediaState() {
  return { prep: readonly(prepState) };
}

export function setPrepState(state: { done: number; total: number } | null): void {
  prepState.value = state;
}

/** Test hook: swap the platform dependencies (null restores the native ones). */
export function setPickedMediaDepsForTests(next: PickedMediaDeps | null): void {
  deps = next ?? nativeDeps;
  prepState.value = null;
}

// toRaw: a File that went through a reactive list may come back as a proxy.
export function fileSourceOf(file: File): FileSource | undefined {
  return sources.get(toRaw(file));
}

export function attachFileSource(file: File, source: FileSource): void {
  sources.set(toRaw(file), source);
}

/** Give the source back (delete our copy, release the grant). Idempotent;
 *  a File without a source is left alone. */
export async function releaseFileSource(file: File): Promise<void> {
  const source = sources.get(toRaw(file));
  if (!source) return;
  sources.delete(toRaw(file));
  try {
    await source.release();
  } catch (e) {
    console.warn("[picked-media] release failed:", e);
  }
}

/** Remember when a file was picked; read failures log how long ago that was. */
export function markPicked(file: File, at = deps.now()): void {
  if (!pickedAt.has(toRaw(file))) pickedAt.set(toRaw(file), at);
}

/** Seconds since the file was picked, or undefined. */
export function pickedAgoS(file: File): number | undefined {
  const at = pickedAt.get(toRaw(file));
  return at === undefined ? undefined : Math.round((deps.now() - at) / 100) / 10;
}

/** A File with the right name, type and size but no bytes of its own; the
 *  bytes come from its source (readSourcedFile). */
export function makeSourcedFile(name: string, type: string, size: number, source: FileSource): File {
  const file = new File([], name, { type, lastModified: deps.now() });
  Object.defineProperty(file, "size", { value: Math.max(0, size), configurable: true });
  sources.set(file, source);
  return file;
}

/** Load a sourced file's bytes into memory (our copy or the provider URI). */
export async function readSourcedFile(file: File, source: FileSource): Promise<File> {
  const blob = await deps.fetchBlob(deps.webUrl(source.uri));
  return new File([blob], file.name, { type: file.type || blob.type, lastModified: file.lastModified });
}

export interface NativePick {
  files: File[];
  /** Items the picker returned that could not be read right away. */
  unreadable: { name: string; error: string }[];
}

export function canPickNatively(): boolean {
  return deps.available();
}

/**
 * Open the Android photo picker. Resolves null when the user backs out.
 * Every returned File is already independent of the picker's grant (our
 * copy) or pinned to a persisted grant (big videos for the compressor).
 */
export async function pickMediaNatively(copyVideosUpTo: number): Promise<NativePick | null> {
  let stop: (() => void) | null = null;
  try {
    stop = await deps.onProgress(({ done, total }) => setPrepState({ done, total }));
  } catch {
    // Progress is cosmetic.
  }
  try {
    const result = await deps.pick(copyVideosUpTo);
    if (result.cancelled || result.items.length === 0) return null;
    const files: File[] = [];
    const unreadable: NativePick["unreadable"] = [];
    let copied = 0;
    for (const item of result.items) {
      if (item.error || !item.uri) {
        unreadable.push({ name: item.name, error: item.error ?? "no uri" });
        logUpload("pick:unreadable", null, { as: item.kind, mime: item.mime, size: item.size, error: item.error ?? "no uri" });
        continue;
      }
      if (item.copied) copied++;
      const paths = item.path ? [item.path] : [];
      const releaseUris = [...(item.copied ? [] : [item.uri]), ...(item.thumbUri ? [item.thumbUri] : [])];
      const source: FileSource = {
        kind: item.copied ? "copy" : "uri",
        uri: item.uri,
        durationMs: item.durationMs,
        width: item.width,
        height: item.height,
        previewUrl: deps.webUrl(item.uri),
        posterUrl: item.thumbUri ? deps.webUrl(item.thumbUri) : undefined,
        release: () => deps.release(paths, releaseUris),
      };
      const file = makeSourcedFile(item.name, item.mime, item.size, source);
      markPicked(file);
      files.push(file);
    }
    logUpload("pick:native", null, {
      n: result.items.length,
      copied,
      kept: files.length - copied,
      unreadable: unreadable.length,
      ms: result.ms,
      authority: result.authority,
    });
    return { files, unreadable };
  } finally {
    stop?.();
    setPrepState(null);
  }
}

/** Drop copies and grants left behind by a crash or a killed app. */
export async function sweepPickedMedia(olderThanMs = 6 * 60 * 60 * 1000): Promise<void> {
  if (!deps.available()) return;
  try {
    await deps.sweep(olderThanMs);
  } catch (e) {
    console.warn("[picked-media] sweep failed:", e);
  }
}
