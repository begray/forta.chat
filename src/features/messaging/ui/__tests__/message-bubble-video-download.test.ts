import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Inbound video download states in MessageBubble.
 *
 * Regression: the video frame had only three branches — <video>, spinner,
 * play button. A failed download fell through to the play button and looked
 * exactly like a video nobody had loaded yet, so users could not tell an
 * error from "not started". Mounting MessageBubble needs a dozen store mocks;
 * like message-bubble-video-ux.test.ts this asserts on the template source.
 */
const source = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

const videoBlock = (() => {
  const start = source.indexOf("<!-- Video message -->");
  const end = source.indexOf("<!-- Upload progress overlay for video -->", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
})();

describe("MessageBubble — video download states", () => {
  it("renders a download-error branch before the idle play button", () => {
    const errorAt = videoBlock.indexOf('v-else-if="fileState.error"');
    const idleAt = videoBlock.indexOf('@click="handleVideoAudioLoad"');
    expect(errorAt).toBeGreaterThan(-1);
    expect(idleAt).toBeGreaterThan(errorAt);
    expect(videoBlock).toContain("t('message.videoDownloadFailed')");
    expect(videoBlock).toContain('@click.stop="retryVideoDownload"');
  });

  it("keeps the crypto-specific copy for undecryptable videos", () => {
    const errorBranch = videoBlock.slice(videoBlock.indexOf('v-else-if="fileState.error"'));
    expect(errorBranch).toContain("fileState.errorKind === 'crypto'");
    expect(errorBranch).toContain("t('chat.decryptError.title')");
  });

  it("shows download progress with a cancel while loading", () => {
    expect(videoBlock).toContain("<MediaDownloadProgress");
    expect(videoBlock).toContain(':progress="fileState.progress"');
    expect(videoBlock).toContain('@cancel="cancelVideoLoad"');
    expect(videoBlock).toContain(':cancellable="videoLoadAbort !== null"');
  });

  it("the playback-error retry downloads through the cancellable path", () => {
    const fnStart = source.indexOf("const retryVideoPlayback");
    const fn = source.slice(fnStart, source.indexOf("};", fnStart));
    expect(fn).toContain("startVideoLoad()");
    expect(fn).not.toMatch(/download\(props\.message\)/);
  });

  it("shows the file size on a video that has not been downloaded", () => {
    expect(videoBlock).toContain('data-testid="video-size-badge"');
    expect(videoBlock).toContain("fileSizeText");
  });

  it("retry re-fetches through the cancellable path", () => {
    const fnStart = source.indexOf("const retryVideoDownload");
    const fn = source.slice(fnStart, source.indexOf("};", fnStart));
    expect(fn).toContain("startVideoLoad({ forceRefetch: true })");
    const start = source.slice(source.indexOf("const startVideoLoad"));
    expect(start.slice(0, start.indexOf("};"))).toMatch(/download\(props\.message, ac\.signal, opts\)/);
  });
});
