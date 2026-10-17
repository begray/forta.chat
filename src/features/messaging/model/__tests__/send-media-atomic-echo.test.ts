// @vitest-environment happy-dom
/**
 * Stuck-photo regression (field report: of 3 photos sent together, one stayed
 * "sending" forever with a broken preview and no Retry).
 *
 * sendImage/sendFile wrote the bubble, the persisted file copy and the
 * send_file op as three separate awaits. When the picked file could not be
 * read (cloud photo, expired picker grant), the file copy failed AFTER the
 * bubble was committed: a pending bubble with no file and no op, which nothing
 * ever completed or failed, and MessageInput's Promise.allSettled swallowed
 * the error.
 *
 * Runs the real send path against a real MessageRepository + SyncEngine on
 * fake-indexeddb: either all three rows exist, or none does and the error is
 * shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { setActivePinia, createPinia } from "pinia";
import { MessageRepository } from "@/shared/lib/local-db/message-repository";
import { SyncEngine } from "@/shared/lib/local-db/sync-engine";
import type { LocalAttachment, LocalMessage, LocalRoom, PendingOperation } from "@/shared/lib/local-db/schema";
import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";

const h = vi.hoisted(() => ({
  kit: null as unknown,
  reportSendError: vi.fn(),
}));

vi.mock("@/shared/lib/local-db", () => ({
  isChatDbReady: () => true,
  getChatDb: () => h.kit,
}));

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({
    isReady: () => true,
    uploadContent: vi.fn(() => new Promise(() => {})),
    sendEncryptedText: vi.fn(),
    setTyping: vi.fn(),
  }),
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "0xme", pcrypto: { rooms: {} } }),
}));

vi.mock("@/entities/chat", async () => {
  const actual = await vi.importActual<typeof import("@/entities/chat")>("@/entities/chat");
  return {
    ...actual,
    useChatStore: () => ({ activeRoomId: "!room:server", messages: {} }),
  };
});

vi.mock("@/shared/lib/upload-image", () => ({ optimizeChatImage: async (f: File) => f }));
vi.mock("@/features/bug-report", () => ({ useBugReport: () => ({ open: vi.fn() }) }));
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/shared/lib/connectivity", () => ({ useConnectivity: () => ({ isOnline: { value: true } }) }));
vi.mock("../send-error-bus", () => ({ reportSendError: h.reportSendError }));

import { useMessages } from "../use-messages";
import { sendBatch } from "../send-batch";

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<LocalAttachment, number>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    // Indexes mirror the production schema (schema.ts).
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
    });
  }
}

/** A picked File whose bytes cannot be read, like a cloud photo the
 *  provider fails to fetch. */
function unreadableFile(name: string): File {
  const file = new File(["xxxx"], name, { type: "image/jpeg" });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
  });
  return file;
}

let db: TestDb;
let engine: SyncEngine;
let dbIndex = 0;

beforeEach(async () => {
  setActivePinia(createPinia());
  localStorage.clear();
  resetUploadLogForTests();
  h.reportSendError.mockReset();
  class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 640;
    naturalHeight = 480;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    get src(): string { return "blob:stub"; }
  }
  vi.stubGlobal("Image", StubImage);
  URL.createObjectURL = vi.fn(() => `blob:stub-${Math.random()}`);
  URL.revokeObjectURL = vi.fn();

  db = new TestDb(`atomic-echo-${dbIndex++}`);
  await db.rooms.add({ id: "!room:server" } as LocalRoom);
  const messages = new MessageRepository(db as never);
  const roomRepo = { syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  engine = new SyncEngine(db as never, messages, roomRepo as never, async () => undefined);
  // Keep the queue parked: this test is about what the send writes.
  engine.setOnline(false);
  h.kit = { messages, syncEngine: engine, db, rooms: roomRepo, eventWriter: {} };
});

afterEach(async () => {
  engine.dispose();
  vi.unstubAllGlobals();
  db.close();
  await db.delete();
});

async function counts() {
  return {
    messages: await db.messages.count(),
    attachments: await db.attachments.count(),
    ops: await db.pendingOps.count(),
  };
}

describe("media local echo is all-or-nothing", () => {
  it("a file copy that cannot be stored leaves no bubble behind and reports the error", async () => {
    vi.spyOn(db.attachments, "add").mockImplementation(() =>
      Dexie.Promise.reject(new DOMException("Error preparing Blob/File data to be stored", "UnknownError")) as never,
    );
    const { sendImage } = useMessages();

    const sent = await sendImage(new File(["jpeg"], "bb4dde02-1234-4abc-9def-0123456789ab.jpg", { type: "image/jpeg" }));

    expect(sent).toBe(false);
    expect(await counts()).toEqual({ messages: 0, attachments: 0, ops: 0 });
    expect(h.reportSendError).toHaveBeenCalledTimes(1);
    expect(h.reportSendError.mock.calls[0][0].kind).toBe("fileUnreadable");
    expect(getUploadLog().map((e) => e.e)).toContain("echo:fail");
  });

  it("an unreadable picked file is rejected before any bubble appears", async () => {
    const { sendImage } = useMessages();

    const sent = await sendImage(unreadableFile("cloud-photo.jpg"));

    expect(sent).toBe(false);
    expect(await counts()).toEqual({ messages: 0, attachments: 0, ops: 0 });
    expect(h.reportSendError.mock.calls[0][0].kind).toBe("fileUnreadable");
    const failed = getUploadLog().find((e) => e.e === "read:fail");
    expect(failed?.d?.err).toContain("NotReadableError");
  });

  it("three photos with one unreadable: two complete sends, one visible error, no orphan", async () => {
    const { sendImage } = useMessages();
    const files = [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
      unreadableFile("bb4dde02-1234-4abc-9def-0123456789ab.jpg"),
      new File(["c"], "c.jpg", { type: "image/jpeg" }),
    ];

    await sendBatch(files, (f) => sendImage(f), (f) => f.name);

    expect(await counts()).toEqual({ messages: 2, attachments: 2, ops: 2 });
    expect(h.reportSendError).toHaveBeenCalledTimes(1);
    // Every bubble has its file copy and its op.
    for (const msg of await db.messages.toArray()) {
      const op = await db.pendingOps.where("clientId").equals(msg.clientId).first();
      expect(op?.type).toBe("send_file");
      const attachment = await db.attachments.get(op!.payload.attachmentId as number);
      expect(attachment?.messageLocalId).toBe(msg.localId);
      expect(attachment?.localBlob).toBeTruthy();
    }
  });

  it("a send that throws is surfaced by sendBatch instead of vanishing", async () => {
    await sendBatch(["x.jpg"], () => Promise.reject(new Error("boom")), (name) => name);
    expect(h.reportSendError).toHaveBeenCalledTimes(1);
    expect(getUploadLog().find((e) => e.e === "send:rejected")?.d?.err).toBe("boom");
  });

  it("a successful send logs its steps under one clientId", async () => {
    const { sendFile } = useMessages();

    expect(await sendFile(new File(["pdf"], "doc.pdf", { type: "application/pdf" }))).toBe(true);

    const [msg] = await db.messages.toArray();
    const events = getUploadLog().filter((e) => e.c === msg.clientId.slice(0, 8)).map((e) => e.e);
    expect(events).toEqual(["send:start", "read:ok", "echo:ok"]);
  });
});
