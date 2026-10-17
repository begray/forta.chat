/**
 * Media uploads vs. the phone going to standby.
 *
 * Reported: sending a batch of photos/videos, the screen locks mid-upload,
 * the uploads break and Retry does nothing. While the phone sleeps Android
 * cuts the network without flipping navigator.onLine, so:
 *   - queued ops burn their retries and land in "failed", and no
 *     offline→online edge ever re-arms them;
 *   - an in-flight XHR can hang (no progress, no error) until the 4-min
 *     upload timeout;
 *   - the WebView may be reloaded, which kills every blob: URL — the old
 *     Retry re-read the file from that URL and silently gave up.
 *
 * These tests pin the fix: failures surface as "failed" (never a stuck
 * spinner), resumeAfterBackground restarts stalled uploads and re-arms failed
 * ones, Retry re-uploads from the blob persisted in `attachments`, and the
 * queue survives both resume and an engine restart (WebView reload).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import { MessageRepository } from "../message-repository";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";
import { MessageType } from "@/entities/chat/model/types";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

// --- Mocks -------------------------------------------------------------------

type UploadFn = (
  blob: Blob,
  progress?: (p: { loaded: number; total: number }) => void,
  signal?: AbortSignal,
) => Promise<string>;

const mockMatrix = {
  sendEncryptedText: vi.fn<(roomId: string, content: unknown, txnId?: string) => Promise<string>>(),
  uploadContent: vi.fn<UploadFn>(),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

// --- Test DB (indexes mirror schema.ts) ---------------------------------------

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<LocalAttachment, number>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
    });
  }
}

const ROOM = "!room:server";
/** Stall grace after resume (15 s in production). */
const STALL_GRACE_MS = 50;

interface Harness {
  db: TestDb;
  engine: SyncEngine;
  repo: MessageRepository;
}

function makeEngine(db: TestDb): Harness {
  const repo = new MessageRepository(db as never);
  const roomRepo = {
    updateRoom: vi.fn(async () => undefined),
    syncLastMessageLocalStatus: vi.fn(async () => undefined),
  };
  const engine = new SyncEngine(db as never, repo, roomRepo as never, async () => undefined, undefined, {
    resumeStallGraceMs: STALL_GRACE_MS,
  });
  return { db, engine, repo };
}

/** Optimistic media message + persisted blob + queued send_file op, exactly
 *  what sendImage writes. */
async function seedMediaSend(
  db: TestDb,
  clientId: string,
  opts: { maxRetries?: number; content?: string } = {},
): Promise<number> {
  const localId = await db.messages.add({
    eventId: null,
    clientId,
    roomId: ROOM,
    senderId: "me",
    content: "photo.jpg",
    timestamp: Date.now(),
    type: MessageType.image,
    status: "pending",
    version: 1,
    softDeleted: false,
    uploadProgress: 0,
    localBlobUrl: `blob:session-1/${clientId}`,
    fileInfo: { name: "photo.jpg", type: "image/jpeg", size: 3, url: `blob:session-1/${clientId}` },
  } as LocalMessage);
  const attachmentId = await db.attachments.add({
    messageLocalId: localId,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    size: 3,
    localBlob: new Blob([opts.content ?? clientId], { type: "image/jpeg" }),
    status: "local",
  });
  await db.pendingOps.add({
    type: "send_file",
    roomId: ROOM,
    payload: { fileName: "photo.jpg", mimeType: "image/jpeg", msgtype: "m.image", attachmentId },
    status: "pending",
    retries: 0,
    maxRetries: opts.maxRetries ?? 5,
    createdAt: Date.now(),
    clientId,
    nextAttemptAt: 0,
  } as PendingOperation);
  return localId;
}

/** An upload that never progresses and only ends when aborted — a socket
 *  Android dropped while the screen was locked. */
function hangingUpload(): UploadFn {
  return (_blob, _progress, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new DOMException("The user aborted a request.", "AbortError")),
      );
    });
}

async function messageStatus(db: TestDb, clientId: string) {
  return (await db.messages.where("clientId").equals(clientId).first())?.status;
}

async function opStatus(db: TestDb, clientId: string) {
  return (await db.pendingOps.where("clientId").equals(clientId).first())?.status;
}

