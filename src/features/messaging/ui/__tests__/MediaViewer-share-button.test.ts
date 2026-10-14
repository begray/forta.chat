import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * "Share" in the gallery: the photo / video on screen goes to other apps via
 * the system share sheet (native only). Source-level, like
 * MediaViewer-save-button.test.ts — the share pipeline itself is covered by
 * use-external-share.test.ts.
 */
const source = readFileSync(resolve(__dirname, "../MediaViewer.vue"), "utf-8");

describe("MediaViewer — share button", () => {
  const start = source.indexOf('data-testid="media-share"');
  const button = source.slice(source.lastIndexOf("<button", start), source.indexOf("</button>", start));

  it("renders only where a system share sheet exists", () => {
    expect(start).toBeGreaterThan(-1);
    expect(button).toContain('v-if="canShareExternally"');
  });

  it("is disabled until the media is decrypted and while a share runs", () => {
    expect(button).toMatch(/:disabled="!currentUrl \|\| isSharing"/);
  });

  it("shares the decrypted on-screen file with its caption", () => {
    const fnStart = source.indexOf("const handleShareCurrent");
    const fn = source.slice(fnStart, source.indexOf("\n};", fnStart));
    expect(fn).toContain("objectUrl: url");
    expect(fn).toContain("caption");
    expect(button).toContain('@click="handleShareCurrent"');
  });
});
