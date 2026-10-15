import { logUpload, logUploadError, fileLabel, describeError } from "@/shared/lib/upload-log/upload-log";
import { SendError } from "./send-errors";
import { reportSendError } from "./send-error-bus";

/**
 * Send several picked files at once. Each send only reads the file, writes
 * the local echo and queues it (SyncEngine serialises the uploads), so they
 * run in parallel and one failure does not hold up the rest.
 *
 * A send that returns false has already reported why. One that throws used
 * to vanish inside Promise.allSettled with no message at all; now it is
 * logged and shown in the send error banner.
 */
export async function sendBatch<T>(
  items: readonly T[],
  send: (item: T, index: number) => Promise<boolean>,
  fileNameOf: (item: T) => string,
): Promise<void> {
  logUpload("send:batch", null, { n: items.length });
  const results = await Promise.allSettled(items.map((item, i) => send(item, i)));
  results.forEach((result, i) => {
    if (result.status === "fulfilled") return;
    const fileName = fileNameOf(items[i]);
    logUploadError("send:rejected", null, result.reason, { name: fileLabel(fileName) });
    console.error("[send] media send failed:", result.reason);
    reportSendError(
      result.reason instanceof SendError
        ? result.reason
        : new SendError("unknown", describeError(result.reason), { fileName, cause: result.reason }),
    );
  });
}
