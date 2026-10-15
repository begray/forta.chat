/**
 * Compress a picked video before it is sent, so phone videos fit the
 * server's upload limit (~50 MB on pocketnet) and cost less data.
 *
 * Runs in sendFile before the local echo: the bubble only appears once the
 * compressed file exists, and the original never reaches the upload queue.
 * Progress shows in VideoCompressBanner ("Compressing video… 40 %", with X).
 *
 * Phase 1 hands the picked File to the native side by copying it into the
 * app cache in chunks (the <input type=file> gives JS no path). A native
 * picker would skip that copy (see video-compression-progress.md).
 */
import { ref, readonly } from "vue";
import { Capacitor } from "@capacitor/core";
import { exceedsUploadLimit, getUploadLimitBytes } from "@/shared/lib/file-transfer/upload-limit";
import { describeError, fileLabel, logUpload } from "@/shared/lib/upload-log/upload-log";
import {
  VideoCompress,
  isVideoCompressionAvailable,
  pluginErrorCode,
  type CompressVideoOptions,
  type CompressVideoResult,
  type VideoProbe,
} from "@/shared/lib/video-compress/video-compress-plugin";
import { SendError } from "./send-errors";
import { reportSendError } from "./send-error-bus";
import { fetchUploadLimit, tooLargeError } from "./upload-size";
import { planVideoCompression, retryBitrate, shouldCompressVideo } from "./video-compress-plan";

export type CompressionStage = "queued" | "copying" | "compressing";

export interface CompressionJob {
  id: string;
  name: string;
  stage: CompressionStage;
  /** 0-100, compressing stage only. */
  percent: number;
}

export interface PreparedVideo {
  file: File;
  compressed: boolean;
  /** Delete the temp files; call once the send is persisted or dropped. */
  cleanup: () => Promise<void>;
}

/** Everything that touches the platform, swappable in tests. */
export interface VideoCompressionDeps {
  available: () => boolean;
  uploadLimit: () => Promise<number>;
  probe: (path: string) => Promise<VideoProbe>;
  compress: (options: CompressVideoOptions) => Promise<CompressVideoResult>;
  cancel: (id: string) => Promise<void>;
  onProgress: (cb: (data: { id: string; percent: number }) => void) => Promise<() => void>;
  /** Copy the File into the cache; resolves its file:// URI. Checks
   *  isCancelled between chunks and throws CompressionCancelled. */
  copyToCache: (file: File, cachePath: string, isCancelled: () => boolean) => Promise<string>;
  readOutput: (result: CompressVideoResult, name: string) => Promise<File>;
  deleteCacheFile: (pathOrUri: string) => Promise<void>;
  now: () => number;
}

export class CompressionCancelled extends Error {
  constructor() {
    super("Compression cancelled");
    this.name = "CompressionCancelled";
  }
}

const COPY_CHUNK_BYTES = 3 * 1024 * 1024; // a multiple of 3: clean base64 chunks
const CACHE_DIR = "video-compress";

const jobs = ref<CompressionJob[]>([]);
const cancelled = new Set<string>();
let chain: Promise<unknown> = Promise.resolve();

/** Active and queued compressions, for the banner. */
export function useVideoCompressions() {
  return { jobs: readonly(jobs), cancel: cancelVideoCompression };
}

function patchJob(id: string, patch: Partial<CompressionJob>): void {
  jobs.value = jobs.value.map((j) => (j.id === id ? { ...j, ...patch } : j));
}

function blobChunkToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

