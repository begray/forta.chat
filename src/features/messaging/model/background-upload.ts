/**
 * Feeds the background-transfer keep-alive (shared/lib/background-transfer)
 * from the media send pipeline, so uploads and video compression keep going
 * with the screen off. Sources:
 *  - "engine": the SyncEngine's unfinished send_file ops, with upload progress;
 *  - "batch": batch items not sent yet (queued ones included, they have no op);
 *  - "compress": video compression jobs (single sends too);
 *  - "send": a sendFile/sendImage call in progress (holdTransfer in
 *    use-messages), covering the gap between compression and the echo.
 * The notification's Cancel cancels them all; its heartbeat nudges the batch
 * ticker and the queue, whose timers are throttled in a hidden page.
 */
import { watch } from "vue";
import { setTransferHandlers, setTransferSource, type TransferItem } from "@/shared/lib/background-transfer";
import type { MediaWorkItem, SyncEngine } from "@/shared/lib/local-db/sync-engine";
import type { BatchItem } from "./media-batch-model";
import { isDone } from "./media-batch-model";
import { cancelAllMedia, nudgeMediaBatch, useBatchItems } from "./media-batch";
import { useVideoCompressions, type CompressionJob } from "./video-compression";

export function engineItems(work: readonly MediaWorkItem[]): TransferItem[] {
  return work.map((w) => ({ id: w.clientId, phase: w.phase, percent: w.percent }));
}

export function batchItems(list: readonly BatchItem[]): TransferItem[] {
  return list
    .filter((i) => !isDone(i))
    .map((i) => ({
      id: i.id,
      phase: i.state === "compressing" ? "compressing" : i.state === "uploading" ? "uploading" : "waiting",
      percent: i.state === "compressing" || i.state === "uploading" ? i.percent : undefined,
      compressed: !!i.compressed,
    }));
}

export function compressionItems(jobs: readonly CompressionJob[]): TransferItem[] {
  return jobs.map((j) => ({
    id: j.id,
    phase: j.stage === "compressing" ? "compressing" : "waiting",
    percent: j.stage === "compressing" ? j.percent : undefined,
    compressed: true,
  }));
}

/** Wire the sources to `engine`; returns the teardown (logout / re-init). */
export function initBackgroundUploads(engine: Pick<SyncEngine, "setMediaWorkListener" | "processQueue" | "cancelMediaUpload">): () => void {
  engine.setMediaWorkListener((work) => setTransferSource("engine", engineItems(work)));
  const batch = useBatchItems();
  const stopBatch = watch(batch, (list) => setTransferSource("batch", batchItems(list)), { immediate: true });
  const { jobs } = useVideoCompressions();
  const stopJobs = watch(jobs, (list) => setTransferSource("compress", compressionItems(list)), { immediate: true });
  setTransferHandlers({
    cancelAll: (ids) => cancelAllMedia(ids, (id) => engine.cancelMediaUpload(id)),
    heartbeat: () => {
      nudgeMediaBatch();
      void engine.processQueue();
    },
  });
  return () => {
    engine.setMediaWorkListener(null);
    stopBatch();
    stopJobs();
    setTransferHandlers({});
    setTransferSource("engine", []);
  };
}
