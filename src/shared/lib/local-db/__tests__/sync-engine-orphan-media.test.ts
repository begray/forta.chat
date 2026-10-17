/**
 * Media bubbles stuck in "sending" with nothing behind them.
 *
 *  - The watchdog fails such a bubble IN-SESSION (before: only the startup
 *    recovery did, so it spun until the app was restarted): Retry + Delete
 *    when the file copy exists, "file lost" when it does not.
 *  - A send_file op whose file copy is gone fails at once as "file lost"
 *    instead of burning five retries and coming back on every resume.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import { MessageRepository } from "../message-repository";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";
import { MessageType } from "@/entities/chat/model/types";
import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({
    isReady: () => true,
    uploadContent: vi.fn(async () => "https://server/media/abc"),
    sendEncryptedText: vi.fn(async () => "$event"),
  }),
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
let db: TestDb;
let engine: SyncEngine;
let repo: MessageRepository;
let n = 0;

function media(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: null,
    clientId: `cli-${Math.random().toString(36).slice(2)}`,
    roomId: ROOM,
    senderId: "me",
    content: "photo.jpg",
    timestamp: Date.now() - 2 * 60_000,
    type: MessageType.image,
    status: "pending",
    version: 1,
    softDeleted: false,
    uploadProgress: 0,
    ...overrides,
  } as LocalMessage;
}

beforeEach(async () => {
  resetUploadLogForTests();
  db = new TestDb(`orphan-media-${n++}`);
  repo = new MessageRepository(db as never);
  const roomRepo = { syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  engine = new SyncEngine(db as never, repo, roomRepo as never, async () => undefined);
});

afterEach(async () => {
  engine.dispose();
  vi.useRealTimers();
  db.close();
  await db.delete();
});

/** Run one watchdog tick (private) directly. */
async function watchdogTick(): Promise<void> {
  await (engine as unknown as { watchdogCheck(): Promise<void> }).watchdogCheck();
}

describe("in-session orphan sweep (watchdog)", () => {
  it("fails a bubble with no op but a file copy: Retry stays possible", async () => {
    const localId = await db.messages.add(media());
    await db.attachments.add({ messageLocalId: localId, fileName: "photo.jpg", mimeType: "image/jpeg", size: 4, localBlob: new Blob(["jpeg"]), status: "local" });
    await db.rooms.add({ id: ROOM, lastMessageTimestamp: (await db.messages.get(localId))!.timestamp } as LocalRoom);

    await watchdogTick();

    const msg = await db.messages.get(localId);
    expect(msg?.status).toBe("failed");
    expect(msg?.uploadError).toBeUndefined();
    expect(msg?.uploadProgress).toBeUndefined();
    expect((await db.rooms.get(ROOM))?.lastMessageLocalStatus).toBe("failed");
    expect(getUploadLog().find((e) => e.e === "state:failed")?.d?.fileLost).toBe(false);
  });

  it("marks a bubble with neither op nor file copy as file lost", async () => {
    const localId = await db.messages.add(media());

    await watchdogTick();

    const msg = await db.messages.get(localId);
    expect(msg?.status).toBe("failed");
    expect(msg?.uploadError).toBe("file_lost");
  });

  it("leaves bubbles alone that are recent, have a live op, or run an inline retry", async () => {
    const recent = await db.messages.add(media({ timestamp: Date.now() - 5_000 }));
    const queued = media();
    const queuedId = await db.messages.add(queued);
    await db.pendingOps.add({
      type: "send_file", roomId: ROOM, payload: {}, status: "pending", retries: 0, maxRetries: 5,
      createdAt: Date.now(), clientId: queued.clientId, nextAttemptAt: Date.now() + 60_000,
    });
    const inline = await db.messages.add(media({ uploadPhase: "uploading" }));
    engine.setOnline(false);

    await watchdogTick();

    expect((await db.messages.get(recent))?.status).toBe("pending");
    expect((await db.messages.get(queuedId))?.status).toBe("pending");
    expect((await db.messages.get(inline))?.status).toBe("pending");
  });

  it("fails a pending bubble whose op already failed (Retry re-arms that op)", async () => {
    const msg = media();
    const localId = await db.messages.add(msg);
    await db.pendingOps.add({
      type: "send_file", roomId: ROOM, payload: {}, status: "failed", retries: 5, maxRetries: 5,
      createdAt: Date.now(), clientId: msg.clientId,
    });

    await watchdogTick();

    expect((await db.messages.get(localId))?.status).toBe("failed");
  });

  it("the startup recovery still fails orphans from the previous session", async () => {
    const localId = await db.messages.add(media({ uploadPhase: "uploading", timestamp: Date.now() - 10 * 60_000 }));

    expect(await repo.recoverStuckMedia()).toBe(1);

    const msg = await db.messages.get(localId);
    expect(msg?.status).toBe("failed");
    expect(msg?.uploadPhase).toBeUndefined();
  });
});

