/**
 * Head-of-line blocking (standbyfix4 field log): 2 photos and a video sent at
 * 08:41 waited until 08:48 behind two big videos that were uploading and
 * retrying in the same room. A small media item may now start while media
 * ahead of it uploads or waits out a backoff; texts keep strict FIFO, and two
 * big uploads never run at the same time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";
import {
  controllableUpload,
  makeMediaHarness,
  seedMediaSend,
  seedTextSend,
  waitUntil,
  type MediaHarness,
} from "./media-engine-harness";

const mockMatrix = {
  isReady: () => true,
  /** Texts and media events both go out through sendEncryptedText. */
  sendEncryptedText: vi.fn<(roomId: string, content: { msgtype?: string }, txnId?: string) => Promise<string>>(
    async () => "$event",
  ),
  uploadContent: vi.fn<(blob: Blob, p?: (x: { loaded: number; total: number }) => void, s?: AbortSignal) => Promise<string>>(),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

const MiB = 1024 * 1024;
const textSends = () => mockMatrix.sendEncryptedText.mock.calls.filter((c) => c[1].msgtype === "m.text").length;
const statusOf = async (h: MediaHarness, clientId: string) =>
  (await h.db.messages.where("clientId").equals(clientId).first())?.status;

describe("SyncEngine: small media overtakes a big upload in the same room", () => {
  let h: MediaHarness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
  });

  it("a photo goes out while the video ahead of it uploads; a text after it waits for both", async () => {
    h = makeMediaHarness(`overtake-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const video = controllableUpload();
    mockMatrix.uploadContent.mockImplementationOnce(video.impl).mockImplementation(async () => "mxc://server/photo");

    await seedMediaSend(h.db, { clientId: "cli_video", size: 40 * MiB });
    await seedMediaSend(h.db, { clientId: "cli_photo", size: 800_000 });
    await seedTextSend(h.db, "cli_text");
    h.engine.processQueue();

    await waitUntil(async () => (await statusOf(h, "cli_photo")) === "synced");
    expect(await statusOf(h, "cli_video")).toBe("pending");
    // The text must not overtake the video.
    await new Promise((r) => setTimeout(r, 30));
    expect(textSends()).toBe(0);

    video.resolve("mxc://server/video");
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
    expect(textSends()).toBe(1);
  });

  it("a photo goes out while the video ahead of it waits out a retry backoff", async () => {
    h = makeMediaHarness(`overtake-backoff-${Date.now()}-${Math.random()}`);
    await h.db.open();
    mockMatrix.uploadContent.mockImplementation(async () => "mxc://server/ok");

    const videoOp = await seedMediaSend(h.db, { clientId: "cli_video", size: 52 * MiB, retries: 1 });
    await h.db.pendingOps.update(videoOp, { nextAttemptAt: Date.now() + 60_000 });
    await seedMediaSend(h.db, { clientId: "cli_photo", size: 800_000 });
    h.engine.processQueue();

    await waitUntil(async () => (await statusOf(h, "cli_photo")) === "synced");
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    expect((await h.db.pendingOps.get(videoOp))?.status).toBe("pending");
  });

  it("two big videos never upload at the same time", async () => {
    h = makeMediaHarness(`overtake-big-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const first = controllableUpload();
    mockMatrix.uploadContent.mockImplementationOnce(first.impl).mockImplementation(async () => "mxc://server/two");

    await seedMediaSend(h.db, { clientId: "cli_v1", size: 40 * MiB });
    await seedMediaSend(h.db, { clientId: "cli_v2", size: 40 * MiB });
    h.engine.processQueue();
    await waitUntil(() => mockMatrix.uploadContent.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);

    first.resolve();
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
  });

  it("an op without a recorded size (queued by an older build) never overtakes", async () => {
    h = makeMediaHarness(`overtake-legacy-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const first = controllableUpload();
    mockMatrix.uploadContent.mockImplementationOnce(first.impl).mockImplementation(async () => "mxc://server/two");

    await seedMediaSend(h.db, { clientId: "cli_v1", size: 40 * MiB });
    await seedMediaSend(h.db, { clientId: "cli_old" });
    h.engine.processQueue();
    await waitUntil(() => mockMatrix.uploadContent.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    first.resolve();
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
  });

  it("a photo does not overtake a text queued ahead of it", async () => {
    h = makeMediaHarness(`overtake-text-${Date.now()}-${Math.random()}`);
    await h.db.open();
    let releaseText: () => void = () => {};
    mockMatrix.sendEncryptedText.mockImplementationOnce(
      () => new Promise<string>((resolve) => (releaseText = () => resolve("$text"))),
    );
    mockMatrix.uploadContent.mockImplementation(async () => "mxc://server/ok");

    await seedTextSend(h.db, "cli_text");
    await seedMediaSend(h.db, { clientId: "cli_photo", size: 800_000 });
    h.engine.processQueue();
    await waitUntil(() => textSends() === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockMatrix.uploadContent).not.toHaveBeenCalled();

    releaseText();
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });
});
