import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Chat video bubble size (2026-10-14): videos get a bigger bubble than
 * images — 97% of the chat on mobile, height ≤ 60vh, ≤ 640px on desktop. The
 * width math lives in video-layout.ts (computeVideoBubbleWidth, tested there);
 * mounting MessageBubble needs a dozen store mocks, so like the other bubble
 * tests this asserts on the template source.
 */
const source = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

describe("MessageBubble — video bubble size", () => {
  it("the bubble row is 97% wide on mobile for a video (images keep 85% max)", () => {
    expect(source).toContain(
      ":class=\"isVideoMessage ? 'w-[97%] md:w-[80%] lg:w-[65%]' : 'max-w-[85%] md:max-w-[80%] lg:max-w-[65%]'\"",
    );
  });

  it("the video bubble takes its width from computeVideoBubbleWidth, not the image rule", () => {
    const start = source.indexOf("<!-- Video message -->");
    const head = source.slice(start, source.indexOf("<!-- Forwarded indicator -->", start));
    expect(head).toContain(':style="videoBubbleStyle"');
    expect(head).not.toContain("imageBubbleStyle");
    expect(source).toMatch(/width: computeVideoBubbleWidth\(videoDimensions\.value, viewportW\.value >= MD_BREAKPOINT_PX\)/);
  });

  it("an own video stays right-aligned inside the wider row", () => {
    const start = source.indexOf("<!-- Video message -->");
    const head = source.slice(start, source.indexOf("<!-- Forwarded indicator -->", start));
    expect(head).toContain("props.isOwn ? 'ml-auto' : ''");
  });

  it("the wide row applies only when the video branch renders", () => {
    const fn = source.slice(source.indexOf("const isVideoMessage"), source.indexOf(");", source.indexOf("const isVideoMessage")));
    expect(fn).toContain("hasFileInfo.value");
    expect(fn).toContain("!props.message.deleted");
    expect(fn).toContain("!isUndecrypted.value");
  });
});
