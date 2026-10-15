import { isNative } from "@/shared/lib/platform";
import { copyToClipboard } from "@/shared/lib/share-link";
import { formatUploadLog } from "./upload-log";

const EXPORT_FILE_NAME = "forta-upload-log.txt";

/** Extra header lines for the export, e.g. app version and Tor mode. */
export type UploadLogHeader = Record<string, string | undefined>;

function buildExportText(header: UploadLogHeader): string {
  return formatUploadLog(undefined, {
    ...header,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  });
}

/** Copy the upload log as plain text. */
export async function copyUploadLog(header: UploadLogHeader = {}): Promise<void> {
  await copyToClipboard(buildExportText(header));
}

/**
 * Open the share sheet with the upload log. Native: as a .txt file in the
 * app cache (a chat app accepts a file of any length, while text extras get
 * truncated). Web: the Web Share API, or a download when it is missing.
 * Resolves false when the user dismissed the sheet.
 */
export async function shareUploadLog(header: UploadLogHeader = {}): Promise<boolean> {
  const text = buildExportText(header);
  if (isNative) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    const written = await Filesystem.writeFile({
      path: EXPORT_FILE_NAME,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({ title: "Forta upload log", files: [written.uri] });
    } catch (e) {
      if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return false;
      throw e;
    }
    return true;
  }

  const file = typeof File !== "undefined" ? new File([text], EXPORT_FILE_NAME, { type: "text/plain" }) : null;
  if (file && typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: "Forta upload log", files: [file] });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return false;
      throw e;
    }
    return true;
  }

  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = EXPORT_FILE_NAME;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
