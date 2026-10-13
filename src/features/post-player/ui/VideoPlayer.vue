<script setup lang="ts">
import { parseVideoUrl, fetchPeerTubeSources, type PeerTubeSources } from "@/shared/lib/video-embed";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
import { isNative } from "@/shared/lib/platform";
import { openExternalUrl } from "@/shared/lib/open-external-url";
import { canUseModernPlayer } from "@/shared/lib/video-js/video-player-support";
import { videoFrame } from "@/shared/lib/video-frame";
import FeedVideoPlayer from "@/shared/ui/feed-video-player/FeedVideoPlayer.vue";
import PeerTubePlayer from "./PeerTubePlayer.vue";

interface Props {
  url: string;
  /** Feed tile: a tap opens the post modal instead of playing in place. */
  inline?: boolean;
  /** Start playback on mount (modal opened from a feed tap — WEE-82/#963). */
  autoplay?: boolean;
}

const props = withDefaults(defineProps<Props>(), { inline: false, autoplay: false });

const emit = defineEmits<{ expand: [] }>();
const { t } = useI18n();

const videoInfo = computed(() => parseVideoUrl(props.url));
const isPeerTube = computed(() => videoInfo.value?.type === "peertube");

/**
 * PeerTube playback ladder (no iframe — the embed ignores autoplay on iOS and
 * locks feed gestures on Android):
 * 1. `hls`  — Video.js HLS player, adaptive quality, PiP;
 * 2. `file` — plain <video> with one mp4, for WebViews Video.js can't run on
 *            or when HLS fails;
 * 3. `error` — nothing plays here; offer the video's page externally.
 */
type PeerTubeMode = "loading" | "hls" | "file" | "error";
const peerTubeMode = ref<PeerTubeMode>("loading");
const sources = ref<PeerTubeSources | null>(null);
const peertubeThumb = ref("");

// Feed tile and iframe (YouTube / Vimeo) state
const playing = ref(false);
const error = ref(false);
const iframeLoaded = ref(false);
const spinnerTimedOut = ref(false);
const isFullscreen = ref(false);

// Belt-and-suspenders for old Android WebViews where iframe @load may never
// fire: stop showing our overlay spinner after this long so it can't become
// an "eternal spinner". The "Open externally" fallback stays available.
const SPINNER_TIMEOUT_MS = 10_000;
let spinnerTimer: ReturnType<typeof setTimeout> | null = null;

const clearSpinnerTimer = () => {
  if (spinnerTimer !== null) {
    clearTimeout(spinnerTimer);
    spinnerTimer = null;
  }
};

const thumbUrl = computed(() => peertubeThumb.value || videoInfo.value?.thumbUrl || "");
// Modal player container sized by the video's own ratio (vertical < 0.9).
const peerTubeFrame = computed(() => videoFrame(sources.value?.aspectRatio));
const externalUrl = computed(() => videoInfo.value?.watchUrl ?? props.url);

// Android WebView blocks autoplay for cross-origin sandboxed iframes, so the
// embed silently never starts (WEE-70). On native we drop ?autoplay=1 and let
// the user tap play inside the embed; on web/desktop autoplay works.
const embedSrc = computed(() => {
  const base = videoInfo.value?.embedUrl ?? "";
  return isNative ? base : `${base}?autoplay=1`;
});

const showSpinner = computed(
  () => playing.value && !iframeLoaded.value && !error.value && !spinnerTimedOut.value,
);

const onFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement;
};

// Resolution can outlive a quickly-closed modal.
let unmounted = false;

function pickPeerTubeMode(s: PeerTubeSources): PeerTubeMode {
  if (s.playlistUrl && canUseModernPlayer()) return "hls";
  if (s.fileUrl) return "file";
  return "error";
}

function resolvePeerTube(apiUrl: string, fresh = false): void {
  peerTubeMode.value = "loading";
  void fetchPeerTubeSources(apiUrl, { fresh }).then((s) => {
    if (unmounted) return;
    if (s.thumbUrl) peertubeThumb.value = s.thumbUrl;
    sources.value = s;
    // Feed tiles only need the preview; the modal plays.
    if (!props.inline) peerTubeMode.value = pickPeerTubeMode(s);
  });
}

/** Nothing played — the API was unreachable, had nothing yet, or its URLs
 *  failed. Ask again, past the cache. */
const retryPeerTube = () => {
  const apiUrl = videoInfo.value?.apiUrl;
  if (apiUrl) resolvePeerTube(apiUrl, true);
};

onMounted(() => {
  document.addEventListener("fullscreenchange", onFullscreenChange);

  const info = videoInfo.value;
  if (info?.type === "peertube" && info.apiUrl) {
    resolvePeerTube(info.apiUrl);
    return;
  }

  if (props.autoplay && !props.inline) play();
});

onUnmounted(() => {
  unmounted = true;
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  clearSpinnerTimer();
});

const onHlsFatalError = () => {
  peerTubeMode.value = sources.value?.fileUrl ? "file" : "error";
};

const onFileFatalError = () => {
  peerTubeMode.value = "error";
};

