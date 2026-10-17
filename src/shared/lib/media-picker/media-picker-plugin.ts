import { Capacitor, registerPlugin } from "@capacitor/core";

/** One item as android/.../plugins/mediapicker/MediaPickerPlugin.kt returns it. */
export interface NativePickedItem {
  index: number;
  name: string;
  mime: string;
  /** Bytes; -1 when the provider does not say (only for uncopied items). */
  size: number;
  kind: "image" | "video";
  /** True when the bytes were copied into the app's own files dir. */
  copied: boolean;
  /** file:// of our copy, or the provider's content:// URI (big videos). */
  uri?: string;
  /** Absolute path of our copy. */
  path?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  /** file:// JPEG thumbnail (videos). */
  thumbUri?: string;
  /** Set when the item could not be read at pick time. */
  error?: string;
}

export interface NativePickResult {
  cancelled: boolean;
  items: NativePickedItem[];
  ms?: number;
  /** Content provider of the picked URIs (no paths), for the upload log. */
  authority?: string;
}

/** Native contract. There is no iOS/web implementation: callers check
 *  isNativeMediaPickerAvailable() and keep <input type=file> otherwise. */
export interface MediaPickerNativePlugin {
  pick(options: { copyVideosUpTo: number }): Promise<NativePickResult>;
  release(options: { paths: string[]; uris: string[] }): Promise<{ deleted: number }>;
  sweep(options: { olderThanMs: number }): Promise<{ removed: number }>;
  addListener(
    event: "pickProgress",
    cb: (data: { done: number; total: number }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
}

export const MediaPicker = registerPlugin<MediaPickerNativePlugin>("MediaPicker");

/** True on Android builds that ship MediaPickerPlugin. */
export function isNativeMediaPickerAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("MediaPicker");
}
