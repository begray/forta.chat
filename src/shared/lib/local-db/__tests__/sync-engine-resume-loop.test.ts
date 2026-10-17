/**
 * Video uploads looping forever after the standby fix.
 *
 * Reported on the standbyfix2 build: a video sent to a chat "entered an
 * infinite upload loop". resumeAfterBackground aborted every upload that
 * reported no progress within the grace after a foreground signal and
 * restarted it WITHOUT counting a retry, so:
 *   - an upload whose transport reports no progress (fetch, an XHR the
 *     service worker answers) or that already sent every byte and is waiting
 *     for the server was "stalled" on every foreground signal;
 *   - any foreground signal counted, even without a background before it
 *     (permission dialog, picker, the second of the two resume events);
 *   - a link that kept dying restarted for free forever, never ending as
 *     failed with a Retry;
 *   - failed media were re-armed on every resume, not just the ones that
 *     failed while the phone slept;
 *   - the upload deadline rejected without cancelling the XHR, so the retry
 *     raced the first upload of the same video.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import { MessageRepository } from "../message-repository";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";
import { MessageType } from "@/entities/chat/model/types";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

type Progress = { loaded: number; total: number; estimated?: boolean };
type UploadFn = (blob: Blob, progress?: (p: Progress) => void, signal?: AbortSignal) => Promise<string>;

const mockMatrix = {
  sendEncryptedText: vi.fn<(roomId: string, content: unknown, txnId?: string) => Promise<string>>(),
  uploadContent: vi.fn<UploadFn>(),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

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
const STALL_GRACE_MS = 50;
const TICK_MS = 10;

interface Harness {
  db: TestDb;
  engine: SyncEngine;
  repo: MessageRepository;
}

function makeEngine(db: TestDb, options: Record<string, number> = {}): Harness {
  const repo = new MessageRepository(db as never);
  const roomRepo = {
    updateRoom: vi.fn(async () => undefined),
    syncLastMessageLocalStatus: vi.fn(async () => undefined),
  };
  const engine = new SyncEngine(db as never, repo, roomRepo as never, async () => undefined, undefined, {
    resumeStallGraceMs: STALL_GRACE_MS,
    uploadWatchTickMs: TICK_MS,
    ...options,
  } as never);
  return { db, engine, repo };
}

async function seedVideoSend(db: TestDb, clientId: string, maxRetries = 5): Promise<void> {
  const localId = await db.messages.add({
    eventId: null,
    clientId,
    roomId: ROOM,
    senderId: "me",
    content: "clip.mp4",
    timestamp: Date.now(),
    type: MessageType.video,
    status: "pending",
    version: 1,
    softDeleted: false,
    uploadProgress: 0,
    localBlobUrl: `blob:session/${clientId}`,
    fileInfo: { name: "clip.mp4", type: "video/mp4", size: 3, url: `blob:session/${clientId}` },
  } as LocalMessage);
  const attachmentId = await db.attachments.add({
    messageLocalId: localId,
    fileName: "clip.mp4",
    mimeType: "video/mp4",
    size: 3,
    localBlob: new Blob(["VID"], { type: "video/mp4" }),
    status: "local",
  });
  await db.pendingOps.add({
    type: "send_file",
    roomId: ROOM,
    payload: { fileName: "clip.mp4", mimeType: "video/mp4", msgtype: "m.video", attachmentId },
    status: "pending",
    retries: 0,
    maxRetries,
    createdAt: Date.now(),
    clientId,
    nextAttemptAt: 0,
  } as PendingOperation);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Screen locked, then unlocked: one real background→foreground transition. */
async function backgroundAndResume(engine: SyncEngine): Promise<void> {
  (engine as unknown as { noteBackground?: () => void }).noteBackground?.();
  await engine.resumeAfterBackground();
}

async function opOf(db: TestDb, clientId: string) {
  return db.pendingOps.where("clientId").equals(clientId).first();
}

async function messageStatus(db: TestDb, clientId: string) {
  return (await db.messages.where("clientId").equals(clientId).first())?.status;
}

