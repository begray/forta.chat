import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bubble = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

/**
 * A text message of only 1..6 emoji renders large with no bubble background.
 * Source-level, matching the MessageBubble test style.
 */
describe("MessageBubble — jumbo emoji", () => {
  const textBlock = bubble.match(/<!-- Text message \(default\) -->[\s\S]*?<!-- Failed text message/)?.[0] ?? "";

  it("detects emoji-only text messages via the shared helper, capped at JUMBO_EMOJI_MAX", () => {
    expect(bubble).toMatch(/countEmojiOnly\(m\.content\)/);
    expect(bubble).toMatch(/n <= JUMBO_EMOJI_MAX/);
    expect(bubble).toMatch(/m\.type !== MessageType\.text/);
  });

  it("keeps the bubble for replies and forwards", () => {
    expect(bubble).toMatch(/m\.replyTo \|\| m\.forwardedFrom\) return 0/);
  });

  it("drops the bubble background in jumbo mode", () => {
    const classBinding = textBlock.match(/:class="jumboEmojiCount[\s\S]*?"\r?\n/)?.[0] ?? "";
    const [jumboBranch, normalBranch] = classBinding.split(/\r?\n\s*:\s/);
    expect(jumboBranch).not.toMatch(/bg-chat-bubble/);
    expect(normalBranch).toMatch(/bg-chat-bubble-own/);
  });

  it("renders the emoji with the large size class instead of MessageContent", () => {
    expect(textBlock).toMatch(/v-if="jumboEmojiCount" data-testid="jumbo-emoji"[\s\S]*?jumboEmojiSizeClass/);
    expect(textBlock).toMatch(/<div v-else class="text-chat-base">\s*<MessageContent/);
  });
});

describe("MessageBubble — jumbo emoji reactions", () => {
  it("wraps reactions in a bubble-colored backing so own chips stay visible", () => {
    const block = bubble.match(/data-testid="jumbo-emoji-reactions"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(block).toMatch(/'bg-chat-bubble-own'/);
    expect(bubble).toMatch(/v-if="jumboEmojiCount && message\.reactions && Object\.keys\(message\.reactions\)\.length"\s*data-testid="jumbo-emoji-reactions"/);
    expect(block).toMatch(/'bg-chat-bubble-other'/);
    expect(block).toMatch(/<ReactionRow /);
  });
});
