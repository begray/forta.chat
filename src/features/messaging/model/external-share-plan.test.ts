import { describe, it, expect, vi } from "vitest";

vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));

import { MessageType, POST_SHARE_ROOM_ID, type FileInfo, type ForwardingMessage } from "@/entities/chat/model/types";
import {
  buildForwardSharePlan,
  buildMessagesSharePlan,
  isSharePlanEmpty,
  messageShareText,
  type ShareSource,
} from "./external-share-plan";

const TXID = "a".repeat(64);
const HEX = "b".repeat(64);

const src = (over: Partial<ShareSource>): ShareSource => ({
  type: MessageType.text,
  content: "",
  roomId: "!room:server",
  senderId: "PSender",
  timestamp: 1,
  ...over,
});

const file = (over: Partial<FileInfo> = {}): FileInfo => ({
  name: "photo.jpg",
  type: "image/jpeg",
  size: 10,
  url: "mxc://server/abc",
  ...over,
});

const fwd = (over: Partial<ForwardingMessage>): ForwardingMessage => ({
  id: "$ev",
  roomId: "!room:server",
  senderId: "PSender",
  content: "",
  type: MessageType.text,
  withSenderInfo: true,
  sourceTimestamp: 5,
  ...over,
});

describe("messageShareText", () => {
  it("turns bastyon:// and pocketnet:// links into https://bastyon.com", () => {
    expect(messageShareText(src({ content: `look bastyon://post?s=${TXID}` })))
      .toBe(`look https://bastyon.com/post?s=${TXID}`);
    expect(messageShareText(src({ content: `pocketnet://index?v=${TXID}` })))
      .toBe(`https://bastyon.com/index?v=${TXID}`);
  });

  it("leaves other links untouched", () => {
    const text = `https://pocketnet.app/post?s=${TXID} https://example.com/x`;
    expect(messageShareText(src({ content: text }))).toBe(text);
  });

  it("strips mention wire syntax down to the display name", () => {
    expect(messageShareText(src({ content: `hi @${HEX}:Alice` }))).toBe("hi @Alice");
  });

  it("renders a poll as plain text", () => {
    const pollInfo = { question: "Lunch?", options: [{ id: "1", text: "Pizza" }, { id: "2", text: "Soup" }], votes: {} };
    expect(messageShareText(src({ type: MessageType.poll, content: "Lunch?", pollInfo })))
      .toBe("Lunch?\n• Pizza\n• Soup");
  });

  it("renders a transfer as its note and https link", () => {
    const transferInfo = { txId: TXID, amount: 1, from: "a", to: "b", message: "for lunch" };
    expect(messageShareText(src({ type: MessageType.transfer, content: "for lunch", transferInfo })))
      .toBe(`for lunch\nhttps://bastyon.com/i?stx=${TXID}`);
  });

  it("renders a call link as label and url", () => {
    const callLinkInfo = { url: "https://zoom.us/j/1", label: "Zoom" };
    expect(messageShareText(src({ type: MessageType.callLink, content: "Zoom", callLinkInfo })))
      .toBe("Zoom\nhttps://zoom.us/j/1");
  });
});

describe("buildMessagesSharePlan", () => {
  it("shares media as files with captions as text, in chronological order", () => {
    const plan = buildMessagesSharePlan([
      src({ type: MessageType.text, content: "second", timestamp: 2 }),
      src({ type: MessageType.image, content: "photo.jpg", fileInfo: file({ caption: "first" }), timestamp: 1 }),
      src({ type: MessageType.video, content: "v.mp4", fileInfo: file({ name: "v.mp4", type: "video/mp4" }), timestamp: 3 }),
    ]);
    expect(plan.text).toBe("first\n\nsecond");
    expect(plan.files.map((f) => f.fileInfo.name)).toEqual(["photo.jpg", "v.mp4"]);
    expect(plan.files[0]).toMatchObject({ roomId: "!room:server", senderId: "PSender", timestamp: 1 });
  });

  it("does not put a media file name into the text", () => {
    const plan = buildMessagesSharePlan([
      src({ type: MessageType.file, content: "report.pdf", fileInfo: file({ name: "report.pdf", type: "application/pdf" }) }),
    ]);
    expect(plan.text).toBeUndefined();
    expect(plan.files).toHaveLength(1);
  });

  it("is empty for blank messages", () => {
    expect(isSharePlanEmpty(buildMessagesSharePlan([src({ content: "  " })]))).toBe(true);
  });
});

describe("buildForwardSharePlan", () => {
  it("shares a feed post as its https link only", () => {
    const plan = buildForwardSharePlan(fwd({
      roomId: POST_SHARE_ROOM_ID,
      senderName: "Author",
      content: `https://bastyon.com/post?s=${TXID}`,
    }));
    expect(plan).toEqual({ url: `https://bastyon.com/post?s=${TXID}`, files: [] });
  });

  it("converts a bastyon:// feed post link", () => {
    const plan = buildForwardSharePlan(fwd({ roomId: POST_SHARE_ROOM_ID, content: `bastyon://post?s=${TXID}` }));
    expect(plan.url).toBe(`https://bastyon.com/post?s=${TXID}`);
    expect(plan.text).toBeUndefined();
  });

  it("shares a forwarded image with the source timestamp for decryption", () => {
    const plan = buildForwardSharePlan(fwd({ type: MessageType.image, fileInfo: file() }));
    expect(plan.files[0]).toMatchObject({ timestamp: 5, senderId: "PSender" });
  });

  it("shares a forwarded poll as text", () => {
    const pollInfo = { question: "Q", options: [{ id: "1", text: "A" }], votes: {} };
    expect(buildForwardSharePlan(fwd({ type: MessageType.poll, content: "Q", pollInfo })).text).toBe("Q\n• A");
  });
});
