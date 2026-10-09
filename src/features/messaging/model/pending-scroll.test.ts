import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pendingScroll, requestScrollToMessage, takePendingScroll } from "./pending-scroll";

describe("pending-scroll", () => {
  beforeEach(() => {
    requestScrollToMessage("!x:s", "$x");
    takePendingScroll("!x:s");
  });

  it("hands the target only to its own room, once", () => {
    requestScrollToMessage("!a:s", "$m");
    expect(takePendingScroll("!b:s")).toBeNull();
    expect(takePendingScroll(null)).toBeNull();
    expect(pendingScroll.value).toEqual({ roomId: "!a:s", messageId: "$m" });

    expect(takePendingScroll("!a:s")).toBe("$m");
    expect(takePendingScroll("!a:s")).toBeNull();
    expect(pendingScroll.value).toBeNull();
  });

  it("a newer request replaces the older one", () => {
    requestScrollToMessage("!a:s", "$1");
    requestScrollToMessage("!b:s", "$2");
    expect(takePendingScroll("!a:s")).toBeNull();
    expect(takePendingScroll("!b:s")).toBe("$2");
  });
});

describe("MessageList wiring", () => {
  // Mounting MessageList pulls in the whole chat surface, so the consumer is
  // asserted at source level, like the chat-switch wiring in
  // file-url-cache-lifetime.test.ts.
  const source = readFileSync(resolve(__dirname, "../ui/MessageList.vue"), "utf-8");

  it("takes the pending target only once the open room has settled, then scrolls to it", () => {
    expect(source).toMatch(/import \{ pendingScroll, takePendingScroll \} from "\.\.\/model\/pending-scroll"/);
    expect(source).toMatch(
      /watch\(\s*\[pendingScroll, settled, switching,[\s\S]{0,400}?if \(!settled\.value \|\| switching\.value\) return;[\s\S]{0,300}?takePendingScroll\(chatStore\.activeRoomId\)[\s\S]{0,120}?scrollToMessage\(messageId\)/,
    );
  });
});
