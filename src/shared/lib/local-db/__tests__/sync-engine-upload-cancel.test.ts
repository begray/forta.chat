/**
 * Cancel is terminal (standbyfix4 field log): tapping X on an uploading video
 * logged "state:cancelled inFlight=true" and then "op:retry attempt=1
 * delayS=2.87 err=AbortError". The worker's catch treated the user's abort
 * as a transport failure: it scheduled a retry, and on the last attempt it
 * flipped the cancelled bubble to "failed". A cancelled upload must end with
 * no retry, no failed bubble, no op and no second upload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";
import {
  controllableUpload,
  makeMediaHarness,
  seedMediaSend,
  waitUntil,
  type MediaHarness,
} from "./media-engine-harness";
import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";

const mockMatrix = {
  isReady: () => true,
  sendEncryptedText: vi.fn(async () => "$event"),
  sendText: vi.fn(async () => "$text"),
  uploadContent: vi.fn<(blob: Blob, p?: (x: { loaded: number; total: number }) => void, s?: AbortSignal) => Promise<string>>(),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

// The log keeps the first 8 characters of a clientId.
const events = (clientId: string) => getUploadLog().filter((e) => e.c === clientId.slice(0, 8)).map((e) => e.e);

describe("SyncEngine: cancelling an upload is terminal", () => {
  let h: MediaHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    resetUploadLogForTests();
  });

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
  });

  it.each([
    ["the first attempt", 0],
    ["the last attempt", 4],
  ])("cancel during %s: no retry, no failed bubble, no second upload", async (_label, retries) => {
    h = makeMediaHarness(`cancel-${retries}-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const upload = controllableUpload();
    mockMatrix.uploadContent.mockImplementation(upload.impl);

    await seedMediaSend(h.db, { clientId: "cli_cancel", retries });
    h.engine.processQueue();
    await waitUntil(() => mockMatrix.uploadContent.mock.calls.length === 1);

    await h.engine.cancelMediaUpload("cli_cancel");
    expect(upload.signal?.aborted).toBe(true);

    // The worker has seen the abort; give its bookkeeping time to run.
    await waitUntil(() => events("cli_cancel").includes("upload:fail"));
    await new Promise((r) => setTimeout(r, 50));

    const log = events("cli_cancel");
    expect(log).not.toContain("op:retry");
    expect(log).toContain("op:cancelled");
    expect(log).not.toContain("state:failed");
    expect(await h.db.pendingOps.count()).toBe(0);
    expect(h.messageRepo.updateStatus).not.toHaveBeenCalledWith({ clientId: "cli_cancel" }, "failed");
    const msg = await h.db.messages.where("clientId").equals("cli_cancel").first();
    expect(msg?.status).toBe("pending"); // use-messages flips it to "cancelled"
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    expect(mockMatrix.sendEncryptedText).not.toHaveBeenCalled();
  });

  it("a cancel while the op waits out a backoff deletes it, and it never uploads again", async () => {
    h = makeMediaHarness(`cancel-backoff-${Date.now()}-${Math.random()}`);
    await h.db.open();
    mockMatrix.uploadContent.mockImplementation(async () => "mxc://server/ok");

    const opId = await seedMediaSend(h.db, { clientId: "cli_wait", retries: 1 });
    await h.db.pendingOps.update(opId, { nextAttemptAt: Date.now() + 60_000 });
    h.engine.processQueue();
    await new Promise((r) => setTimeout(r, 20));

    await h.engine.cancelMediaUpload("cli_wait");
    expect(await h.db.pendingOps.count()).toBe(0);
    h.engine.processQueue();
    await new Promise((r) => setTimeout(r, 30));
    expect(mockMatrix.uploadContent).not.toHaveBeenCalled();
  });

  it("the next upload of the room starts right after a cancel", async () => {
    h = makeMediaHarness(`cancel-next-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const first = controllableUpload();
    mockMatrix.uploadContent.mockImplementationOnce(first.impl).mockImplementation(async () => "mxc://server/two");

    await seedMediaSend(h.db, { clientId: "cli_big" });
    await seedMediaSend(h.db, { clientId: "cli_next" });
    h.engine.processQueue();
    await waitUntil(() => mockMatrix.uploadContent.mock.calls.length === 1);

    await h.engine.cancelMediaUpload("cli_big");
    await waitUntil(async () => (await h.db.pendingOps.count()) === 0);
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
    expect(events("cli_big")).not.toContain("op:retry");
    expect(events("cli_next")).toContain("state:sent");
  });
});
