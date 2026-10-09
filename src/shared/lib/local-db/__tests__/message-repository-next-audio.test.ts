import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

/** The voice player's auto-advance reads the next voice from Dexie by cursor
 *  (voice-queue.ts), so the chain also works with the chat closed and sees
 *  voices that arrived while the current one was playing. */

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

  constructor() {
    super("TestDb_next_audio", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      listenedMessages: "messageId",
    });
  }
}

const ROOM = "!room:server";
const ME = "me";

function voice(eventId: string, timestamp: number, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId,
    clientId: `cli_${eventId}`,
    roomId: ROOM,
    senderId: "peer",
    content: "",
    timestamp,
    type: MessageType.audio,
    status: "synced",
    version: 1,
    softDeleted: false,
    fileInfo: { name: "v.ogg", type: "audio/ogg", size: 1, url: `mxc://s/${eventId}` },
    ...overrides,
  } as LocalMessage;
}

describe("MessageRepository.getNextAudioAfter", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  const next = (timestamp: number, id: string, opts = {}) =>
    repo.getNextAudioAfter(ROOM, { timestamp, id }, { excludeSenderId: ME, ...opts });

  it("returns the next voice of the same room, skipping text and other rooms", async () => {
    await db.messages.bulkAdd([
      voice("$cur", 100),
      voice("$other_room", 150, { roomId: "!other:server" }),
      voice("$text", 160, { type: MessageType.text, fileInfo: undefined }),
      voice("$next", 200),
      voice("$later", 300),
    ]);
    expect((await next(100, "$cur"))?.eventId).toBe("$next");
  });

  it("skips listened, deleted, own and file-less voices", async () => {
    await db.messages.bulkAdd([
      voice("$cur", 100),
      voice("$listened", 110),
      voice("$deleted", 120, { deleted: true }),
      voice("$soft", 130, { softDeleted: true }),
      voice("$mine", 140, { senderId: ME }),
      voice("$nofile", 150, { fileInfo: undefined }),
      voice("$target", 160),
    ]);
    await db.listenedMessages.put({ messageId: "$listened" });
    expect((await next(100, "$cur"))?.eventId).toBe("$target");
  });

  it("orders voices sharing the cursor's timestamp by timeline id instead of dropping them", async () => {
    await db.messages.bulkAdd([
      voice("$a", 100),
      voice("$b", 100),
      voice("$c", 100),
    ]);
    expect((await next(100, "$a"))?.eventId).toBe("$b");
    expect((await next(100, "$b"))?.eventId).toBe("$c");
    expect(await next(100, "$c")).toBeUndefined();
  });

  it("sees a voice that arrived after playback started", async () => {
    await db.messages.add(voice("$cur", 100));
    expect(await next(100, "$cur")).toBeUndefined();
    await db.messages.add(voice("$fresh", 500));
    expect((await next(100, "$cur"))?.eventId).toBe("$fresh");
  });

  it("ignores messages before the clear-history cutoff", async () => {
    await db.messages.bulkAdd([voice("$old", 150), voice("$new", 250)]);
    expect((await next(100, "$cur", { clearedAtTs: 200 }))?.eventId).toBe("$new");
  });

  it("stops after scanLimit rows so a long text tail stays cheap", async () => {
    const rows = [voice("$cur", 100)];
    for (let i = 0; i < 10; i++) {
      rows.push(voice(`$t${i}`, 101 + i, { type: MessageType.text, fileInfo: undefined }));
    }
    rows.push(voice("$far", 500));
    await db.messages.bulkAdd(rows);
    expect(await next(100, "$cur", { scanLimit: 5 })).toBeUndefined();
    expect((await next(100, "$cur"))?.eventId).toBe("$far");
  });
});