// Android back: exit iframe fullscreen instead of closing the post.
// Priority 100 matches other full-screen overlays (MediaViewer, CallWindow).
useAndroidBackHandler("post-video-fullscreen", 100, () => {
  if (isFullscreen.value && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
    return true;
  }
  return false;
});

const play = () => {
  // Feed tiles never play in place, on any platform: the post modal is where
  // video plays (WEE-74 — an embedded player locked the feed's scroll and
  // gestures on Android).
  if (props.inline) {
    emit("expand");
    return;
  }

  playing.value = true;
  spinnerTimedOut.value = false;
  clearSpinnerTimer();
  spinnerTimer = setTimeout(() => {
    spinnerTimedOut.value = true;
    spinnerTimer = null;
  }, SPINNER_TIMEOUT_MS);
};

const onIframeLoad = () => {
  iframeLoaded.value = true;
  clearSpinnerTimer();
};

const onIframeError = () => {
  error.value = true;
  playing.value = false;
  clearSpinnerTimer();
};

// Route through openExternalUrl: on native a plain <a target="_blank"> is a
// no-op inside Capacitor's WebView, so we launch a Custom Tab instead.
const openExternal = () => {
  void openExternalUrl(externalUrl.value);
};
</script>

<template>
  <!-- PeerTube in the modal: HLS player → plain <video> → open externally -->
  <template v-if="videoInfo && isPeerTube && !inline">
    <PeerTubePlayer
      v-if="peerTubeMode === 'hls' && sources?.playlistUrl"
      :src="sources.playlistUrl"
      :poster="thumbUrl"
      :autoplay="autoplay"
      :persist-key="url"
      :aspect-ratio="sources.aspectRatio"
      @fatal-error="onHlsFatalError"
    />
    <FeedVideoPlayer
      v-else-if="peerTubeMode === 'file' && sources?.fileUrl"
      data-testid="file-player"
      :class="peerTubeFrame.class"
      :aspect-ratio="peerTubeFrame.style.aspectRatio"
      :src="sources.fileUrl"
      :poster="thumbUrl"
      :autoplay="autoplay"
      :start-muted="false"
      :persist-key="url"
      @fatal-error="onFileFatalError"
    />
    <div
      v-else
      class="relative overflow-hidden rounded-lg bg-black"
      :class="peerTubeFrame.class"
      :style="peerTubeFrame.style"
    >
      <img v-if="thumbUrl" :src="thumbUrl" alt="" class="h-full w-full object-contain opacity-60" />
      <div
        v-if="peerTubeMode === 'loading'"
        data-testid="video-loading"
        class="absolute inset-0 flex items-center justify-center"
      >
        <div class="contain-strict h-10 w-10 animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
      </div>
      <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center">
        <span class="text-sm text-white/80">{{ t("postPlayer.videoUnavailable") }}</span>
        <button
          data-testid="video-retry"
          class="rounded-md bg-white/20 px-4 py-1.5 text-sm text-white hover:bg-white/30"
          @click.stop="retryPeerTube"
        >
          {{ t("video.retry") }}
        </button>
        <a
          data-testid="video-external"
          :href="externalUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm text-color-txt-ac underline"
          @click.stop.prevent="openExternal"
        >{{ t("postPlayer.openVideoExternally") }}</a>
      </div>
    </div>
  </template>

  <!-- Feed tile (any provider) and YouTube / Vimeo in the modal -->
  <div
    v-else-if="videoInfo"
    class="relative overflow-hidden rounded-lg bg-black"
    :class="'aspect-video w-full'"
  >
    <iframe
      v-if="playing && !error"
      :src="embedSrc"
      class="absolute inset-0 h-full w-full"
      frameborder="0"
      sandbox="allow-same-origin allow-scripts allow-presentation allow-forms allow-popups"
      allow="autoplay; picture-in-picture; fullscreen"
      allowfullscreen
      @load="onIframeLoad"
      @error="onIframeError"
    />

    <!-- Loading overlay while the iframe is fetching; hidden once @load fires -->
    <div
      v-if="showSpinner"
      data-testid="video-loading"
      class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60"
    >
      <svg class="animate-spin" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" opacity="0.85">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>

    <template v-if="!playing && !error">
      <img
        v-if="thumbUrl"
        :src="thumbUrl"
        alt=""
        class="h-full w-full object-cover"
        loading="lazy"
      />
      <div v-else class="flex h-full w-full items-center justify-center bg-black">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1" opacity="0.3">
          <rect x="2" y="2" width="20" height="20" rx="2" />
          <path d="M10 8l6 4-6 4V8z" fill="white" opacity="0.3" />
        </svg>
      </div>

      <button
        class="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/20"
        :aria-label="t('postPlayer.playVideo')"
        @click.stop="play"
      >
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#000">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
    </template>

    <div v-if="error" class="absolute inset-0 flex items-center justify-center bg-black">
      <a
        data-testid="video-external"
        :href="externalUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-color-txt-ac underline"
        @click.stop.prevent="openExternal"
      >{{ t("postPlayer.openVideoExternally") }}</a>
    </div>
  </div>
</template>
