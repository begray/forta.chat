/**
 * Files over the server limit (standbyfix4 field log): 52.8 MB and 92.8 MB
 * videos uploaded to 100 % and then failed with "Upload failed: network
 * error" on every try, 4 in-attempt tries x 5 attempts, re-armed on every
 * resume. pocketnet's nginx answers bodies over ~50 MiB with a 502 that has
 * no CORS header, so the WebView XHR sees status 0. Such a failure after the
 * last byte, or a 413/502, is now terminal: one try, op failed, bubble
 * "too large", and neither resume nor reconnect re-arms it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyTooLarge, UploadTooLargeError } from "../sync-engine";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";
import { makeMediaHarness, seedMediaSend, waitUntil, type MediaHarness } from "./media-engine-harness";
import { resetUploadLimitForTests } from "@/shared/lib/file-transfer/upload-limit";

const mockMatrix = {
  isReady: () => true,
  sendEncryptedText: vi.fn(async () => "$event"),
  sendText: vi.fn(async () => "$text"),
  uploadContent: vi.fn<(blob: Blob, p?: (x: { loaded: number; total: number }) => void, s?: AbortSignal) => Promise<string>>(),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

const MiB = 1024 * 1024;
const networkError = () => new Error("Upload failed: network error");

describe("classifyTooLarge", () => {
  it("a network error after the full body of a big file is the size limit", () => {
    expect(classifyTooLarge(networkError(), 52_806_192, 52_806_192, 52_806_192)).toBeInstanceOf(UploadTooLargeError);
  });

  it("a network error mid-body, or after the full body of a small file, is a normal failure", () => {
    expect(classifyTooLarge(networkError(), 46_947_125, 52_806_192, 52_806_192)).toBeNull();
    expect(classifyTooLarge(networkError(), 10 * MiB, 10 * MiB, 10 * MiB)).toBeNull();
  });

  it("413 at any point, 502 after the full body", () => {
    expect(classifyTooLarge(new Error("Upload failed: status 413 (M_TOO_LARGE)"), 0, 100, 100)).toBeInstanceOf(UploadTooLargeError);
    expect(classifyTooLarge(new Error("Upload failed: status 502"), 100, 100, 100)).toBeInstanceOf(UploadTooLargeError);
    expect(classifyTooLarge(new Error("Upload failed: status 502"), 50, 100, 100)).toBeNull();
  });

  it("never an abort", () => {
    expect(classifyTooLarge(new DOMException("Upload cancelled", "AbortError"), 100, 100, 60 * MiB)).toBeNull();
  });
});

describe("SyncEngine: an upload the server refuses for its size", () => {
  let h: MediaHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    resetUploadLimitForTests();
  });

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
  });

  it("fails after one try with uploadError too_large, and reconnect / resume leave it failed", async () => {
    h = makeMediaHarness(`too-large-${Date.now()}-${Math.random()}`);
    await h.db.open();
    // The whole body goes out, then the proxy's 502 arrives without CORS.
    mockMatrix.uploadContent.mockImplementation(async (blob, progress) => {
      progress?.({ loaded: blob.size, total: blob.size });
      throw new Error("Upload failed: status 502");
    });

    const opId = await seedMediaSend(h.db, { clientId: "cli_big" });
    h.engine.processQueue();
    await waitUntil(async () => (await h.db.messages.where("clientId").equals("cli_big").first())?.uploadError === "too_large");
    expect((await h.db.pendingOps.get(opId))?.status).toBe("failed");

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    const msg = await h.db.messages.where("clientId").equals("cli_big").first();
    expect(msg?.status).toBe("failed");
    expect(msg?.uploadError).toBe("too_large");

    // Offline → online edge and an app resume: neither re-arms it.
    h.engine.setOnline(false);
    h.engine.setOnline(true);
    h.engine.noteBackground();
    await h.engine.resumeAfterBackground();
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.db.pendingOps.get(opId))?.status).toBe("failed");
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("a manual Retry re-arms it and clears the too-large note", async () => {
    h = makeMediaHarness(`too-large-retry-${Date.now()}-${Math.random()}`);
    await h.db.open();
    mockMatrix.uploadContent
      .mockImplementationOnce(async () => {
        throw new Error("Upload failed: status 413");
      })
      .mockImplementation(async () => "mxc://server/ok");

    await seedMediaSend(h.db, { clientId: "cli_retry" });
    h.engine.processQueue();
    // The bubble is marked last; Retry is tapped on the bubble.
    await waitUntil(async () => (await h.db.messages.where("clientId").equals("cli_retry").first())?.uploadError === "too_large");

    expect(await h.engine.retryMediaOperation("cli_retry")).toBe(true);
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
    const msg = await h.db.messages.where("clientId").equals("cli_retry").first();
    expect(msg?.uploadError).toBeUndefined();
    expect(msg?.status).toBe("synced");
  });
});
