import { ref, computed, markRaw } from "vue";
import type { Ref } from "vue";
import { logUpload, fileLabel } from "@/shared/lib/upload-log/upload-log";
import { rejectOversizedPick } from "./upload-size";
import { canCompressVideos } from "./video-compression";
import { fileSourceOf, markPicked, releaseFileSource } from "./picked-media";

export interface MediaFile {
  file: File;
  previewUrl: string;
  /** Video thumbnail from the native picker. */
  posterUrl?: string;
  type: "image" | "video";
}

function revokePreview(f: MediaFile): void {
  if (f.previewUrl.startsWith("blob:")) URL.revokeObjectURL(f.previewUrl);
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
      const source = fileSourceOf(file);
      markPicked(file);
      logUpload("pick", null, {
        as: type, mime: file.type || "(none)", size: file.size, name: fileLabel(file.name), src: source?.kind ?? "webview",
      });
      // A video over the server limit never gets into the composer, unless
      // it can be compressed to fit when it is sent.
      if (!(type === "video" && canCompressVideos()) && rejectOversizedPick(file)) {
        void releaseFileSource(file);
        continue;
      }
      files.value.push({
        // Kept raw: the same File object must reach the send (its source
        // and pick time are looked up by identity).
        file: markRaw(file),
        // A native pick has no bytes in the File: preview its copy/URI.
        previewUrl: source?.previewUrl ?? URL.createObjectURL(file),
        posterUrl: source?.posterUrl,
        type,
      });
    }
    activeIndex.value = 0;
  };

  const removeFile = (index: number) => {
    const removed = files.value.splice(index, 1);
    removed.forEach((f) => {
      revokePreview(f);
      void releaseFileSource(f.file);
    });
    if (activeIndex.value >= files.value.length) {
      activeIndex.value = Math.max(0, files.value.length - 1);
    }
  };

  /** Close the composer. The files' native copies are given back, unless
   *  they are being sent (`keepSources`): each send releases its own. */
  const clear = (opts: { keepSources?: boolean } = {}) => {
    files.value.forEach((f) => {
      revokePreview(f);
      if (!opts.keepSources) void releaseFileSource(f.file);
    });
    files.value = [];
    activeIndex.value = 0;
    caption.value = "";
    captionAbove.value = false;
    sending.value = false;
  };

  return { files, activeIndex, activeFile, caption, captionAbove, sending, addFiles, removeFile, clear };
}
