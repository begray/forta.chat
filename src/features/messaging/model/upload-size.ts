import { getMatrixClientService } from "@/entities/matrix";
import {
  exceedsUploadLimit,
  getUploadLimitBytes,
  refreshUploadLimit,
} from "@/shared/lib/file-transfer/upload-limit";
import { logUpload } from "@/shared/lib/upload-log/upload-log";
import { SendError, type SendErrorContext } from "./send-errors";
import { reportSendError } from "./send-error-bus";

/** The server's upload limit, fetched at most once a day (see upload-limit). */
export function fetchUploadLimit(): Promise<number> {
  return refreshUploadLimit(async () => getMatrixClientService().getMediaUploadLimit?.());
}

function kindOf(mime: string, fallback: SendErrorContext["kind"]): SendErrorContext["kind"] {
  return mime.startsWith("video/") ? "video" : fallback;
}

/** "Video is 92.8 MB; the limit is 52 MB", as a non-retryable send error. */
export function tooLargeError(
  file: { name?: string; size: number; type?: string },
  limitBytes: number,
  kind: SendErrorContext["kind"],
): SendError {
  return new SendError(
    "fileTooLarge",
    `File too large: ${file.size} bytes, limit ${limitBytes}`,
    { fileName: file.name, kind: kindOf(file.type ?? "", kind), sizeBytes: file.size, limitBytes },
    false,
  );
}

/** Refuse a file the server would drop after the whole upload: report it in
 *  the send banner and log it. Resolves true when the file may be sent. */
export async function checkUploadSize(
  file: { name?: string; size: number; type?: string },
  clientId: string,
  kind: SendErrorContext["kind"],
): Promise<boolean> {
  const limit = await fetchUploadLimit();
  if (!exceedsUploadLimit(file.size, limit)) return true;
  logUpload("send:dropped", clientId, { reason: "too large", size: file.size, limit });
  reportSendError(tooLargeError(file, limit, kind));
  return false;
}

/** Pick-time check with the limit known right now (no network wait). Images
 *  are not checked here: they shrink when they are optimized before sending. */
export function rejectOversizedPick(file: File): boolean {
  if (!file.type.startsWith("video/")) return false;
  void fetchUploadLimit();
  const limit = getUploadLimitBytes();
  if (!exceedsUploadLimit(file.size, limit)) return false;
  logUpload("pick:rejected", null, { reason: "too large", size: file.size, limit });
  reportSendError(tooLargeError(file, limit, "video"));
  return true;
}