const nativeDeps: VideoCompressionDeps = {
  available: isVideoCompressionAvailable,
  uploadLimit: fetchUploadLimit,
  probe: (path) => VideoCompress.probe({ path }),
  compress: (options) => VideoCompress.compress(options),
  cancel: async (id) => { await VideoCompress.cancel({ id }); },
  onProgress: async (cb) => {
    const handle = await VideoCompress.addListener("progress", cb);
    return () => { void handle.remove(); };
  },
  copyToCache: async (file, cachePath, isCancelled) => {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    for (let offset = 0; offset < file.size || offset === 0; offset += COPY_CHUNK_BYTES) {
      if (isCancelled()) throw new CompressionCancelled();
      const data = await blobChunkToBase64(file.slice(offset, offset + COPY_CHUNK_BYTES));
      if (offset === 0) {
        await Filesystem.writeFile({ path: cachePath, data, directory: Directory.Cache, recursive: true });
      } else {
        await Filesystem.appendFile({ path: cachePath, data, directory: Directory.Cache });
      }
      if (file.size === 0) break;
    }
    const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });
    return uri;
  },
  readOutput: async (result, name) => {
    const response = await fetch(Capacitor.convertFileSrc(result.uri));
    if (!response.ok) throw new Error(`Reading the compressed video failed: HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], name, { type: "video/mp4", lastModified: Date.now() });
  },
  deleteCacheFile: async (pathOrUri) => {
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      if (pathOrUri.includes("://") || pathOrUri.startsWith("/")) {
        await Filesystem.deleteFile({ path: pathOrUri });
      } else {
        await Filesystem.deleteFile({ path: pathOrUri, directory: Directory.Cache });
      }
    } catch {
      // Best effort: the cache is evicted anyway.
    }
  },
  now: () => Date.now(),
};

let deps: VideoCompressionDeps = nativeDeps;

/** Test hook: swap the platform dependencies (null restores the native ones). */
export function setVideoCompressionDepsForTests(next: VideoCompressionDeps | null): void {
  deps = next ?? nativeDeps;
  jobs.value = [];
  cancelled.clear();
  chain = Promise.resolve();
}

/** Cancel a queued or running compression; its send is dropped. */
export async function cancelVideoCompression(id: string): Promise<void> {
  if (!jobs.value.some((j) => j.id === id)) return;
  cancelled.add(id);
  logUpload("compress:cancel", id);
  try {
    await deps.cancel(id);
  } catch {
    // The job may not have reached the native side yet; the flag stops it.
  }
}

/** Would a video picked now be compressed rather than refused for its size? */
export function canCompressVideos(): boolean {
  return deps.available();
}

/** Will sending this file go through the compressor (limit known now)? */
export function willCompressVideo(file: { size: number; type?: string }): boolean {
  return deps.available() && shouldCompressVideo(file, getUploadLimitBytes());
}

function compressedName(name: string): string {
  const base = name.replace(/\.[^./]+$/, "") || "video";
  return `${base}.mp4`;
}

function extensionOf(file: File): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(file.name);
  if (m) return `.${m[1].toLowerCase()}`;
  return file.type === "video/quicktime" ? ".mov" : ".mp4";
}

/** Fall back after a failed/impossible compression: the original if it fits
 *  the limit, otherwise the "too large" banner and nothing is sent. */
function fallBack(file: File, clientId: string, limit: number, reason: string): PreparedVideo | null {
  if (!exceedsUploadLimit(file.size, limit)) {
    logUpload("compress:fallback", clientId, { reason, sending: "original", size: file.size });
    return { file, compressed: false, cleanup: async () => {} };
  }
  logUpload("send:dropped", clientId, { reason: `too large (${reason})`, size: file.size, limit });
  reportSendError(tooLargeError(file, limit, "video"));
  return null;
}

/**
 * Prepare a picked video for sending: compress it when it is a video over
 * the threshold (or the limit) and compression is available. Resolves the
 * file to send, or null when the send must be dropped (cancelled, or too
 * large with no way to shrink it; the banner already says why).
 */
export function prepareVideoForSend(file: File, clientId: string): Promise<PreparedVideo | null> {
  if (!(file.type ?? "").startsWith("video/") || !deps.available()) {
    return Promise.resolve({ file, compressed: false, cleanup: async () => {} });
  }
  // Show it in the banner while it waits for the one before it.
  if (shouldCompressVideo(file, getUploadLimitBytes()) && !jobs.value.some((j) => j.id === clientId)) {
    jobs.value = [...jobs.value, { id: clientId, name: file.name, stage: "queued", percent: 0 }];
  }
  // One at a time: phones have few hardware encoder sessions, and parallel
  // jobs would only finish later each.
  const run = chain.then(() => prepare(file, clientId), () => prepare(file, clientId));
  chain = run.catch(() => undefined);
  return run;
}

async function prepare(file: File, clientId: string): Promise<PreparedVideo | null> {
  const d = deps;
  const forget = () => {
    cancelled.delete(clientId);
    jobs.value = jobs.value.filter((j) => j.id !== clientId);
  };
  if (cancelled.has(clientId)) {
    logUpload("compress:cancelled", clientId, { stage: "queued" });
    forget();
    return null;
  }
  const limit = await d.uploadLimit();
  if (!shouldCompressVideo(file, limit)) {
    forget();
    return { file, compressed: false, cleanup: async () => {} };
  }

  const startedAt = d.now();
  const inputPath = `${CACHE_DIR}/in-${clientId}${extensionOf(file)}`;
  const temp: string[] = [];
  const cleanup = async () => {
    const paths = temp.splice(0);
    await Promise.all(paths.map((p) => d.deleteCacheFile(p)));
  };
  const isCancelled = () => cancelled.has(clientId);
  if (jobs.value.some((j) => j.id === clientId)) patchJob(clientId, { stage: "copying" });
  else jobs.value = [...jobs.value, { id: clientId, name: file.name, stage: "copying", percent: 0 }];
  logUpload("compress:start", clientId, { size: file.size, limit, mime: file.type, name: fileLabel(file.name) });

  let stopProgress: (() => void) | null = null;
  try {
    temp.push(inputPath);
    const inputUri = await d.copyToCache(file, inputPath, isCancelled);
    if (isCancelled()) throw new CompressionCancelled();
    logUpload("compress:copied", clientId, { ms: d.now() - startedAt });

    let probe: VideoProbe;
    try {
      probe = await d.probe(inputUri);
    } catch (e) {
      logUpload("compress:fail", clientId, { stage: "probe", code: pluginErrorCode(e), error: describeError(e) });
      await cleanup();
      return fallBack(file, clientId, limit, "probe failed");
    }

    const planned = planVideoCompression(probe.durationMs, limit, probe.bitrate);
    if (!planned.ok) {
      logUpload("compress:skip", clientId, { reason: planned.reason, durMs: probe.durationMs });
      await cleanup();
      if (planned.reason === "too_long" && exceedsUploadLimit(file.size, limit)) {
        logUpload("send:dropped", clientId, { reason: "too long", durMs: probe.durationMs, maxMs: planned.maxDurationMs });
        reportSendError(new SendError(
          "videoTooLong",
          `Video too long: ${probe.durationMs} ms, max ${planned.maxDurationMs} ms`,
          { fileName: file.name, kind: "video", sizeBytes: file.size, limitBytes: limit, maxDurationMs: planned.maxDurationMs },
          false,
        ));
        return null;
      }
      return fallBack(file, clientId, limit, planned.reason);
    }

    stopProgress = await d.onProgress(({ id, percent }) => {
      if (id !== clientId) return;
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      const prev = jobs.value.find((j) => j.id === clientId)?.percent ?? 0;
      patchJob(clientId, { stage: "compressing", percent: p });
      // A line per quarter keeps the log readable.
      if (Math.floor(p / 25) > Math.floor(prev / 25)) logUpload("compress:progress", clientId, { pct: p });
    });
    patchJob(clientId, { stage: "compressing", percent: 0 });

    let { videoBitrate } = planned.plan;
    let result: CompressVideoResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (isCancelled()) throw new CompressionCancelled();
      logUpload("compress:encode", clientId, {
        attempt, durMs: probe.durationMs, inW: probe.width, inH: probe.height,
        inKbps: Math.round(probe.bitrate / 1000), kbps: Math.round(videoBitrate / 1000), short: planned.plan.shortSide,
      });
      try {
        result = await d.compress({
          id: clientId,
          path: inputUri,
          maxBytes: limit,
          videoBitrate,
          targetHeight: planned.plan.shortSide,
          audioBitrate: planned.plan.audioBitrate,
        });
      } catch (e) {
        if (pluginErrorCode(e) === "CANCELLED" || isCancelled()) throw new CompressionCancelled();
        logUpload("compress:fail", clientId, { stage: "encode", attempt, code: pluginErrorCode(e), error: describeError(e) });
        await cleanup();
        return fallBack(file, clientId, limit, "encode failed");
      }
      if (!exceedsUploadLimit(result.size, limit)) {
        temp.push(result.path);
        break;
      }
      const next = retryBitrate(videoBitrate, result.size, limit);
      logUpload("compress:oversize", clientId, { attempt, out: result.size, limit, nextKbps: next ? Math.round(next / 1000) : null });
      await d.deleteCacheFile(result.path);
      result = null;
      if (next === null || attempt === 2) break;
      videoBitrate = next;
      patchJob(clientId, { percent: 0 });
    }
    if (!result) {
      await cleanup();
      return fallBack(file, clientId, limit, "still too large");
    }
    if (isCancelled()) throw new CompressionCancelled();

    // The source copy is not needed any more; free the space now.
    await d.deleteCacheFile(inputPath);
    temp.splice(temp.indexOf(inputPath), 1);

    const output = await d.readOutput(result, compressedName(file.name));
    logUpload("compress:ok", clientId, {
      ms: d.now() - startedAt, in: file.size, out: output.size,
      w: result.width, h: result.height, durMs: result.durationMs, kbps: Math.round(result.videoBitrate / 1000),
    });
    return { file: output, compressed: true, cleanup };
  } catch (e) {
    await cleanup();
    if (e instanceof CompressionCancelled || isCancelled()) {
      logUpload("compress:cancelled", clientId, { ms: d.now() - startedAt });
      return null;
    }
    logUpload("compress:fail", clientId, { stage: "prepare", error: describeError(e) });
    return fallBack(file, clientId, limit, "prepare failed");
  } finally {
    stopProgress?.();
    forget();
  }
}

