import { isAndroid, isNative } from "@/shared/lib/platform";
import { loadVideoJs } from "./load-video-js";
import { installAndroidVideoPip } from "./android-pip";

/**
 * Everything a Video.js player needs before it renders: the lazy chunk and,
 * in the Android app, the native PiP bridge (Video.js reads PiP support when
 * the player attaches). Both run in parallel. Rejects only when the chunk
 * fails to load — the caller then falls back to its plain player.
 */
export function prepareVideoJs(): Promise<void> {
  return Promise.all([
    isNative && isAndroid ? installAndroidVideoPip() : Promise.resolve(),
    loadVideoJs(),
  ]).then(() => undefined);
}
