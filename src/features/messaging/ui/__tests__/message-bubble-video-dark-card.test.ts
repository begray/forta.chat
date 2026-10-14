import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bubble = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");
const pattern = readFileSync(resolve(__dirname, "../VideoPlaceholderPattern.vue"), "utf-8");

/**
 * A video without a poster used to show a grey box inside a blue bubble
 * (blue edge + blue file-name bar). Plain videos now render as a black card,
 * identical in light and dark themes, with a faint SVG pattern as placeholder.
 */
describe("MessageBubble — dark video card", () => {
  const block = bubble.match(/<!-- Video message -->[\s\S]*?<!-- Audio message/)?.[0] ?? "";

  it("uses a black card for plain videos and keeps the bubble color otherwise", () => {
    expect(bubble).toMatch(/const isVideoCardDark = computed\(\(\) =>\s*!props\.message\.fileInfo\?\.caption && !props\.message\.replyTo && !props\.message\.forwardedFrom/);
    expect(block).toMatch(/isVideoCardDark \? 'bg-black' : props\.isOwn \? 'bg-chat-bubble-own' : 'bg-chat-bubble-other'/);
  });

  it("frame and placeholder states have no grey theme background", () => {
    expect(block).toMatch(/video-bubble-frame relative w-full overflow-hidden bg-black"/);
    expect(block).not.toMatch(/bg-neutral-grad-0/);
  });

  it("shows the pattern only until the file is loaded", () => {
    expect(block).toMatch(/<VideoPlaceholderPattern v-if="!fileState\.objectUrl" \/>/);
  });

  it("footer text and reactions stay readable on black", () => {
    expect(block).toMatch(/props\.isOwn \|\| isVideoCardDark \? 'text-white\/70'/);
    expect(block).toMatch(/:is-own="props\.isOwn \|\| isVideoCardDark"/);
  });
});

describe("VideoPlaceholderPattern", () => {
  it("is static, theme-independent and id-free", () => {
    expect(pattern).toMatch(/text-white/);
    expect(pattern).not.toMatch(/animate-|<animate|\bid="/);
    expect(pattern).toMatch(/pointer-events-none/);
  });
});
