// @vitest-environment happy-dom
/**
 * The keep-alive service follows the upload queue itself, not only the
 * composer's batch: a media send that came in another way (shared from
 * another app, a media forward, a Retry after a restart) has no batch item
 * and no composer hold, and must still start the service and stop it when
 * the queue is done. Real coordinator, fake native side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import type { MediaWorkItem } from "@/shared/lib/local-db/sync-engine";
import {
  setBackgroundTransferDepsForTests,
  START_DELAY_MS,
  STOP_GRACE_MS,
  type BackgroundTransferDeps,
} from "@/shared/lib/background-transfer/background-transfer";
import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";

vi.mock("../media-batch", () => ({
  useBatchItems: () => ref([]),
  cancelAllMedia: vi.fn(async () => {}),
  nudgeMediaBatch: vi.fn(),
}));
vi.mock("../video-compression", () => ({ useVideoCompressions: () => ({ jobs: ref([]) }) }));

import { initBackgroundUploads } from "../background-upload";

describe("keep-alive for any unfinished media send", () => {
  let listener: ((w: MediaWorkItem[]) => void) | null = null;
  const engine = {
    setMediaWorkListener: (cb: ((w: MediaWorkItem[]) => void) | null) => { listener = cb; },
    processQueue: vi.fn(async () => {}),
    cancelMediaUpload: vi.fn(async () => {}),
  };
  let start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let stop: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetUploadLogForTests();
    start = vi.fn<() => Promise<void>>(async () => {});
    stop = vi.fn<() => Promise<void>>(async () => {});
    const deps: BackgroundTransferDeps = {
      available: () => true,
      start,
      update: async () => {},
      stop,
      notificationPermission: async () => "granted",
      requestNotificationPermission: async () => "granted",
      listen: () => {},
      isVisible: () => true,
      onVisibilityChange: () => {},
      now: () => Date.now(),
    };
    setBackgroundTransferDepsForTests(deps);
  });

  afterEach(() => {
    setBackgroundTransferDepsForTests(null);
    vi.useRealTimers();
  });

  it("starts for queue work alone and stops when the queue is done", async () => {
    const off = initBackgroundUploads(engine);
    listener?.([{ clientId: "shared-1", phase: "waiting" }, { clientId: "shared-2", phase: "uploading", percent: 10 }]);
    await vi.advanceTimersByTimeAsync(START_DELAY_MS + 10);
    expect(start).toHaveBeenCalledTimes(1);
    expect(getUploadLog().find((e) => e.e === "fgs:start")?.d).toMatchObject({ items: 2 });

    listener?.([]);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 10);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getUploadLog().find((e) => e.e === "fgs:stop")?.d).toMatchObject({ reason: "done", n: 2 });
    off();
  });
});
