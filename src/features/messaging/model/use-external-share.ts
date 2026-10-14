import { ref } from "vue";
import { isNative } from "@/shared/lib/platform";
import { tRaw } from "@/shared/lib/i18n";
import { useToast } from "@/shared/lib/use-toast";
import { isCancelError } from "@/shared/lib/composables/use-native-share";
import { writeShareFiles, type ShareFileInput } from "@/shared/lib/share-files";
import { isSharePlanEmpty, type ExternalSharePlan, type ShareFileSource } from "./external-share-plan";

/** "Share to other apps" uses the system share sheet — Android and iOS only.
 *  Desktop (web, Electron) has no share sheet worth offering. */
export const canShareExternally = isNative;

export type ExternalShareResult = "shared" | "cancelled" | "failed";

async function loadFile(src: ShareFileSource): Promise<ShareFileInput> {
  let blob: Blob | null = null;
  if (src.objectUrl) {
    try {
      const res = await fetch(src.objectUrl);
      if (res.ok) blob = await res.blob();
    } catch {
      // revoked object URL — fall back to the cache / download below
    }
  }
  if (!blob) {
    // Lazy: the download pipeline pulls in the Matrix stack.
    const { getDecryptedBlobForMessage } = await import("./use-file-download");
    blob = await getDecryptedBlobForMessage(src);
  }
  if (!blob) throw new Error("share_media_unavailable");
  return {
    blob,
    name: src.fileInfo.name,
    mimeType: src.fileInfo.type || blob.type || "application/octet-stream",
  };
}

/** Open the system share sheet for a share plan: text, a link, decrypted media. */
export function useExternalShare() {
  const { toast } = useToast();
  const isSharing = ref(false);

  async function share(plan: ExternalSharePlan): Promise<ExternalShareResult> {
    if (!canShareExternally || isSharing.value || isSharePlanEmpty(plan)) return "failed";
    isSharing.value = true;
    try {
      // Sequential: several decrypted videos at once would not fit in memory.
      const inputs: ShareFileInput[] = [];
      for (const src of plan.files) inputs.push(await loadFile(src));
      const files = inputs.length > 0 ? await writeShareFiles(inputs) : undefined;

      const { Share } = await import("@capacitor/share");
      await Share.share({
        text: plan.text,
        url: plan.url,
        files,
        dialogTitle: tRaw("share.dialogTitle"),
      });
      return "shared";
    } catch (e) {
      if (isCancelError(e)) return "cancelled";
      console.error("[useExternalShare] share failed:", e);
      toast(tRaw("share.failed"), "error");
      return "failed";
    } finally {
      isSharing.value = false;
    }
  }

  return { share, isSharing };
}
