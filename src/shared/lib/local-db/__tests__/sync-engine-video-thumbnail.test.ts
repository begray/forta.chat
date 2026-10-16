/**
 * SyncEngine.syncSendFile for an m.video with a poster frame: the thumbnail
 * is encrypted like the video and goes out as info.thumbnail_file (encrypted
 * rooms) or info.thumbnail_url (plain rooms) with thumbnail_info. If the
 * thumbnail upload fails, the video is still sent, just without one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

const uploads: { size: number; type: string }[] = [];
let failThumbnail = false;

const mockMatrix = {
  sendEncryptedText: vi.fn(async (_roomId: string, _content: Record<string, unknown>, _txn?: string) => "$event"),
  uploadContent: vi.fn(async (blob: Blob, _progress?: unknown, _signal?: AbortSignal) => {
    uploads.push({ size: blob.size, type: blob.type });
    // The thumbnail is the small second upload.
    if (uploads.length === 2) {
      if (failThumbnail) throw new Error("502 Bad Gateway");
      return "https://server/_matrix/media/r0/download/server/thumb";
    }
    return "https://server/_matrix/media/r0/download/server/video";
  }),
};

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => mockMatrix }));

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<LocalAttachment, number>;
  users!: Dexie.Table<{ address: string }, string>;
  syncState!: Dexie.Table<{ key: string; value: string | number }, string>;
  decryptionQueue!: Dexie.Table<{ id?: number; status: string }, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
      users: "address, updatedAt",
      syncState: "key",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });
  }
}

function makeHarness(encrypted: boolean) {
  const db = new TestDb(`video-thumb-${Date.now()}-${Math.random()}`);
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    confirmMediaSent: vi.fn(async (..._args: unknown[]) => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    updateReactions: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
    updateUploadProgress: vi.fn(async () => undefined),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  let n = 0;
  const roomCrypto = encrypted
    ? {
        canBeEncrypt: () => true,
        requiresEncryption: () => true,
        encryptFile: async (blob: Blob) => ({
          file: new File([blob], "enc", { type: "application/octet-stream" }),
          secrets: { keys: `k${++n}`, block: 10, v: 2 },
        }),
      }
    : undefined;
  const engine = new SyncEngine(db as never, messageRepo as never, roomRepo as never, (async () => roomCrypto) as never);
  return { db, engine, messageRepo };
}

async function seedVideo(db: TestDb, withThumb = true): Promise<void> {
  const attachmentId = (await db.attachments.add({
    messageLocalId: 1,
    fileName: "bb4dde02-5e74-4fbd-95c7-ef86c1a2b3c4.mp4",
    mimeType: "video/mp4",
    size: 3000,
    localBlob: new Blob(["v".repeat(3000)], { type: "video/mp4" }),
    status: "local",
    ...(withThumb
      ? { thumbnail: { blob: new Blob(["t".repeat(300)], { type: "image/jpeg" }), w: 270, h: 480, mimetype: "image/jpeg", size: 300 } }
      : {}),
  } as LocalAttachment)) as number;
  await db.pendingOps.add({
    type: "send_file",
    roomId: "!room:server",
    payload: {
      fileName: "bb4dde02-5e74-4fbd-95c7-ef86c1a2b3c4.mp4",
      mimeType: "video/mp4",
      msgtype: "m.video",
      body: "Video",
      eventInfo: { mimetype: "video/mp4", size: 3000, w: 720, h: 1280, duration: 42_000 },
      attachmentId,
    },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: "cli_video",
    nextAttemptAt: 0,
  } as PendingOperation);
}

async function drain(db: TestDb): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await db.pendingOps.count()) === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("queue did not drain");
}

const sentContent = () => mockMatrix.sendEncryptedText.mock.calls[0][1] as { msgtype: string; body: string; info: Record<string, unknown> };

describe("syncSendFile: m.video thumbnail", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    vi.clearAllMocks();
    uploads.length = 0;
    failThumbnail = false;
  });
  afterEach(async () => { if (h) await disposeSyncEngineHarness(h); });

  it("encrypted room: thumbnail_file with its own secrets, plus size/duration; the bubble keeps it too", async () => {
    h = makeHarness(true);
    await h.db.open();
    await seedVideo(h.db);
    await h.engine.processQueue();
    await drain(h.db);

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
    const content = sentContent();
    expect(content.msgtype).toBe("m.video");
    expect(content.body).toBe("Video");
    expect(content.info).toMatchObject({
      mimetype: "video/mp4",
      w: 720,
      h: 1280,
      duration: 42_000,
      secrets: { keys: "k1", block: 10, v: 2 },
      thumbnail_file: { url: "https://server/_matrix/media/r0/download/server/thumb", secrets: { keys: "k2", block: 10, v: 2 }, mimetype: "image/jpeg" },
      thumbnail_info: { w: 270, h: 480, mimetype: "image/jpeg", size: 300 },
    });
    expect(content.info).not.toHaveProperty("thumbnail_url");
    // The thumbnail was uploaded encrypted, not as a plain JPEG.
    expect(uploads[1].type).toBe("application/octet-stream");
    const fileInfo = h.messageRepo.confirmMediaSent.mock.calls[0][2] as { thumbnail?: unknown };
    expect(fileInfo.thumbnail).toMatchObject({ url: "https://server/_matrix/media/r0/download/server/thumb", w: 270, h: 480 });
  });

  it("plain room: thumbnail_url + thumbnail_info", async () => {
    h = makeHarness(false);
    await h.db.open();
    await seedVideo(h.db);
    await h.engine.processQueue();
    await drain(h.db);

    const content = sentContent();
    expect(content.info).toMatchObject({
      thumbnail_url: "https://server/_matrix/media/r0/download/server/thumb",
      thumbnail_info: { w: 270, h: 480, mimetype: "image/jpeg", size: 300 },
    });
    expect(content.info).not.toHaveProperty("thumbnail_file");
  });

  it("a failed thumbnail upload sends the video anyway, without a thumbnail, and logs it", async () => {
    failThumbnail = true;
    h = makeHarness(true);
    await h.db.open();
    await seedVideo(h.db);
    await h.engine.processQueue();
    await drain(h.db);

    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
    const content = sentContent();
    expect(content.msgtype).toBe("m.video");
    expect(content.info).not.toHaveProperty("thumbnail_file");
    expect(content.info).not.toHaveProperty("thumbnail_url");
    expect(content.info).toMatchObject({ duration: 42_000, secrets: { keys: "k1" } });
    const { getUploadLog } = await import("@/shared/lib/upload-log/upload-log");
    expect(getUploadLog().some((e) => e.e === "thumb:fail")).toBe(true);
  });

  it("no thumbnail captured: one upload, a plain m.video", async () => {
    h = makeHarness(false);
    await h.db.open();
    await seedVideo(h.db, false);
    await h.engine.processQueue();
    await drain(h.db);

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    expect(sentContent().info).toEqual({ mimetype: "video/mp4", size: 3000, w: 720, h: 1280, duration: 42_000 });
  });
});
