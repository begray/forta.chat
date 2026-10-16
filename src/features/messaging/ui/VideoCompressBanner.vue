<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@/shared/lib/i18n";
import { useVideoCompressions, type CompressionJob } from "../model/video-compression";
import { usePickedMediaState } from "../model/picked-media";
import { useBatchItems } from "../model/media-batch";

const { t } = useI18n();
const { jobs: allJobs, finished, cancel } = useVideoCompressions();
const { prep } = usePickedMediaState();
const batchItems = useBatchItems();

/** Videos sent on their own; a batch's show in MediaBatchBar. */
const jobs = computed(() => allJobs.value.filter((j) => !batchItems.value.some((i) => i.id === j.id)));
/** The job being worked on; the rest wait in one line, not one row each. */
const active = computed(() => jobs.value.filter((j) => j.stage !== "queued"));
const waiting = computed(() => jobs.value.length - active.value.length);
const total = computed(() => finished.value + jobs.value.length);
const cancelOwnQueued = () => {
  for (const j of jobs.value) if (j.stage === "queued") void cancel(j.id);
};

/** "Compressing video 3 of 12… 40%", or a preparing line before that. */
const label = (job: CompressionJob, i: number): string => {
  if (job.stage === "copying") return t("media.compress.preparing");
  if (total.value > 1) {
    return t("media.compress.progressOf", { n: String(finished.value + i + 1), total: String(total.value), percent: String(job.percent) });
  }
  return t("media.compress.progress", { percent: String(job.percent) });
};
</script>

<template>
  <div v-if="jobs.length || prep" class="pointer-events-auto mx-2 mb-2 flex flex-col gap-1" data-testid="video-compress-banner">
    <div
      v-if="prep"
      class="flex items-center gap-2 rounded-lg border border-neutral-grad-2 bg-neutral-grad-0 px-3 py-2 text-sm text-text-color"
      role="status"
      data-stage="prepare"
    >
      <svg class="shrink-0 animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
      </svg>
      <div class="min-w-0 flex-1 leading-snug">{{ t("media.prepare.progress", { done: String(prep.done), total: String(prep.total) }) }}</div>
    </div>
    <div
      v-for="(job, i) in active"
      :key="job.id"
      class="flex items-center gap-2 rounded-lg border border-neutral-grad-2 bg-neutral-grad-0 px-3 py-2 text-sm text-text-color"
      role="status"
      :data-stage="job.stage"
    >
      <svg class="shrink-0 animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
      </svg>
      <div class="min-w-0 flex-1 leading-snug">
        <div>{{ label(job, i) }}</div>
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
    <div
      v-if="waiting > 0"
      class="flex items-center gap-2 rounded-lg border border-neutral-grad-2 bg-neutral-grad-0 px-3 py-1.5 text-xs text-text-color"
      role="status"
      data-stage="queued"
    >
      <div class="min-w-0 flex-1 opacity-70">{{ active.length ? t("media.compress.waitingMore", { count: String(waiting) }) : t("media.compress.queued") }}</div>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs font-medium opacity-70 hover:opacity-100"
        :aria-label="t('media.compress.cancelQueued')"
        @click="cancelOwnQueued()"
      >
        ✕
      </button>
    </div>
  </div>
</template>
