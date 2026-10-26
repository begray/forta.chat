<script setup lang="ts">
import { useTorStore } from "@/entities/tor";
import { useToast } from "@/shared/lib/use-toast";
import {
  getUploadLog,
  onUploadLogChange,
  copyUploadLog,
  shareUploadLog,
} from "@/shared/lib/upload-log";
import { formatAppBuild, readAppBuild } from "@/shared/lib/upload-log/app-build";

const props = defineProps<{ appVersion?: string }>();

const { t } = useI18n();
const { toast } = useToast();
const torStore = useTorStore();

const eventCount = ref(getUploadLog().length);
const unsubscribe = onUploadLogChange(() => { eventCount.value = getUploadLog().length; });
onBeforeUnmount(unsubscribe);

const busy = ref(false);
// The full build id (versionCode, commit): test builds share a version
// name. Read up front, so Copy runs straight from the tap.
const appBuild = ref<string | undefined>();
void readAppBuild(props.appVersion || undefined).then((b) => { appBuild.value = formatAppBuild(b); });
const header = () => ({ app: appBuild.value ?? (props.appVersion || undefined), tor: torStore.mode });

const handleCopy = async () => {
  try {
    await copyUploadLog(header());
    toast(t("about.uploadLogCopied"), "success");
  } catch (e) {
    console.error("[UploadLogSection] copy failed:", e);
    toast(t("about.uploadLogFailed"), "error");
  }
};

const handleShare = async () => {
  if (busy.value) return;
  busy.value = true;
  try {
    await shareUploadLog(header());
  } catch (e) {
    console.error("[UploadLogSection] share failed:", e);
    toast(t("about.uploadLogFailed"), "error");
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <div>
    <h3 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-on-main-bg-color">
      {{ t("about.diagnostics") }}
    </h3>
    <div class="rounded-xl bg-background-secondary-theme px-4 py-3">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-text-color">{{ t("about.uploadLog") }}</span>
        <span class="text-xs text-text-on-main-bg-color">{{ t("about.uploadLogEvents", { n: eventCount }) }}</span>
      </div>
      <p class="mt-1 text-xs text-text-on-main-bg-color">{{ t("about.uploadLogDesc") }}</p>
      <div class="mt-3 flex gap-2">
        <button
          class="flex-1 rounded-lg bg-neutral-grad-0 px-4 py-2 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-2 disabled:opacity-50"
          :disabled="eventCount === 0"
          @click="handleCopy"
        >{{ t("about.uploadLogCopy") }}</button>
        <button
          class="flex-1 rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac/90 disabled:opacity-50"
          :disabled="eventCount === 0 || busy"
          @click="handleShare"
        >{{ t("about.uploadLogShare") }}</button>
      </div>
    </div>
  </div>
</template>
