<script setup lang="ts">
import { prepareVideoJs } from "@/shared/lib/video-js/prepare-video-js";
import { videoFrame } from "@/shared/lib/video-frame";
import VideoJsFrame from "@/shared/ui/video-js-frame/VideoJsFrame.vue";
import { useVideoJsPlayer, type VideoJsStore } from "../model/use-video-js-player";
import { BLANK_VIDEO_POSTER } from "@/shared/lib/video-poster";

/**
 * PeerTube video in the Video.js 10 player: HLS with automatic quality, our
 * skin colours, PiP (Android through the native plugin). The host checks
 * `canUseModernPlayer()` before rendering this and falls back to the plain
 * `<video>` player on `fatal-error`.
 */
interface Props {
  /** HLS master playlist. */
  src: string;
  poster?: string;
  autoplay?: boolean;
  persistKey?: string;
  /** Width / height from the PeerTube API — sizes the container. */
  aspectRatio?: number | null;
}

const props = withDefaults(defineProps<Props>(), { poster: "", autoplay: false, aspectRatio: null });
const emit = defineEmits<{ "fatal-error": [] }>();

const frameRef = ref<InstanceType<typeof VideoJsFrame> | null>(null);
const isLoaded = ref(false);
const frame = computed(() => videoFrame(props.aspectRatio));

const { attach } = useVideoJsPlayer({
  autoplay: props.autoplay,
  persistKey: props.persistKey,
  onFatalError: () => emit("fatal-error"),
});

let unmounted = false;

onMounted(async () => {
  try {
    await prepareVideoJs();
  } catch (e) {
    console.warn("[PeerTubePlayer] Video.js failed to load:", e);
    if (!unmounted) emit("fatal-error");
    return;
  }
  if (unmounted) return;
  isLoaded.value = true;
  await nextTick();
  if (unmounted) return;

  // The store exists from the element's construction (upgraded on creation:
  // the chunk is loaded before we render it).
  const player = frameRef.value?.playerRef as (HTMLElement & { store?: VideoJsStore }) | null | undefined;
  const store = player?.store;
  if (store) {
    attach(store);
  } else {
    console.warn("[PeerTubePlayer] player store is missing");
    emit("fatal-error");
  }
});

onBeforeUnmount(() => {
  unmounted = true;
});
</script>

<template>
  <div
    class="relative mx-auto overflow-hidden rounded-lg bg-black"
    :class="frame.class"
    :style="frame.style"
    :data-orientation="frame.orientation"
    data-testid="peertube-player"
  >
    <VideoJsFrame v-if="isLoaded" ref="frameRef">
      <hls-video :src="src" :poster="poster || BLANK_VIDEO_POSTER" playsinline preload="metadata" />
    </VideoJsFrame>

    <!-- Poster + spinner while the player chunk loads -->
    <template v-else>
      <img v-if="poster" :src="poster" alt="" class="h-full w-full object-contain" />
      <div class="absolute inset-0 flex items-center justify-center bg-black/30">
        <div class="contain-strict h-10 w-10 animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
      </div>
    </template>
  </div>
</template>
