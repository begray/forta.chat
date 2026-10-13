<script setup lang="ts">
/**
 * The Video.js 10 player shell: language provider, player store and our skin
 * (`<forta-video-skin>`). The media goes in the default slot — `<hls-video>`
 * for PeerTube, or a plain `<video>` (message attachments). The caller must
 * have awaited `prepareVideoJs()` before rendering it enabled.
 *
 * `enabled: false` renders the slot alone — for engines Video.js can't run
 * on, where the media keeps its native controls. Decide before the media
 * mounts: flipping it later re-creates the slotted element.
 */
import { useId } from "vue";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

withDefaults(defineProps<{ enabled?: boolean }>(), { enabled: true });

const { locale } = useI18n();
const playerRef = ref<HTMLElement | null>(null);

// Android back leaves the skin's fullscreen instead of closing the screen
// behind it. Priority 100 matches the other full-screen overlays.
useAndroidBackHandler(`video-js-fullscreen-${useId()}`, 100, () => {
  const fullscreen = typeof document !== "undefined" ? document.fullscreenElement : null;
  if (!fullscreen || !playerRef.value?.contains(fullscreen)) return false;
  document.exitFullscreen?.().catch(() => {});
  return true;
});

defineExpose({ playerRef });
</script>

<template>
  <media-i18n v-if="enabled" :lang="locale">
    <video-player ref="playerRef">
      <forta-video-skin class="block h-full w-full">
        <slot />
      </forta-video-skin>
    </video-player>
  </media-i18n>
  <slot v-else />
</template>