describe("SyncEngine — media uploads across app background / resume", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    mockMatrix.sendEncryptedText.mockImplementation(async () => `$event_${++n}`);
  });

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
  });

  it("an upload interrupted by standby ends as failed, not a stuck spinner", async () => {
    h = makeEngine(new TestDb(`resume-fail-${Date.now()}-${Math.random()}`));
    mockMatrix.uploadContent.mockRejectedValue(new TypeError("Failed to fetch"));
    // maxRetries 1: the first exhausted attempt is final (keeps the test fast).
    await seedMediaSend(h.db, "cli_sleep", { maxRetries: 1 });

    await h.engine.processQueue();

    await vi.waitFor(async () => expect(await opStatus(h.db, "cli_sleep")).toBe("failed"), { timeout: 15_000 });
    expect(await messageStatus(h.db, "cli_sleep")).toBe("failed");
  }, 20_000);

  it("resume re-arms media that failed in the background and uploads the persisted blob", async () => {
    h = makeEngine(new TestDb(`resume-rearm-${Date.now()}-${Math.random()}`));
    h.engine.setOnline(true); // first online signal (startup) — nothing failed yet
    mockMatrix.uploadContent.mockRejectedValue(new TypeError("Failed to fetch"));
    await seedMediaSend(h.db, "cli_bg", { maxRetries: 1, content: "PHOTO-BYTES" });

    await h.engine.processQueue();
    await vi.waitFor(async () => expect(await messageStatus(h.db, "cli_bg")).toBe("failed"), { timeout: 15_000 });

    // Network is back after unlock; navigator.onLine never changed, so only
    // the foreground signal can bring the upload back.
    mockMatrix.uploadContent.mockReset();
    mockMatrix.uploadContent.mockResolvedValue("mxc://server/ok");
    await h.engine.resumeAfterBackground();

    await vi.waitFor(async () => expect(await messageStatus(h.db, "cli_bg")).toBe("synced"), { timeout: 5_000 });
    expect(await h.db.pendingOps.count()).toBe(0);
    const uploaded = mockMatrix.uploadContent.mock.calls[0][0];
    expect(await uploaded.text()).toBe("PHOTO-BYTES");
  }, 20_000);

  it("resume restarts an upload that stalled while the screen was locked", async () => {
    h = makeEngine(new TestDb(`resume-stall-${Date.now()}-${Math.random()}`));
    mockMatrix.uploadContent
      .mockImplementationOnce(hangingUpload())
      .mockResolvedValue("mxc://server/ok");
    await seedMediaSend(h.db, "cli_stall", { maxRetries: 1 });

    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    await h.engine.resumeAfterBackground(); // no progress within the grace

    await vi.waitFor(async () => expect(await messageStatus(h.db, "cli_stall")).toBe("synced"), { timeout: 5_000 });
    // Restarted, not failed: maxRetries is 1, so a counted retry would have
    // marked it failed instead of uploading again.
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
  });

  it("resume leaves an upload that reports progress after unlock alone", async () => {
    h = makeEngine(new TestDb(`resume-live-${Date.now()}-${Math.random()}`));
    let finish: (url: string) => void = () => {};
    let report: (p: { loaded: number; total: number }) => void = () => {};
    mockMatrix.uploadContent.mockImplementationOnce((_blob, progress) =>
      new Promise<string>((resolve) => {
        finish = resolve;
        report = progress ?? report;
      }),
    );
    await seedMediaSend(h.db, "cli_live");

    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    // The connection survived the freeze: progress arrives after resume.
    await h.engine.resumeAfterBackground();
    await new Promise((r) => setTimeout(r, 5));
    report({ loaded: 1, total: 3 });
    await new Promise((r) => setTimeout(r, STALL_GRACE_MS * 3));
    finish("mxc://server/ok");

    await vi.waitFor(async () => expect(await messageStatus(h.db, "cli_live")).toBe("synced"), { timeout: 5_000 });
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("resume does not re-upload media that failed as too large", async () => {
    h = makeEngine(new TestDb(`resume-413-${Date.now()}-${Math.random()}`));
    h.engine.setOnline(true);
    mockMatrix.uploadContent.mockRejectedValue(new Error("413 Payload Too Large"));
    await seedMediaSend(h.db, "cli_big", { maxRetries: 1 });
    await h.engine.processQueue();
    await vi.waitFor(async () => expect(await opStatus(h.db, "cli_big")).toBe("failed"), { timeout: 5_000 });
    mockMatrix.uploadContent.mockClear();

    await h.engine.resumeAfterBackground();
    await new Promise((r) => setTimeout(r, 50));

    expect(await opStatus(h.db, "cli_big")).toBe("failed");
    expect(mockMatrix.uploadContent).not.toHaveBeenCalled();
  });

  it("the queued batch survives resume and is delivered in order", async () => {
    h = makeEngine(new TestDb(`resume-batch-${Date.now()}-${Math.random()}`));
    const uploadedOrder: string[] = [];
    mockMatrix.uploadContent
      .mockImplementationOnce(hangingUpload())
      .mockImplementation(async (blob) => {
        uploadedOrder.push(await blob.text());
        return "mxc://server/ok";
      });
    for (const id of ["p1", "p2", "p3"]) await seedMediaSend(h.db, id, { maxRetries: 1 });

    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    await h.engine.resumeAfterBackground();

    await vi.waitFor(async () => expect(await h.db.pendingOps.count()).toBe(0), { timeout: 5_000 });
    expect(uploadedOrder).toEqual(["p1", "p2", "p3"]);
    for (const id of ["p1", "p2", "p3"]) expect(await messageStatus(h.db, id)).toBe("synced");
  });

  it("the queue survives a WebView reload mid-upload", async () => {
    const db = new TestDb(`resume-reload-${Date.now()}-${Math.random()}`);
    const first = makeEngine(db);
    mockMatrix.uploadContent.mockImplementationOnce(hangingUpload());
    await seedMediaSend(db, "cli_reload");
    await first.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));
    expect(await opStatus(db, "cli_reload")).toBe("syncing");

    // Process killed: the old engine is gone, the op is stranded in "syncing".
    first.engine.dispose();
    h = makeEngine(db);
    mockMatrix.uploadContent.mockResolvedValue("mxc://server/ok");
    const stranded = await h.engine.snapshotStrandedOpIds();
    await h.engine.recoverStrandedOps(stranded);
    await h.engine.processQueue();

    await vi.waitFor(async () => expect(await messageStatus(db, "cli_reload")).toBe("synced"), { timeout: 5_000 });
  });

  it("Retry after a reload re-uploads from the persisted blob, not the dead blob: URL", async () => {
    const db = new TestDb(`resume-retry-${Date.now()}-${Math.random()}`);
    const first = makeEngine(db);
    mockMatrix.uploadContent.mockRejectedValue(new TypeError("Failed to fetch"));
    await seedMediaSend(db, "cli_retry", { maxRetries: 1, content: "VIDEO-BYTES" });
    await first.engine.processQueue();
    await vi.waitFor(async () => expect(await messageStatus(db, "cli_retry")).toBe("failed"), { timeout: 15_000 });

    // Reload: new engine; the message's blob:session-1 URL is dead now.
    first.engine.dispose();
    h = makeEngine(db);
    mockMatrix.uploadContent.mockReset();
    let release: (url: string) => void = () => {};
    mockMatrix.uploadContent.mockImplementation(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );

    expect(await h.engine.retryMediaOperation("cli_retry")).toBe(true);
    // The bubble leaves the failed state immediately.
    const retrying = await db.messages.where("clientId").equals("cli_retry").first();
    expect(retrying?.status).toBe("pending");
    expect(retrying?.uploadProgress).toBe(0);

    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));
    expect(await mockMatrix.uploadContent.mock.calls[0][0].text()).toBe("VIDEO-BYTES");
    release("mxc://server/ok");
    await vi.waitFor(async () => expect(await messageStatus(db, "cli_retry")).toBe("synced"), { timeout: 5_000 });
  }, 20_000);

  it("retryMediaOperation reports false when no send_file op is queued", async () => {
    h = makeEngine(new TestDb(`resume-noop-${Date.now()}-${Math.random()}`));
    expect(await h.engine.retryMediaOperation("cli_missing")).toBe(false);
  });

  it("resume does nothing while offline", async () => {
    h = makeEngine(new TestDb(`resume-offline-${Date.now()}-${Math.random()}`));
    mockMatrix.uploadContent.mockResolvedValue("mxc://server/ok");
    await seedMediaSend(h.db, "cli_offline");
    await h.db.pendingOps.where("clientId").equals("cli_offline").modify({ status: "failed" });
    h.engine.setOnline(false);

    await h.engine.resumeAfterBackground();

    expect(await opStatus(h.db, "cli_offline")).toBe("failed");
    expect(mockMatrix.uploadContent).not.toHaveBeenCalled();
  });
});