describe("send_file op whose file copy is gone", () => {
  it("fails at once as file lost and drops the op", async () => {
    const msg = media({ timestamp: Date.now() });
    const localId = await db.messages.add(msg);
    await engine.enqueue("send_file", ROOM, { fileName: "photo.jpg", mimeType: "image/jpeg", msgtype: "m.image", attachmentId: 999 }, msg.clientId);

    await vi.waitFor(async () => {
      expect((await db.messages.get(localId))?.status).toBe("failed");
    });

    expect((await db.messages.get(localId))?.uploadError).toBe("file_lost");
    expect(await db.pendingOps.count()).toBe(0);
    const events = getUploadLog().map((e) => e.e);
    expect(events).toContain("blob:missing");
    expect(events).toContain("state:file-lost");
  });
});

describe("enqueueMediaSend", () => {
  it("writes bubble, file copy and op together and links them", async () => {
    await db.rooms.add({ id: ROOM } as LocalRoom);
    engine.setOnline(false);

    const { message, attachmentId, opId } = await engine.enqueueMediaSend({
      message: { roomId: ROOM, senderId: "me", content: "a.jpg", type: MessageType.image, uploadProgress: 0, clientId: "fixed-client-id" },
      attachment: { fileName: "a.jpg", mimeType: "image/jpeg", size: 1, localBlob: new Blob(["a"]) },
      payload: { msgtype: "m.image" },
    });

    expect(message.clientId).toBe("fixed-client-id");
    expect((await db.attachments.get(attachmentId))?.messageLocalId).toBe(message.localId);
    const op = await db.pendingOps.get(opId);
    expect(op?.clientId).toBe("fixed-client-id");
    expect(op?.payload.attachmentId).toBe(attachmentId);
  });

  it("rolls everything back when the op cannot be written", async () => {
    await db.rooms.add({ id: ROOM } as LocalRoom);
    engine.setOnline(false);
    vi.spyOn(db.pendingOps, "add").mockImplementation(() => Dexie.Promise.reject(new Error("QuotaExceededError")) as never);

    await expect(engine.enqueueMediaSend({
      message: { roomId: ROOM, senderId: "me", content: "a.jpg", type: MessageType.image, uploadProgress: 0 },
      attachment: { fileName: "a.jpg", mimeType: "image/jpeg", size: 1, localBlob: new Blob(["a"]) },
      payload: { msgtype: "m.image" },
    })).rejects.toThrow("QuotaExceededError");

    expect(await db.messages.count()).toBe(0);
    expect(await db.attachments.count()).toBe(0);
  });
});

describe("inline uploads without an op", () => {
  it("a GIF created with uploadPhase is not swept while it uploads", async () => {
    await db.rooms.add({ id: ROOM } as LocalRoom);
    const gif = await repo.createLocal({
      roomId: ROOM, senderId: "me", content: "GIF", type: MessageType.image, uploadProgress: 0, uploadPhase: "uploading",
    });
    await db.messages.update(gif.localId!, { timestamp: Date.now() - 5 * 60_000 });

    await watchdogTick();

    expect((await db.messages.get(gif.localId!))?.status).toBe("pending");
  });
});
