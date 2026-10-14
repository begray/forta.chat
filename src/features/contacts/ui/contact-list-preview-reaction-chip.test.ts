import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "ContactList.vue"), "utf-8");

/**
 * The last-message reaction sits right before the preview text; when that
 * text is itself emoji, a bare reaction emoji merged into it ("❤️❤️❤️❤️").
 * It renders as a chip with a background so the two stay distinct.
 */
describe("ContactList — preview reaction chip", () => {
  it("renders the reaction emoji inside a backed chip", () => {
    const chip = source.match(/<span v-if="\(item as ChatRoom\)\.lastMessageReaction"[^>]*>/)?.[0] ?? "";
    expect(chip).toMatch(/rounded-full/);
    expect(chip).toMatch(/bg-neutral-grad-0/);
    expect(chip).toMatch(/data-testid="preview-reaction-chip"/);
  });
});
