import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick, ref } from "vue";

const mock = vi.hoisted(() => ({ modern: true }));
vi.mock("@/shared/lib/video-js/video-player-support", () => ({ canUseModernPlayer: () => mock.modern }));
const prepareVideoJs = vi.fn(() => Promise.resolve());
vi.mock("@/shared/lib/video-js/prepare-video-js", () => ({ prepareVideoJs: () => prepareVideoJs() }));

import { useBubbleVideoJs } from "./use-bubble-video-js";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mock.modern = true;
  prepareVideoJs.mockReset();
  prepareVideoJs.mockImplementation(() => Promise.resolve());
});

describe("useBubbleVideoJs", () => {
  it("loads the player once the video file is on the device, then mounts it in the skin", async () => {
    let finish!: () => void;
    prepareVideoJs.mockImplementation(() => new Promise<void>((r) => { finish = r; }));
    const url = ref<string | null>(null);
    const { isVideoJsEnabled, isVideoShellReady } = useBubbleVideoJs(url, () => true);
    expect(prepareVideoJs).not.toHaveBeenCalled();
    expect(isVideoShellReady.value).toBe(false);

    url.value = "blob:video";
    await nextTick();
    expect(prepareVideoJs).toHaveBeenCalledTimes(1);
    expect(isVideoShellReady.value).toBe(false);

    finish();
    await flush();
    expect(isVideoJsEnabled.value).toBe(true);
    expect(isVideoShellReady.value).toBe(true);
  });

  it("an old WebView keeps native controls without fetching the chunk", () => {
    mock.modern = false;
    const { isVideoJsEnabled, isVideoShellReady } = useBubbleVideoJs(ref("blob:video"), () => true);
    expect(prepareVideoJs).not.toHaveBeenCalled();
    expect(isVideoJsEnabled.value).toBe(false);
    expect(isVideoShellReady.value).toBe(true);
  });

  it("a failed chunk load falls back to native controls", async () => {
    prepareVideoJs.mockImplementation(() => Promise.reject(new Error("offline")));
    const { isVideoJsEnabled, isVideoShellReady } = useBubbleVideoJs(ref("blob:video"), () => true);
    await flush();
    expect(isVideoJsEnabled.value).toBe(false);
    expect(isVideoShellReady.value).toBe(true);
  });

  it("non-video messages never load the player", () => {
    useBubbleVideoJs(ref("blob:file"), () => false);
    expect(prepareVideoJs).not.toHaveBeenCalled();
  });
});
