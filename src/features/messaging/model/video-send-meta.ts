/**
 * Facts and a poster frame for an outgoing m.video: display size, duration
 * and a ~480 px JPEG. On Android the frame comes from the native plugin
 * (MediaMetadataRetriever, reading the compressed output or the picked
 * source); elsewhere from a <video> + canvas over the in-memory file.
 * Never throws: a video goes out without a thumbnail rather than not at all.
 */
import { Capacitor } from "@capacitor/core";
import { describeError, logUpload } from "@/shared/lib/upload-log/upload-log";
import {
  VideoCompress,
  isVideoCompressionAvailable,
  pluginErrorCode,
  type VideoThumbnailResult,
} from "@/shared/lib/video-compress/video-compress-plugin";
import type { VideoThumbnailAttachment } from "@/shared/lib/local-db/schema";
import { grabVideoFrame, type GrabbedVideoFrame } from "./video-thumbnail";
import type { VideoFacts } from "./video-message";

export const THUMB_MAX_PX = 480;
const THUMB_QUALITY = 0.78;
const THUMB_TIMEOUT_MS = 8_000;

export interface VideoSendMeta {
  facts: VideoFacts;
  thumbnail?: VideoThumbnailAttachment;
}

export interface VideoSendMetaDeps {
  nativeAvailable: () => boolean;
  nativeThumbnail: (uri: string) => Promise<VideoThumbnailResult>;
  readUri: (uri: string) => Promise<Blob>;
  deleteFile: (path: string) => Promise<void>;
  webFrame: (file: Blob) => Promise<GrabbedVideoFrame | null>;
  timeoutMs: number;
}

const realDeps: VideoSendMetaDeps = {
  nativeAvailable: isVideoCompressionAvailable,
  nativeThumbnail: (path) => VideoCompress.thumbnail({ path, maxSize: THUMB_MAX_PX, quality: Math.round(THUMB_QUALITY * 100) }),
  readUri: async (uri) => {
    const response = await fetch(Capacitor.convertFileSrc(uri));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  },
  deleteFile: async (path) => {
    try {
      const { Filesystem } = await import("@capacitor/filesystem");
      await Filesystem.deleteFile({ path });
    } catch {
      // Best effort: it lives in the cache.
    }
  },
  webFrame: async (file) => {
    const url = URL.createObjectURL(file);
    try {
      return await grabVideoFrame(url, { maxDimension: THUMB_MAX_PX, quality: THUMB_QUALITY, seekSeconds: 1 });
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  timeoutMs: THUMB_TIMEOUT_MS,
};

let deps: VideoSendMetaDeps = realDeps;

/** Test hook (null restores the real dependencies). */
export function setVideoSendMetaDepsForTests(next: Partial<VideoSendMetaDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function merge(known: VideoFacts | undefined, found: VideoFacts): VideoFacts {
  return {
    w: known?.w || found.w || undefined,
    h: known?.h || found.h || undefined,
    durationMs: known?.durationMs || found.durationMs || undefined,
  };
}

/**
 * @param file  the bytes that will be sent (in memory)
 * @param opts.uri  where the native side can read the same video (the
 *   compressed output, or the picked copy / content URI); none on web
 * @param opts.known  facts already measured (compression result, picker)
 */
export async function describeVideoForSend(
  file: Blob,
  clientId: string,
  opts: { uri?: string; known?: VideoFacts } = {},
): Promise<VideoSendMeta> {
  const d = deps;
  const startedAt = Date.now();
  const known = opts.known;
  try {
    if (opts.uri && d.nativeAvailable()) {
      const thumb = await timeout(d.nativeThumbnail(opts.uri), d.timeoutMs);
      if (!thumb) throw new Error("timeout");
      try {
        const blob = await d.readUri(thumb.uri);
        const facts = merge(known, { w: thumb.videoWidth, h: thumb.videoHeight, durationMs: thumb.durationMs });
        logUpload("video:meta", clientId, {
          via: "native", ms: Date.now() - startedAt, w: facts.w, h: facts.h, durMs: facts.durationMs, thumb: blob.size,
        });
        return {
          facts,
          thumbnail: { blob, w: thumb.width, h: thumb.height, mimetype: "image/jpeg", size: blob.size },
        };
      } finally {
        void d.deleteFile(thumb.path);
      }
    }
    const frame = await timeout(d.webFrame(file), d.timeoutMs);
    if (!frame) throw new Error("no frame");
    const facts = merge(known, {
      w: frame.videoWidth,
      h: frame.videoHeight,
      durationMs: frame.durationS > 0 ? Math.round(frame.durationS * 1000) : undefined,
    });
    logUpload("video:meta", clientId, {
      via: "web", ms: Date.now() - startedAt, w: facts.w, h: facts.h, durMs: facts.durationMs, thumb: frame.blob.size,
    });
    return {
      facts,
      thumbnail: { blob: frame.blob, w: frame.width, h: frame.height, mimetype: "image/jpeg", size: frame.blob.size },
    };
  } catch (e) {
    logUpload("video:thumb-fail", clientId, {
      ms: Date.now() - startedAt, code: pluginErrorCode(e), error: describeError(e),
    });
    return { facts: merge(known, {}) };
  }
}
