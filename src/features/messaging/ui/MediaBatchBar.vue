<script setup lang="ts">
/**
 * One compact bar for a multi-item media send (media-batch.ts): the item
 * being worked on with its thumbnail, "Uploading 3 of 12 · 40%", the overall
 * progress and how many are still queued. Tap it for the per-item list
 * (cancel one); X stops the rest after a confirm. When the batch is done it
 * either says "All 12 sent" or turns into the one failure summary.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "@/shared/lib/i18n";
import type { TranslationKey } from "@/shared/lib/i18n";
import { formatLimitMegabytes } from "@/shared/lib/file-transfer/upload-limit";
import {
  cancelBatch,
  cancelBatchItem,
  dismissBatch,
  retryBatchFailures,
  useMediaBatch,
} from "../model/media-batch";
import { isDone, type BatchFailReason, type BatchItem } from "../model/media-batch-model";
import { displayMediaName } from "../model/media-name";

const props = defineProps<{ roomId: string | null | undefined }>();
const emit = defineEmits<{ pickAgain: [] }>();

const { t } = useI18n();
const { items, view } = useMediaBatch(() => props.roomId);
const expanded = ref(false);
const confirming = ref(false);
const brokenThumbs = ref(new Set<string>());

watch(() => view.value.total, (n) => {
  if (n === 0) {
    expanded.value = false;
    confirming.value = false;
  }
});
watch(() => view.value.finished, (done) => { if (done) confirming.value = false; });

const sorted = computed(() => [...items.value].sort((a, b) => a.index - b.index));
const shown = computed<BatchItem | null>(() => view.value.current ?? sorted.value.find((i) => i.state === "queued") ?? null);

const nameOf = (item: BatchItem): string =>
  displayMediaName(item.name) ?? t(`media.batch.${item.kind}` as TranslationKey, { n: String(item.index + 1) });

const thumbOf = (item: BatchItem | null): string | undefined =>
  item?.thumbUrl && !brokenThumbs.value.has(item.thumbUrl) ? item.thumbUrl : undefined;
const onThumbError = (url: string | undefined) => {
  if (url) brokenThumbs.value = new Set(brokenThumbs.value).add(url);
};

const headline = computed(() => {
  const v = view.value;
  const cur = v.current;
  const n = String(cur ? v.position : Math.min(v.sent + 1, v.counted));
  const total = String(v.counted);
  if (cur?.state === "compressing") return t("media.batch.compressing", { n, total, percent: String(cur.percent) });
  if (cur?.state === "uploading") return t("media.batch.uploading", { n, total, percent: String(cur.percent) });
  return t("media.batch.preparing", { n, total });
});

const subline = computed(() => {
  const v = view.value;
  const parts = [t("media.batch.sentOf", { sent: String(v.sent), total: String(v.counted) })];
  if (v.queued > 0) parts.push(t("media.batch.queuedMore", { count: String(v.queued) }));
  return parts.join(" · ");
});

const stateText = (item: BatchItem): string => {
  switch (item.state) {
    case "queued": return t("media.batch.state.queued");
    case "preparing": return t("media.batch.state.preparing");
    case "compressing": return t("media.batch.state.compressing", { percent: String(item.percent) });
    case "uploading": return t("media.batch.state.uploading", { percent: String(item.percent) });
    case "sent": return t("media.batch.state.sent");
    case "cancelled": return t("media.batch.state.cancelled");
    case "failed": return reasonText(item.reason ?? "unknown", 1, item);
  }
  return "";
};

function reasonText(reason: BatchFailReason, count: number, sample?: BatchItem): string {
  const d = sample?.detail;
  const params: Record<string, string> = { count: String(count) };
  if (d?.limitBytes) params.limit = formatLimitMegabytes(d.limitBytes);
  if (d?.maxDurationMs) params.minutes = String(Math.floor(d.maxDurationMs / 60_000));
  // Without the numbers, fall back to the wording that needs none.
  if ((reason === "tooLarge" || reason === "notCompressed") && !params.limit) params.limit = "?";
  if (reason === "tooLong" && !params.minutes) params.minutes = "?";
  return t(`media.batch.reason.${reason}` as TranslationKey, params);
}

const reasonLines = computed(() => {
  const byReason = view.value.failuresByReason;
  return (Object.keys(byReason) as BatchFailReason[]).map((reason) => ({
    reason,
    text: reasonText(reason, byReason[reason] ?? 0, sorted.value.find((i) => i.state === "failed" && i.reason === reason)),
  }));
});

const openCount = computed(() => items.value.filter((i) => !isDone(i)).length);

const onCancelAll = async () => {
  confirming.value = false;
  if (props.roomId != null) await cancelBatch(props.roomId);
};
const onRetry = () => { if (props.roomId != null) void retryBatchFailures(props.roomId); };
const onPickAgain = () => {
  if (props.roomId != null) dismissBatch(props.roomId);
  emit("pickAgain");
};
const onDismiss = () => { if (props.roomId != null) dismissBatch(props.roomId); };
</script>

<template>
  <div
    v-if="view.total > 0"
    class="pointer-events-auto mx-2 mb-2 overflow-hidden rounded-lg border border-neutral-grad-2 bg-neutral-grad-0 text-sm text-text-color"
    data-testid="media-batch-bar"
  >
    <!-- Done, nothing failed -->
    <div v-if="view.finished && view.failed === 0" class="flex items-center gap-2 px-3 py-2" role="status" data-state="done">
      <svg class="shrink-0 text-color-bg-ac" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="min-w-0 flex-1">{{ t("media.batch.allSent", { total: String(view.sent) }) }}</div>
    </div>

    <!-- Done with failures: the one summary -->
    <div v-else-if="view.finished" class="px-3 py-2" role="alert" data-state="summary">
      <div class="flex items-start gap-2">
        <svg class="mt-0.5 shrink-0 text-color-bad" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div class="min-w-0 flex-1 leading-snug">
          <div class="font-medium">{{ t("media.batch.summary", { failed: String(view.failed), total: String(view.counted) }) }}</div>
          <div v-for="line in reasonLines" :key="line.reason" class="text-xs opacity-80" :data-reason="line.reason">{{ line.text }}</div>
          <div v-if="view.cancelled" class="text-xs opacity-60">{{ t("media.batch.cancelledCount", { count: String(view.cancelled) }) }}</div>
        </div>
        <button type="button" class="rounded-md px-2 py-1 text-xs opacity-70 hover:opacity-100" :aria-label="t('media.batch.dismiss')" @click="onDismiss">✕</button>
      </div>
      <div class="mt-2 flex flex-wrap justify-end gap-2">
        <button
          v-if="view.canPickAgain"
          type="button"
          class="rounded-md bg-neutral-grad-2/60 px-3 py-1 text-xs font-medium"
          data-action="pick-again"
          @click="onPickAgain"
        >
          {{ t("media.batch.pickAgain") }}
        </button>
        <button
          v-if="view.retryableIds.length"
          type="button"
          class="rounded-md bg-color-bg-ac px-3 py-1 text-xs font-medium text-text-on-bg-ac-color"
          data-action="retry"
          @click="onRetry"
        >
          {{ t("media.batch.retry") }}
        </button>
      </div>
    </div>

    <!-- Running -->
    <template v-else>
      <div v-if="confirming" class="flex flex-col gap-2 px-3 py-2" role="alertdialog" data-state="confirm">
        <div class="leading-snug">{{ t("media.batch.cancelAllConfirm", { count: String(openCount) }) }}</div>
        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-md bg-neutral-grad-2/60 px-3 py-1 text-xs font-medium" @click="confirming = false">
            {{ t("media.batch.keepSending") }}
          </button>
          <button type="button" class="rounded-md bg-color-bad px-3 py-1 text-xs font-medium text-white" data-action="cancel-all" @click="onCancelAll">
            {{ t("media.batch.cancelAllYes") }}
          </button>
        </div>
      </div>
      <div v-else class="flex items-center gap-2 px-2 py-1.5" role="status" data-state="running">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          :aria-expanded="expanded"
          :aria-label="expanded ? t('media.batch.collapse') : t('media.batch.expand')"
          data-action="toggle"
          @click="expanded = !expanded"
        >
          <div class="relative h-9 w-9 shrink-0 overflow-hidden rounded-md bg-neutral-grad-2/50">
            <img
              v-if="thumbOf(shown)"
              :src="thumbOf(shown)"
              alt=""
              class="h-full w-full object-cover"
              @error="onThumbError(shown?.thumbUrl)"
            />
            <svg v-else class="absolute inset-0 m-auto opacity-60" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="5" width="15" height="14" rx="2" /><polygon points="17 9 22 6 22 18 17 15" />
            </svg>
          </div>
          <div class="min-w-0 flex-1 leading-snug">
            <div class="truncate" data-testid="media-batch-headline">{{ headline }}</div>
            <div class="mt-1 h-1 overflow-hidden rounded bg-neutral-grad-2/40">
              <div class="h-full bg-color-bg-ac transition-[width] duration-300" :style="{ width: `${view.overallPercent}%` }" />
            </div>
            <div class="mt-0.5 truncate text-xs opacity-60" data-testid="media-batch-subline">{{ subline }}</div>
          </div>
          <svg class="shrink-0 opacity-50 transition-transform" :class="expanded ? 'rotate-180' : ''" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-xs font-medium opacity-70 hover:opacity-100"
          :aria-label="t('media.batch.cancelAll')"
          data-action="ask-cancel-all"
          @click="confirming = true"
        >
          ✕
        </button>
      </div>
    </template>

    <!-- Per-item list -->
    <ul v-if="expanded && !confirming" class="max-h-56 overflow-y-auto border-t border-neutral-grad-2" data-testid="media-batch-list">
      <li v-for="item in sorted" :key="item.id" class="flex items-center gap-2 px-2 py-1.5" :data-state="item.state">
        <div class="relative h-7 w-7 shrink-0 overflow-hidden rounded bg-neutral-grad-2/50">
          <img v-if="thumbOf(item)" :src="thumbOf(item)" alt="" class="h-full w-full object-cover" @error="onThumbError(item.thumbUrl)" />
        </div>
        <div class="min-w-0 flex-1 leading-tight">
          <div class="truncate text-xs">{{ nameOf(item) }}</div>
          <div class="truncate text-[11px]" :class="item.state === 'failed' ? 'text-color-bad' : 'opacity-60'">{{ stateText(item) }}</div>
        </div>
        <button
          v-if="!isDone(item)"
          type="button"
          class="rounded-md px-2 py-1 text-xs opacity-60 hover:opacity-100"
          :aria-label="t('media.batch.cancelItem')"
          data-action="cancel-item"
          @click="cancelBatchItem(item.id)"
        >
          ✕
        </button>
      </li>
    </ul>
  </div>
</template>
