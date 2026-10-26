import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level guard: the composer's Send hands a shared item to
 * sendShareFromComposer, which takes the share off the composer before the
 * first slow step (a second tap used to send the whole share again, field
 * log 2026-10-26). The behaviour is tested in share-send.test.ts.
 */
const source = () => readFileSync(resolve(__dirname, "../MessageInput.vue"), "utf-8");

describe("MessageInput: external share send", () => {
  it("sends a share through sendShareFromComposer, which clears the composer's share", () => {
    const s = source();
    const start = s.indexOf("if (fwd.isExternalShare && fwd.fileInfo?.url)");
    expect(start).toBeGreaterThan(-1);
    const branch = s.slice(start, start + 800);
    expect(branch).toContain("sendShareFromComposer(");
    expect(branch).toMatch(/clear:\s*\(\)\s*=>\s*chatStore\.cancelForward\(\)/);
  });

  it("no longer sends shared files one by one with the share left on the composer", () => {
    expect(source()).not.toContain("sendExternalShareFiles");
  });
});
