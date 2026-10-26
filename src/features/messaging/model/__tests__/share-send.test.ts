// @vitest-environment happy-dom
/**
 * Media shared into the app (share-send.ts): one share is sent once, through
 * the batch pipeline, with the share plugin's copies read natively.
 *
 * Field log 2026-10-26: 11 shared items, 22 sends. The composer kept the
 * share and an enabled Send until the last file was through, and the first
 * bubble took ~5 s (image preparation), so a second tap ~3 s later sent the
 * whole share again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/entities/matrix", () => ({ getMatrixClientService: () => ({}) }));

import type { FileInfo, ForwardingMessage } from "@/entities/chat/model/types";
import { MessageType } from "@/entities/chat/model/types";
import { getUploadLog, resetUploadLogForTests } from "@/shared/lib/upload-log/upload-log";
import { __resetShareIdentityForTests, acceptShare, shareKeyOf } from "@/shared/lib/share-target";
import { __resetSendErrorBusForTests, useSendErrorBus } from "../send-error-bus";
import { setMediaBatchDepsForTests, type BatchSendContext } from "../media-batch";
import type { BatchRow } from "../media-batch-model";
import { fileSourceOf, releaseFileSource } from "../picked-media";
import { sendShareFromComposer, setShareSendDepsForTests, type ShareComposer, type ShareSenders } from "../share-send";

const ROOM = "!family:server";
const DIR = "/data/user/0/com.forta.chat/cache/shared_files";

interface Sent {
  file: File;
  opts: { caption?: string } & BatchSendContext;
  resolve: (ok: boolean) => void;
}

let sends: Sent[];
let rows: Map<string, BatchRow>;
let sizes: Map<string, number>;
let deleted: string[];
let ids: number;

function hangingSend(file: File, opts: Sent["opts"]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    sends.push({
      file,
      opts,
      resolve: (ok) => {
        const id = opts.clientId;
        if (ok && id) rows.set(id, { clientId: id, status: "pending", uploadProgress: 0 });
        resolve(ok);
      },
    });
  });
}

const senders = (): ShareSenders & { sendText: ReturnType<typeof vi.fn> } => ({
  sendImage: (f, o) => hangingSend(f, o),
  sendFile: (f, o) => hangingSend(f, o),
  sendText: vi.fn(async () => true),
});

function info(name: string, type = "image/jpeg", url = `${DIR}/${name}`): FileInfo {
  return { url, name, type, size: 0 };
}

function share(files: FileInfo[], key?: string): ForwardingMessage {
  return {
    id: "__external_share_1",
    roomId: "__external_share__",
    senderId: "",
    content: files[0]?.name ?? "",
    type: MessageType.image,
    fileInfo: files[0],
    externalFiles: files,
    withSenderInfo: false,
    isExternalShare: true,
    shareKey: key,
  };
}

/** The composer as chatStore holds it: `clear` drops the share. */
function composerWith(fwd: ForwardingMessage): ShareComposer & { clear: ReturnType<typeof vi.fn> } {
  let current: ForwardingMessage | null = fwd;
  return { current: () => current, clear: vi.fn(() => { current = null; }) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const sentNames = () => sends.map((s) => s.file.name);

/** Finish every send so far: bubble written, then synced. */
async function finishAll(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const open = sends.filter((s) => !rows.has(s.opts.clientId ?? ""));
    for (const s of open) s.resolve(true);
    for (const [id, r] of rows) rows.set(id, { ...r, status: "synced" });
    await settle();
  }
}

beforeEach(() => {
  sends = [];
  rows = new Map();
  sizes = new Map();
  deleted = [];
  ids = 0;
  resetUploadLogForTests();
  __resetSendErrorBusForTests();
  __resetShareIdentityForTests();
  setMediaBatchDepsForTests({
    snapshot: async (f) => f,
    readRows: async (wanted) => wanted.map((id) => rows.get(id)).filter((r): r is BatchRow => !!r),
    cancelUpload: async () => {},
    retryUpload: async () => {},
    currentRoomId: () => ROOM,
    newId: () => `c${++ids}`,
    thumbUrlFor: () => undefined,
    pollMs: 5,
    lingerMs: 50,
  });
  setShareSendDepsForTests({
    native: () => true,
    statPath: async (path) => {
      const size = sizes.get(path);
      if (size === undefined) throw new Error("ENOENT");
      return size;
    },
    deletePath: async (path) => { deleted.push(path); },
    webUrl: (uri) => `https://localhost/_capacitor_file_${uri.replace(/^\w+:\/\//, "")}`,
    readBlob: async () => { throw new Error("not readable"); },
  });
});

afterEach(() => {
  setMediaBatchDepsForTests(null);
  setShareSendDepsForTests(null);
});

function seed(files: FileInfo[]): void {
  files.forEach((f, i) => sizes.set(f.url, 1000 + i));
}

describe("sendShareFromComposer: one share is sent once", () => {
  it("a second tap on Send while the first file is still preparing sends nothing again", async () => {
    const files = [info("a.jpg"), info("b.jpg"), info("c.jpg"), info("v.mp4", "video/mp4")];
    seed(files);
    const composer = composerWith(share(files));
    const s = senders();

    const first = sendShareFromComposer(composer, "", s);
    await settle();
    // First item still preparing (no bubble yet): the user taps Send again.
    const second = await sendShareFromComposer(composer, "", s);

    expect(second).toBeUndefined();
    expect(await first).toBe(true);
    await finishAll();
    expect(sentNames().sort()).toEqual(["a.jpg", "b.jpg", "c.jpg", "v.mp4"]);
    // Off the composer before anything slow ran.
    expect(composer.clear).toHaveBeenCalledTimes(1);
  });

  it("the same share delivered again and sent again (a restored draft) is not sent twice", async () => {
    const files = [info("a.jpg"), info("b.jpg")];
    seed(files);
    const fwd = share(files, "intent-1");
    // A composer that keeps the share, like a forward draft restored on a
    // room switch: the claim alone must stop the second send.
    const sticky: ShareComposer = { current: () => fwd, clear: () => {} };
    const s = senders();

    const first = sendShareFromComposer(sticky, "", s);
    await settle();
    expect(await sendShareFromComposer(sticky, "", s)).toBeUndefined();
    await first;
    await finishAll();
    expect(await sendShareFromComposer(sticky, "", s)).toBeUndefined();
    await finishAll();

    expect(sentNames()).toEqual(["a.jpg", "b.jpg"]);
    expect(getUploadLog().filter((e) => e.e === "share:dup")).toHaveLength(2);
    // And the intent arriving again right after is a repeat.
    expect(acceptShare("intent-1")).toBe(false);
  });
});

describe("sendShareFromComposer: the batch pipeline", () => {
  it("queues the files as one batch, at most two at once, with batch and pick:share log lines", async () => {
    const files = [info("a.jpg"), info("b.jpg"), info("c.jpg")];
    seed(files);
    const s = senders();
    await sendShareFromComposer(composerWith(share(files)), "", s);
    await settle();

    expect(sentNames()).toEqual(["a.jpg", "b.jpg"]);
    await finishAll();
    expect(sentNames()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);

    const log = getUploadLog();
    expect(log.find((e) => e.e === "pick:share")?.d).toMatchObject({ n: 3, src: "share", native: 3, memory: 0, unreadable: 0 });
    expect(log.find((e) => e.e === "batch:start")?.d).toMatchObject({ n: 3 });
    expect(log.find((e) => e.e === "batch:done")?.d).toMatchObject({ ok: 3, fail: 0, n: 3 });
  });

  it("reads the plugin's copies natively: sourced Files with an encoded file:// URI", async () => {
    const odd = info("IMG 1#a.mp4", "video/mp4");
    sizes.set(odd.url, 54_051_851);
    void sendShareFromComposer(composerWith(share([odd])), "", senders());
    await settle();

    const file = sends[0].file;
    expect(file.size).toBe(54_051_851);
    expect(fileSourceOf(file)).toMatchObject({
      kind: "share",
      uri: `file://${DIR}/IMG%201%23a.mp4`,
    });
  });

  it("puts the caption on the last photo or video, like a gallery pick", async () => {
    const files = [info("a.jpg"), info("v.mp4", "video/mp4")];
    seed(files);
    const s = senders();
    await sendShareFromComposer(composerWith(share(files)), "  look  ", s);
    await finishAll();
    expect(sends.map((x) => x.opts.caption)).toEqual([undefined, "look"]);
    expect(s.sendText).not.toHaveBeenCalled();
  });

  it("sends the caption as its own message after a share with other files", async () => {
    const files = [info("a.jpg"), info("doc.pdf", "application/pdf")];
    seed(files);
    const s = senders();
    await sendShareFromComposer(composerWith(share(files)), "notes", s);
    await finishAll();
    expect(sends.map((x) => x.opts.caption)).toEqual([undefined, undefined]);
    expect(s.sendText).toHaveBeenCalledWith("notes");
  });

  it("a single photo is sent at once with its caption inline", async () => {
    const files = [info("a.jpg")];
    seed(files);
    const s = senders();
    const done = sendShareFromComposer(composerWith(share(files)), "hi", s);
    await settle();
    sends[0].resolve(true);
    expect(await done).toBe(true);
    expect(sends[0].opts.caption).toBe("hi");
  });

  it("reports what could not be read and sends the rest", async () => {
    const files = [info("a.jpg"), info("gone.jpg", "image/jpeg", "content://media/external/1"), info("b.jpg")];
    sizes.set(files[0].url, 10);
    sizes.set(files[2].url, 10);
    await sendShareFromComposer(composerWith(share(files)), "", senders());
    await finishAll();

    expect(sentNames()).toEqual(["a.jpg", "b.jpg"]);
    expect(useSendErrorBus().error.value).toMatchObject({ kind: "batchIncomplete", context: { totalCount: 3, failedCount: 1 } });
    expect(getUploadLog().find((e) => e.e === "pick:share")?.d).toMatchObject({ native: 2, unreadable: 1 });
  });

  it("falls back to reading into memory where the native read fails", async () => {
    setShareSendDepsForTests({
      native: () => false,
      readBlob: async () => new Blob(["bytes"], { type: "image/png" }),
    });
    void sendShareFromComposer(composerWith(share([info("w.png", "image/png", "https://x/w.png")])), "", senders());
    await settle();
    expect(fileSourceOf(sends[0].file)).toBeUndefined();
    expect(sends[0].file.size).toBe(5);
  });

  it("nothing readable: resolves false, and the same share may be shared again", async () => {
    const files = [info("gone.jpg")];
    const fwd = share(files);
    expect(await sendShareFromComposer(composerWith(fwd), "", senders())).toBe(false);
    expect(sends).toHaveLength(0);
    const key = shareKeyOf({ files: [{ uri: files[0].url, name: "gone.jpg", mimeType: "image/jpeg" }] });
    expect(acceptShare(key)).toBe(true);
  });

  it("deletes the plugin's copy once no send holds it (the same photo shared twice)", async () => {
    const one = info("a.jpg");
    sizes.set(one.url, 10);
    void sendShareFromComposer(composerWith(share([one], "k1")), "", senders());
    void sendShareFromComposer(composerWith(share([one], "k2")), "", senders());
    await settle();
    expect(sends).toHaveLength(2);

    await releaseFileSource(sends[0].file);
    expect(deleted).toEqual([]);
    await releaseFileSource(sends[1].file);
    expect(deleted).toEqual([one.url]);
  });
});
