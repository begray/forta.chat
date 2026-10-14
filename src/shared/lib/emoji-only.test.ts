import { describe, it, expect } from "vitest";
import { countEmojiOnly, isJumboEmoji } from "./emoji-only";

describe("countEmojiOnly", () => {
  it("counts plain emoji", () => {
    expect(countEmojiOnly("😀")).toBe(1);
    expect(countEmojiOnly("😀😂🥰")).toBe(3);
    expect(countEmojiOnly(" 👍 ❤️ ")).toBe(2);
  });

  it("treats compound emoji as one", () => {
    expect(countEmojiOnly("👍🏽")).toBe(1); // skin tone
    expect(countEmojiOnly("👨‍👩‍👧‍👦")).toBe(1); // ZWJ family
    expect(countEmojiOnly("🇷🇺")).toBe(1); // flag
    expect(countEmojiOnly("1️⃣")).toBe(1); // keycap
    expect(countEmojiOnly("🏴󠁧󠁢󠁥󠁮󠁧󠁿")).toBe(1); // tag sequence
    expect(countEmojiOnly("❤️‍🔥")).toBe(1);
  });

  it("returns 0 when any non-emoji text is present", () => {
    expect(countEmojiOnly("hi 😀")).toBe(0);
    expect(countEmojiOnly("😀!")).toBe(0);
    expect(countEmojiOnly("123")).toBe(0);
    expect(countEmojiOnly("привет")).toBe(0);
    expect(countEmojiOnly("")).toBe(0);
    expect(countEmojiOnly("   ")).toBe(0);
    expect(countEmojiOnly(null)).toBe(0);
  });
});

describe("isJumboEmoji", () => {
  it("accepts 1..6 emoji", () => {
    expect(isJumboEmoji("😀")).toBe(true);
    expect(isJumboEmoji("😀😀😀😀😀😀")).toBe(true);
  });

  it("rejects 7+ emoji and mixed text", () => {
    expect(isJumboEmoji("😀😀😀😀😀😀😀")).toBe(false);
    expect(isJumboEmoji("ok 😀")).toBe(false);
  });
});
