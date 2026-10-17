/**
 * SyncEngine.setMediaWorkListener: the background-upload keep-alive runs
 * while this list is non-empty, so it must hold every unfinished send_file op
 * (pending, uploading, between retries) and nothing else: a sent, failed or
 * cancelled upload leaves it, and so does everything on dispose (logout).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MediaWorkItem } from "../sync-engine";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";
import { makeMediaHarness, seedMediaSend, waitUntil, type MediaHarness } from "./media-engine-harness";

const mockMatrix = {
  isReady: () => true,
  sendEncryptedText: vi.fn(async () => "$event"),
  sendText: vi.fn(async () => "$text"),
  uploadContent: vi.fn<(blob: Blob, p?: (x: { loaded: number; total: number }) => void, s?: AbortSignal) => Promise<string>>(),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

describe("SyncEngine media work reporting", () => {
  let h: MediaHarness;
  let reports: MediaWorkItem[][];
  const last = () => reports[reports.length - 1] ?? [];

  beforeEach(async () => {
    vi.clearAllMocks();
    h = makeMediaHarness(`media-work-${Date.now()}-${Math.random()}`);
    await h.db.open();
    reports = [];
  });

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
  });

  it("reports a queued upload, its progress, and nothing once it is sent", async () => {
    let finish: (url: string) => void = () => {};
    let progress: ((x: { loaded: number; total: number }) => void) | undefined;
    mockMatrix.uploadContent.mockImplementation((_blob, p) => {
      progress = p;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    await seedMediaSend(h.db, { clientId: "cli_a" });
    h.engine.setMediaWorkListener((w) => reports.push(w));
    await waitUntil(() => last().some((w) => w.clientId === "cli_a"));

    h.engine.processQueue();
    await waitUntil(() => last()[0]?.phase === "uploading");
    progress?.({ loaded: 150, total: 300 });
    expect(last()).toEqual([{ clientId: "cli_a", phase: "uploading", percent: 50 }]);

    finish("mxc://server/done");
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
    await waitUntil(() => last().length === 0);
  });

  it("keeps an upload waiting out a retry, and drops one that failed for good", async () => {
    // Mid-backoff: due in a minute.
    const waitingId = await seedMediaSend(h.db, { clientId: "cli_retry", retries: 1 });
    await h.db.pendingOps.update(waitingId, { nextAttemptAt: Date.now() + 60_000 });
    // Out of retries: the bubble shows Retry, nothing runs.
    const failedId = await seedMediaSend(h.db, { clientId: "cli_fail", roomId: "!other:server" });
    await h.db.pendingOps.update(failedId, { status: "failed", retries: 5 });
    h.engine.setMediaWorkListener((w) => reports.push(w));
    await waitUntil(() => reports.length > 0);
    expect(last()).toEqual([{ clientId: "cli_retry", phase: "waiting" }]);

    // The user's Retry re-arms it: reported again.
    mockMatrix.uploadContent.mockImplementation(() => new Promise<string>(() => {}));
    await h.engine.retryMediaOperation("cli_fail");
    await waitUntil(() => last().some((w) => w.clientId === "cli_fail"));
  });

  it("drops a cancelled upload", async () => {
    mockMatrix.uploadContent.mockImplementation(() => new Promise<string>(() => {}));
    await seedMediaSend(h.db, { clientId: "cli_x" });
    h.engine.setMediaWorkListener((w) => reports.push(w));
    await waitUntil(() => last().length === 1);
    await h.engine.cancelMediaUpload("cli_x");
    await waitUntil(() => last().length === 0);
  });

  it("reports nothing after dispose", async () => {
    await seedMediaSend(h.db, { clientId: "cli_d" });
    h.engine.setMediaWorkListener((w) => reports.push(w));
    await waitUntil(() => last().length === 1);
    h.engine.dispose();
    expect(last()).toEqual([]);
  });

  it("stops reporting once unsubscribed", async () => {
    h.engine.setMediaWorkListener((w) => reports.push(w));
    await waitUntil(() => reports.length > 0);
    h.engine.setMediaWorkListener(null);
    const count = reports.length;
    await seedMediaSend(h.db, { clientId: "cli_late" });
    h.engine.processQueue();
    await new Promise((r) => setTimeout(r, 30));
    expect(reports.length).toBe(count);
  });
});
