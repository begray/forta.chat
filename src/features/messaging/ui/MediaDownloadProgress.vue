<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@/shared/lib/i18n";
import type { FileDownloadPhase } from "../model/use-file-download";

/** Download state of an inbound media bubble: a determinate ring with a
 *  cancel cross while bytes arrive, a spinner when the size is unknown or the
 *  file is being decrypted. The caption says which of the two is happening. */
const props = defineProps<{
  phase: FileDownloadPhase | null;
  /** 0–100, null when the total size is unknown. */
  progress: number | null;
  caption: string;
  /** False when nothing here can abort the download — no cancel cross. */
  cancellable: boolean;
}>();

const emit = defineEmits<{ cancel: [] }>();
const { t } = useI18n();

const RING_LENGTH = 94.25;
const isDeterminate = computed(() => props.phase === "download" && props.progress !== null);
const canCancel = computed(() => props.cancellable && props.phase !== "decrypt");
const showRing = computed(() => props.phase !== "decrypt");
const dashOffset = computed(() => RING_LENGTH - (RING_LENGTH * (props.progress ?? 0)) / 100);
</script>

<template>
  <div class="flex flex-col items-center gap-2" data-testid="media-download-progress">
    <component
      :is="canCancel ? 'button' : 'div'"
      v-if="showRing"
      :type="canCancel ? 'button' : undefined"
      class="relative flex h-14 w-14 items-center justify-center rounded-full bg-black/45 text-white"
      :aria-label="canCancel ? t('message.cancelDownload') : undefined"
      @click.stop="canCancel && emit('cancel')"
    >
      <svg
        class="h-full w-full"
        :class="{ 'animate-spin': !isDeterminate }"
        viewBox="0 0 36 36"
      >
        <circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="2.5" />
        <circle
          cx="18" cy="18" r="15" fill="none" stroke="white" stroke-width="2.5"
          :stroke-dasharray="RING_LENGTH"
          :stroke-dashoffset="isDeterminate ? dashOffset : RING_LENGTH * 0.75"
          stroke-linecap="round" transform="rotate(-90 18 18)"
          class="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      <svg v-if="canCancel" class="absolute h-3.5 w-3.5" viewBox="0 0 14 14" fill="none">
        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </component>
    <div
      v-else
      class="contain-strict h-8 w-8 animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent"
    />
    <span
      v-if="caption"
      class="rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white"
    >
      {{ caption }}
    </span>
  </div>
</template>