/** An upload that reports `progress` once, then goes silent until aborted. */
function silentAfter(progress: Progress | null, signals: AbortSignal[] = []): UploadFn {
  return (_blob, report, signal) =>
    new Promise<string>((_resolve, reject) => {
      if (signal) signals.push(signal);
      if (progress) report?.(progress);
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

describe("SyncEngine — resume must not loop media uploads", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    mockMatrix.sendEncryptedText.mockImplementation(async () => `$event_${++n}`);
  });

  afterEach(async () => {
    if (h) await disposeSyncEngineHarness(h);
  });

  it("an upload whose transport reports no progress is never treated as stalled", async () => {
    h = makeEngine(new TestDb(`loop-noprogress-${Date.now()}-${Math.random()}`));
    let finish: (url: string) => void = () => {};
    mockMatrix.uploadContent.mockImplementation(
      (_blob, _report, signal) =>
        new Promise<string>((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await seedVideoSend(h.db, "vid_np");
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    // The user leaves and returns three times while the video uploads.
    for (let i = 0; i < 3; i++) {
      await backgroundAndResume(h.engine);
      await pause(STALL_GRACE_MS * 3);
    }
    finish("mxc://server/video");

    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_np")).toBe("synced"));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("an upload that sent every byte and waits for the server is not restarted", async () => {
    h = makeEngine(new TestDb(`loop-sent-${Date.now()}-${Math.random()}`));
    let finish: (url: string) => void = () => {};
    mockMatrix.uploadContent.mockImplementation(
      (_blob, report) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          report?.({ loaded: 3, total: 3 });
        }),
    );
    await seedVideoSend(h.db, "vid_sent");
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    await backgroundAndResume(h.engine);
    await pause(STALL_GRACE_MS * 3);
    finish("mxc://server/video");

    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_sent")).toBe("synced"));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("a foreground signal without a background before it does not restart uploads", async () => {
    h = makeEngine(new TestDb(`loop-nobg-${Date.now()}-${Math.random()}`));
    let finish: (url: string) => void = () => {};
    mockMatrix.uploadContent.mockImplementation(
      (_blob, report) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          report?.({ loaded: 1, total: 3 });
        }),
    );
    await seedVideoSend(h.db, "vid_nobg");
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    // A permission dialog / picker resumes the activity; appStateChange and
    // visibilitychange of one unlock arrive as two signals.
    await h.engine.resumeAfterBackground();
    await pause(STALL_GRACE_MS * 3);
    finish("mxc://server/video");

    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_nobg")).toBe("synced"));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("returning from the gallery picker leaves a moving upload alone", async () => {
    h = makeEngine(new TestDb(`loop-picker-${Date.now()}-${Math.random()}`));
    let finish: (url: string) => void = () => {};
    let ticker: ReturnType<typeof setInterval> | null = null;
    mockMatrix.uploadContent.mockImplementation(
      (_blob, report) =>
        new Promise<string>((resolve) => {
          let loaded = 0;
          ticker = setInterval(() => report?.({ loaded: Math.min(++loaded, 99), total: 100 }), 10);
          finish = resolve;
        }),
    );
    await seedVideoSend(h.db, "vid_picker");
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    // The picker covers the app (stop) and returns (start): a real
    // background→foreground transition, while the bytes keep moving.
    await backgroundAndResume(h.engine);
    await h.engine.resumeAfterBackground(); // visibilitychange of the same return
    await pause(STALL_GRACE_MS * 4);
    if (ticker) clearInterval(ticker);
    finish("mxc://server/video");

    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_picker")).toBe("synced"));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("with no resume at all, a hung upload ends as failed instead of re-uploading", async () => {
    h = makeEngine(new TestDb(`loop-noresume-${Date.now()}-${Math.random()}`), { uploadTimeoutMs: 60 });
    const signals: AbortSignal[] = [];
    mockMatrix.uploadContent.mockImplementation(silentAfter(null, signals));
    await seedVideoSend(h.db, "vid_hung", 2);
    await h.engine.processQueue();

    await vi.waitFor(async () => expect((await opOf(h.db, "vid_hung"))?.status).toBe("failed"), { timeout: 15_000 });
    expect(await messageStatus(h.db, "vid_hung")).toBe("failed");
    expect((await opOf(h.db, "vid_hung"))?.errorMessage).toMatch(/timed out/);
    // One upload per counted attempt, each cancelled before the next began.
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  }, 20_000);

  it("the second signal of one resume does not arm another stall abort", async () => {
    h = makeEngine(new TestDb(`loop-dup-${Date.now()}-${Math.random()}`));
    const signals: AbortSignal[] = [];
    mockMatrix.uploadContent.mockImplementation(silentAfter({ loaded: 1, total: 3 }, signals));
    await seedVideoSend(h.db, "vid_dup");
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    await backgroundAndResume(h.engine);
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2));
    // Late duplicate foreground signal (past any debounce), no background in between.
    await pause(2_100);
    await h.engine.resumeAfterBackground();
    await pause(STALL_GRACE_MS * 4);

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
  }, 10_000);

  it("a link that keeps dying ends as failed with a working Retry, not a loop", async () => {
    h = makeEngine(new TestDb(`loop-bounded-${Date.now()}-${Math.random()}`));
    mockMatrix.uploadContent.mockImplementation(silentAfter({ loaded: 1, total: 3 }));
    await seedVideoSend(h.db, "vid_dead", 1);
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    // Every unlock finds the socket dead again.
    for (let cycle = 0; cycle < 5; cycle++) {
      if ((await opOf(h.db, "vid_dead"))?.status === "failed") break;
      if (cycle > 0) await pause(2_100); // past any resume debounce
      const calls = mockMatrix.uploadContent.mock.calls.length;
      await backgroundAndResume(h.engine);
      await vi.waitFor(
        async () => {
          const op = await opOf(h.db, "vid_dead");
          expect(op?.status === "failed" || mockMatrix.uploadContent.mock.calls.length > calls).toBe(true);
        },
        { timeout: 3_000 },
      );
    }

    // Two free restarts, then the third stall counts: maxRetries 1 → failed.
    await vi.waitFor(async () => expect((await opOf(h.db, "vid_dead"))?.status).toBe("failed"));
    expect(await messageStatus(h.db, "vid_dead")).toBe("failed");
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(3);

    mockMatrix.uploadContent.mockReset();
    mockMatrix.uploadContent.mockResolvedValue("mxc://server/video");
    expect(await h.engine.retryMediaOperation("vid_dead")).toBe(true);
    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_dead")).toBe("synced"));
  }, 30_000);

  it("media that failed in the foreground are not re-uploaded on every resume", async () => {
    h = makeEngine(new TestDb(`loop-rearm-${Date.now()}-${Math.random()}`));
    h.engine.setOnline(true);
    mockMatrix.uploadContent.mockRejectedValue(new Error("Upload failed: status 500"));
    await seedVideoSend(h.db, "vid_fg", 1);
    await h.engine.processQueue();
    await vi.waitFor(async () => expect((await opOf(h.db, "vid_fg"))?.status).toBe("failed"), { timeout: 15_000 });
    const calls = mockMatrix.uploadContent.mock.calls.length;

    for (let i = 0; i < 3; i++) {
      await pause(2_100); // past any resume debounce
      await backgroundAndResume(h.engine);
    }
    await pause(100);

    expect((await opOf(h.db, "vid_fg"))?.status).toBe("failed");
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(calls);
  }, 30_000);

  it("estimated progress (Tor) is not taken for a stall when it stops at its ceiling", async () => {
    h = makeEngine(new TestDb(`loop-tor-${Date.now()}-${Math.random()}`));
    let finish: (url: string) => void = () => {};
    mockMatrix.uploadContent.mockImplementation(
      (_blob, report) =>
        new Promise<string>((resolve) => {
          finish = resolve;
          report?.({ loaded: 95, total: 100, estimated: true });
        }),
    );
    await seedVideoSend(h.db, "vid_tor");
    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1));

    await backgroundAndResume(h.engine);
    await pause(STALL_GRACE_MS * 3);
    finish("mxc://server/video");

    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_tor")).toBe("synced"));
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("an upload past its deadline is cancelled before the retry uploads the video again", async () => {
    h = makeEngine(new TestDb(`loop-deadline-${Date.now()}-${Math.random()}`), { uploadTimeoutMs: 100 });
    const signals: AbortSignal[] = [];
    mockMatrix.uploadContent
      .mockImplementationOnce(silentAfter(null, signals))
      .mockImplementation(async () => {
        // The first upload must be gone before the retry starts.
        expect(signals[0].aborted).toBe(true);
        return "mxc://server/video";
      });
    await seedVideoSend(h.db, "vid_deadline");
    await h.engine.processQueue();

    await vi.waitFor(async () => expect(await messageStatus(h.db, "vid_deadline")).toBe("synced"), { timeout: 8_000 });
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
    expect((await h.db.pendingOps.count())).toBe(0);
  }, 10_000);

  it("an upload whose bytes stop moving in the foreground is aborted as a counted failure", async () => {
    h = makeEngine(new TestDb(`loop-idle-${Date.now()}-${Math.random()}`), { uploadIdleTimeoutMs: 100 });
    mockMatrix.uploadContent.mockImplementation(silentAfter({ loaded: 1, total: 3 }));
    await seedVideoSend(h.db, "vid_idle", 1);
    await h.engine.processQueue();

    await vi.waitFor(async () => expect((await opOf(h.db, "vid_idle"))?.status).toBe("failed"), { timeout: 5_000 });
    expect((await opOf(h.db, "vid_idle"))?.errorMessage).toMatch(/stalled/i);
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
  });
});
