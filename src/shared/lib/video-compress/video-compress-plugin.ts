import { Capacitor, registerPlugin } from "@capacitor/core";

/** What the native side reads from a video file. Width/height are display
 *  dimensions (rotation applied). */
export interface VideoProbe {
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  /** Overall bitrate in bit/s; 0 when the container does not say. */
  bitrate: number;
  mime?: string | null;
}

export interface CompressVideoOptions {
  /** Caller-chosen job id; the same id cancels the job and tags progress. */
  id: string;
  /** Absolute path, file:// or content:// URI of the source video. */
  path: string;
  /** Size the output must fit (the native fallback sizes the bitrate from it). */
  maxBytes: number;
  /** Explicit H.264 bitrate in bit/s (see planVideoCompression). */
  videoBitrate?: number;
  /** Short side of the output in pixels; never upscaled. Default 720. */
  targetHeight?: number;
  /** AAC bitrate in bit/s. Default 128000. */
  audioBitrate?: number;
}

export interface CompressVideoResult {
  path: string;
  uri: string;
  size: number;
  durationMs: number;
  width: number;
  height: number;
  videoBitrate: number;
}

/** Native contract of android/.../plugins/videocompress/VideoCompressPlugin.kt.
 *  Rejections carry `code`: NOT_VIDEO, PROBE_FAILED, TOO_LONG, FAILED,
 *  CANCELLED, BUSY. There is no iOS/web implementation: callers check
 *  isVideoCompressionAvailable() first and keep the old behaviour. */
export interface VideoCompressNativePlugin {
  probe(options: { path: string }): Promise<VideoProbe>;
  compress(options: CompressVideoOptions): Promise<CompressVideoResult>;
  cancel(options: { id: string }): Promise<{ cancelled: boolean }>;
  addListener(
    event: "progress",
    cb: (data: { id: string; percent: number }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
}

export const VideoCompress = registerPlugin<VideoCompressNativePlugin>("VideoCompress");

/** True on Android builds that ship VideoCompressPlugin. */
export function isVideoCompressionAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("VideoCompress");
}

/** The error code of a rejected plugin call ("CANCELLED", "TOO_LONG", ...). */
export function pluginErrorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
