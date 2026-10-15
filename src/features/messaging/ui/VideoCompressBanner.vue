<script setup lang="ts">
import { useI18n } from "@/shared/lib/i18n";
import { useVideoCompressions, type CompressionJob } from "../model/video-compression";

const { t } = useI18n();
const { jobs, cancel } = useVideoCompressions();

/** "Compressing video… 40%", or a waiting/preparing line before that. */
const label = (job: CompressionJob): string => {
  if (job.stage === "queued") return t("media.compress.queued");
  if (job.stage === "copying") return t("media.compress.preparing");
  return t("media.compress.progress", { percent: String(job.percent) });
};
</script>

<template>
  <div v-if="jobs.length" class="pointer-events-auto mx-2 mb-2 flex flex-col gap-1" data-testid="video-compress-banner">
    <div
      v-for="job in jobs"
      :key="job.id"
      class="flex items-center gap-2 rounded-lg border border-neutral-grad-2 bg-neutral-grad-0 px-3 py-2 text-sm text-text-color"
      role="status"
      :data-stage="job.stage"
    >
      <svg class="shrink-0 animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
      </svg>
      <div class="min-w-0 flex-1 leading-snug">
        <div>{{ label(job) }}</div>
        <div class="truncate text-xs opacity-60">{{ job.name }}</div>
        <div v-if="job.stage === 'compressing'" class="mt-1 h-1 overflow-hidden rounded bg-neutral-grad-2/40">
          <div class="h-full bg-color-bg-ac transition-[width] duration-300" :style="{ width: `${job.percent}%` }" />
        </div>
      </div>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs font-medium opacity-70 hover:opacity-100"
        :aria-label="t('media.compress.cancel')"
        @click="cancel(job.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
