/**
 * Send a batch of picked files without losing any of them.
 *
 * standbyfix6 field log (16:33, 19 items): the photos were read at once,
 * but every video waited for the serial compressor before its File was
 * first read. ~20 s after the pick every unread WebView File handle went
 * NotReadableError, and 14 of 19 items were dropped, 6 of them silently.
 *
 * So a batch now runs in two phases:
 *  1. snapshot: every item is made independent of the picker before any
 *     compression starts. Native picks already are (our copy or a pinned
 *     URI); a big video from <input type=file> is copied into the cache
 *     (stageVideoForSend); everything else is read into memory.
 *  2. send: all snapshots are dispatched at once (sendBatch). Videos to
 *     compress queue one at a time inside prepareVideoForSend; the rest go
 *     straight to the upload queue.
 * Whatever could not be read or sent ends in one banner ("3 of 19 couldn't
 * be read — pick them again") and an upload-log line.
 */
import { describeError, fileLabel, logUpload } from "@/shared/lib/upload-log/upload-log";
import { sendBatch } from "./send-batch";
import { SendError, type SendErrorContext } from "./send-errors";
import { reportSendError, useSendErrorBus } from "./send-error-bus";
import { fileSourceOf, pickedAgoS, releaseFileSource, setPrepState } from "./picked-media";
import { readPickedFile } from "./read-picked-file";
import { stageVideoForSend, wasCancelledByUser } from "./video-compression";

export interface MediaBatchDeps {
  /** Make the file independent of the picker; resolves the file to send. */
  snapshot: (file: File) => Promise<File>;
}

async function snapshotFile(file: File): Promise<File> {
  if (fileSourceOf(file)) return file;
  if (await stageVideoForSend(file)) return file;
  return readPickedFile(file);
}

let deps: MediaBatchDeps = { snapshot: snapshotFile };

/** Test hook (null restores the real snapshot). */
export function setMediaBatchDepsForTests(next: MediaBatchDeps | null): void {
  deps = next ?? { snapshot: snapshotFile };
}

export interface BatchOutcome {
  total: number;
  sent: number;
  unreadable: number;
  failed: number;
  cancelled: number;
}

/**
 * `send` gets each item with its index in `items` and whether it is the
 * last one actually sent (unreadable ones are skipped), so a caption meant
 * for the end of the gallery is not lost with an unreadable last item.
 */
export async function sendPickedBatch<T>(
  items: readonly T[],
  fileOf: (item: T) => File,
  withFile: (item: T, file: File) => T,
  send: (item: T, index: number, isLast: boolean) => Promise<boolean>,
): Promise<BatchOutcome> {
  const total = items.length;
  const bus = useSendErrorBus();
  const errorIdBefore = bus.error.value?.id ?? 0;

  // Phase 1: snapshot everything before anything slow runs.
  const ready: { item: T; original: File; index: number }[] = [];
  const unreadable: File[] = [];
  if (total > 1) setPrepState({ done: 0, total });
  try {
    for (let i = 0; i < total; i++) {
      const original = fileOf(items[i]);
      try {
        const snap = await deps.snapshot(original);
        ready.push({ item: snap === original ? items[i] : withFile(items[i], snap), original, index: i });
        if (snap !== original) void releaseFileSource(original);
      } catch (e) {
        unreadable.push(original);
        logUpload("read:fail", null, {
          stage: "snapshot",
          size: original.size,
          mime: original.type || "(none)",
          name: fileLabel(original.name),
          src: fileSourceOf(original)?.kind ?? "webview",
          agoS: pickedAgoS(original),
          err: describeError(e),
        });
        void releaseFileSource(original);
      }
      if (total > 1) setPrepState({ done: i + 1, total });
    }
  } finally {
    setPrepState(null);
  }

  // Phase 2: dispatch; compression queues itself one video at a time.
  const results = ready.length
    ? await sendBatch(ready.map((r) => r.item), (item, i) => send(item, ready[i].index, i === ready.length - 1), (item) => fileOf(item).name)
    : [];
  let sent = 0;
  let cancelled = 0;
  let failed = unreadable.length;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) sent++;
    else if (wasCancelledByUser(fileOf(ready[i].item)) || wasCancelledByUser(ready[i].original)) cancelled++;
    else failed++;
  });
  const outcome: BatchOutcome = { total, sent, unreadable: unreadable.length, failed, cancelled };
  logUpload("send:batch-done", null, { ...outcome });

  if (failed > 0 && total > 1) {
    const last = bus.error.value;
    const detail = last && last.id > errorIdBefore && last.kind !== "batchIncomplete" && last.kind !== "fileUnreadable"
      ? { kind: last.kind, context: { ...last.context, cause: undefined } }
      : undefined;
    const context: SendErrorContext = {
      totalCount: total,
      failedCount: failed,
      unreadableCount: unreadable.length,
      detail,
    };
    reportSendError(new SendError(
      "batchIncomplete",
      `${failed} of ${total} not sent (${unreadable.length} unreadable)`,
      context,
      false,
    ));
  } else if (unreadable.length > 0) {
    // A single item: the plain "could not read" banner says it all.
    reportSendError(new SendError(
      "fileUnreadable",
      `Cannot read ${unreadable[0].name}`,
      { fileName: unreadable[0].name },
      false,
    ));
  }
  return outcome;
}
