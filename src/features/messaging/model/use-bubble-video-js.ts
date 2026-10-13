import { computed, ref, watch, type Ref } from "vue";
import { canUseModernPlayer } from "@/shared/lib/video-js/video-player-support";
import { prepareVideoJs } from "@/shared/lib/video-js/prepare-video-js";

type ShellState = "idle" | "loading" | "ready" | "fallback";

/**
 * Video attachments in messages play in the same Video.js player as post
 * videos (plain `<video>` inside the skin, no HLS). The player chunk is
 * fetched once the video file is on the device; until then the `<video>` is
 * not mounted, so it never has to move into the skin later. Engines Video.js
 * can't run on, or a failed chunk load, keep the native controls.
 */
export function useBubbleVideoJs(objectUrl: Ref<string | null | undefined>, isVideo: () => boolean) {
  const state = ref<ShellState>("idle");

  watch(
    objectUrl,
    (url) => {
      if (!url || !isVideo() || state.value !== "idle") return;
      if (!canUseModernPlayer()) {
        state.value = "fallback";
        return;
      }
      state.value = "loading";
      prepareVideoJs().then(
        () => { state.value = "ready"; },
        (e: unknown) => {
          console.warn("[MessageBubble] Video.js failed to load, native controls:", e);
          state.value = "fallback";
        },
      );
    },
    { immediate: true },
  );

  return {
    /** The video renders inside the Video.js skin. */
    isVideoJsEnabled: computed(() => state.value === "ready"),
    /** Safe to mount the <video>: the shell decision is final. */
    isVideoShellReady: computed(() => state.value === "ready" || state.value === "fallback"),
  };
}
