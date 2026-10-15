import { ref, computed } from "vue";
import type { Ref } from "vue";
import { logUpload, fileLabel } from "@/shared/lib/upload-log/upload-log";
import { rejectOversizedPick } from "./upload-size";

export interface MediaFile {
  file: File;
  previewUrl: string;
  type: "image" | "video";
}

export function useMediaUpload() {
  const files: Ref<MediaFile[]> = ref([]);
  const activeIndex = ref(0);
  const caption = ref("");
  const captionAbove = ref(false);
  const sending = ref(false);

  const activeFile = computed(() => files.value[activeIndex.value] ?? null);

  const addFiles = (fileList: FileList | File[]) => {
    for (const file of Array.from(fileList)) {
      const type = file.type.startsWith("video/") ? "video" as const : "image" as const;
      logUpload("pick", null, { as: type, mime: file.type || "(none)", size: file.size, name: fileLabel(file.name) });
      // A video over the server limit never gets into the composer.
      if (rejectOversizedPick(file)) continue;
      files.value.push({
        file,
        previewUrl: URL.createObjectURL(file),
        type,
      });
    }
    activeIndex.value = 0;
  };

  const removeFile = (index: number) => {
    const removed = files.value.splice(index, 1);
    removed.forEach(f => URL.revokeObjectURL(f.previewUrl));
    if (activeIndex.value >= files.value.length) {
      activeIndex.value = Math.max(0, files.value.length - 1);
    }
  };

  const clear = () => {
    files.value.forEach(f => URL.revokeObjectURL(f.previewUrl));
    files.value = [];
    activeIndex.value = 0;
    caption.value = "";
    captionAbove.value = false;
    sending.value = false;
  };

  return { files, activeIndex, activeFile, caption, captionAbove, sending, addFiles, removeFile, clear };
}
