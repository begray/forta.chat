import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * "Forward" is offered only for settled, decrypted messages — the rule lives
 * in isForwardableMessage (forwardable.test.ts); these checks guard that every
 * forward entry point applies it.
 */
const read = (path: string) => readFileSync(resolve(__dirname, "../../../../", path), "utf-8");

describe("forward entry points use isForwardableMessage", () => {
  it("message context menu adds Forward only for forwardable messages", () => {
    const src = read("features/messaging/ui/MessageContextMenu.vue");
    expect(src).toMatch(/if \(props\.message && isForwardableMessage\(props\.message\)\) \{\s*items\.push\(\{ label: t\("contextMenu\.forward"\)/);
  });

  it("chat info gallery adds Forward only for forwardable messages", () => {
    const src = read("features/chat-info/ui/ChatInfoGallery.vue");
    expect(src).toMatch(/isForwardableMessage\(ctxMessage\.value\)\) \{\s*items\.push\(\{ label: t\("chatInfo\.forward"\)/);
  });

  it("bulk forward leaves out unforwardable selected messages", () => {
    const src = read("widgets/chat-window/ChatWindow.vue");
    const fnStart = src.indexOf("const handleSelectionForward");
    const fn = src.slice(fnStart, src.indexOf("\n};", fnStart));
    expect(fn).toContain("isForwardableMessage(m)");
  });
});
