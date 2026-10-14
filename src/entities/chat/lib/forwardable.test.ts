import { describe, it, expect } from "vitest";
import { MessageStatus, MessageType } from "../model/types";
import { isForwardableMessage } from "./forwardable";

const base = { type: MessageType.text, status: MessageStatus.sent };

describe("isForwardableMessage", () => {
  it("allows settled, decrypted messages", () => {
    expect(isForwardableMessage(base)).toBe(true);
    expect(isForwardableMessage({ ...base, status: MessageStatus.delivered })).toBe(true);
    expect(isForwardableMessage({ ...base, status: MessageStatus.read })).toBe(true);
    expect(isForwardableMessage({ ...base, type: MessageType.image })).toBe(true);
    expect(isForwardableMessage({ ...base, type: MessageType.poll })).toBe(true);
  });

  it("rejects messages that are not decrypted", () => {
    expect(isForwardableMessage({ ...base, decryptionStatus: "pending" })).toBe(false);
    expect(isForwardableMessage({ ...base, decryptionStatus: "failed" })).toBe(false);
  });

  it("rejects unsent and deleted messages", () => {
    expect(isForwardableMessage({ ...base, status: MessageStatus.sending })).toBe(false);
    expect(isForwardableMessage({ ...base, status: MessageStatus.failed })).toBe(false);
    expect(isForwardableMessage({ ...base, status: MessageStatus.cancelled })).toBe(false);
    expect(isForwardableMessage({ ...base, uploadProgress: 40 })).toBe(false);
    expect(isForwardableMessage({ ...base, deleted: true })).toBe(false);
  });

  it("rejects call records and system events", () => {
    expect(isForwardableMessage({ ...base, callInfo: { callType: "voice", missed: true } })).toBe(false);
    expect(isForwardableMessage({ ...base, type: MessageType.system })).toBe(false);
  });
});
