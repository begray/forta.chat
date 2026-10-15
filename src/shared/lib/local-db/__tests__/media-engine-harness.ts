/**
 * Shared harness for SyncEngine send_file tests: a real Dexie (fake-indexeddb)
 * with the production tables the media path touches, and stub repositories.
 * Callers mock `@/entities/matrix` themselves (vi.mock is hoisted per file).
 */
import { vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";

export class MediaTestDb extends Dexie {
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

export interface MediaHarness {
  db: MediaTestDb;
  engine: SyncEngine;
  messageRepo: {
    confirmSent: ReturnType<typeof vi.fn>;
    confirmMediaSent: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    getByEventId: ReturnType<typeof vi.fn>;
    getByClientId: ReturnType<typeof vi.fn>;
    updateUploadProgress: ReturnType<typeof vi.fn>;
    failOrphanedMedia: ReturnType<typeof vi.fn>;
  };
  roomRepo: { updateRoom: ReturnType<typeof vi.fn>; syncLastMessageLocalStatus: ReturnType<typeof vi.fn> };
}

/** Engine over a fresh DB. The message repo reads and writes the real
 *  `messages` table, so a test can check what the bubble would show. */
export function makeMediaHarness(name: string): MediaHarness {
  const db = new MediaTestDb(name);
  const byClientId = (clientId: string) => db.messages.where("clientId").equals(clientId).first();
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    confirmMediaSent: vi.fn(async (clientId: string, eventId: string) => {
      await db.messages.where("clientId").equals(clientId).modify({ status: "synced", eventId });
    }),
    updateStatus: vi.fn(async ({ clientId }: { clientId: string }, status: LocalMessage["status"]) => {
      await db.messages.where("clientId").equals(clientId).modify({ status });
    }),
    getByEventId: vi.fn(async () => undefined),
    getByClientId: vi.fn(async (clientId: string) => byClientId(clientId)),
    updateUploadProgress: vi.fn(async () => undefined),
    failOrphanedMedia: vi.fn(async () => []),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  const engine = new SyncEngine(db as never, messageRepo as never, roomRepo as never, (async () => undefined) as never);
  return { db, engine, messageRepo, roomRepo };
}

const ROOM = "!room:server";

/** A pending media bubble + its file + its send_file op. `size` goes into the
 *  op payload as enqueueMediaSend writes it (omit it for a legacy op). */
export async function seedMediaSend(
  db: MediaTestDb,
  opts: { clientId: string; size?: number; retries?: number; roomId?: string; createdAt?: number },
): Promise<number> {
  const roomId = opts.roomId ?? ROOM;
  const localId = (await db.messages.add({
    clientId: opts.clientId,
    roomId,
    senderId: "@me:server",
    content: "",
    timestamp: Date.now(),
    type: "file",
    status: "pending",
    uploadProgress: 0,
  } as unknown as LocalMessage)) as number;
  const attachmentId = (await db.attachments.add({
    messageLocalId: localId,
    fileName: "video.mp4",
    mimeType: "video/mp4",
    size: 300,
    localBlob: new Blob(["x".repeat(300)], { type: "video/mp4" }),
    status: "local",
  } as LocalAttachment)) as number;
  return (await db.pendingOps.add({
    type: "send_file",
    roomId,
    payload: {
      fileName: "video.mp4",
      mimeType: "video/mp4",
      msgtype: "m.file",
      attachmentId,
      ...(opts.size !== undefined ? { size: opts.size } : {}),
    },
    status: "pending",
    retries: opts.retries ?? 0,
    maxRetries: 5,
    createdAt: opts.createdAt ?? Date.now(),
    clientId: opts.clientId,
    nextAttemptAt: 0,
  } as PendingOperation)) as number;
}

/** A queued text in the same room (FIFO must hold for it). */
export async function seedTextSend(db: MediaTestDb, clientId: string, roomId = ROOM): Promise<number> {
  await db.messages.add({
    clientId,
    roomId,
    senderId: "@me:server",
    content: "hi",
    timestamp: Date.now(),
    type: "text",
    status: "pending",
  } as unknown as LocalMessage);
  return (await db.pendingOps.add({
    type: "send_message",
    roomId,
    payload: { content: "hi" },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId,
    nextAttemptAt: 0,
  } as PendingOperation)) as number;
}

/** Poll `check` until it holds (real timers). */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

/** An upload that hangs until aborted (then rejects like the XHR) or until
 *  the test settles it. */
export function controllableUpload() {
  let resolveFn: (url: string) => void = () => {};
  let rejectFn: (e: unknown) => void = () => {};
  let signal: AbortSignal | undefined;
  let progress: ((p: { loaded: number; total: number }) => void) | undefined;
  const impl = (_blob: Blob, onProgress?: (p: { loaded: number; total: number }) => void, s?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      signal = s;
      progress = onProgress;
      resolveFn = resolve;
      rejectFn = reject;
      s?.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")), { once: true });
    });
  return {
    impl,
    resolve: (url = "mxc://server/ok") => resolveFn(url),
    reject: (e: unknown) => rejectFn(e),
    get signal() {
      return signal;
    },
    get progress() {
      return progress;
    },
  };
}
