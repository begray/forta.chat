// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const plugin = vi.hoisted(() => ({
  supported: true,
  entered: true,
  listener: null as ((d: { active: boolean; dismissed?: boolean }) => void) | null,
  enter: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({
    isSupported: () => Promise.resolve({ supported: plugin.supported }),
    enter: (o: { width: number; height: number }) => {
      plugin.enter(o);
      return Promise.resolve({ entered: plugin.entered });
    },
    addListener: (_e: string, fn: (d: { active: boolean; dismissed?: boolean }) => void) => {
      plugin.listener = fn;
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  }),
}));

async function freshInstall() {
  vi.resetModules();
  const mod = await import("./android-pip");
  await mod.installAndroidVideoPip();
  return mod;
}

/** A <video> inside a shadow root under our skin, like Video.js renders it. */
function mountPlayer(width = 720, height = 960) {
  const skin = document.createElement("forta-video-skin");
  const media = document.createElement("hls-video");
  skin.appendChild(media);
  document.body.appendChild(skin);
  const video = document.createElement("video");
  media.attachShadow({ mode: "open" }).appendChild(video);
  Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
  return { skin, video };
}

const originalRequest = HTMLVideoElement.prototype.requestPictureInPicture;

beforeEach(() => {
  plugin.supported = true;
  plugin.entered = true;
  plugin.listener = null;
  plugin.enter.mockClear();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-native-pip");
  HTMLVideoElement.prototype.requestPictureInPicture = originalRequest;
  delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled;
  delete (document as unknown as Record<string, unknown>).pictureInPictureElement;
});

describe("installAndroidVideoPip", () => {
  it("reports PiP as available so the skin shows its button", async () => {
    await freshInstall();
    expect(document.pictureInPictureEnabled).toBe(true);
  });

  it("leaves the API alone when the device has no PiP (Android 7)", async () => {
    plugin.supported = false;
    await freshInstall();
    expect(document.pictureInPictureEnabled).not.toBe(true);
    expect(HTMLVideoElement.prototype.requestPictureInPicture).toBe(originalRequest);
  });

  it("enters native PiP with the video's size and covers the viewport", async () => {
    await freshInstall();
    const { skin, video } = mountPlayer();
    const onEnter = vi.fn();
    video.addEventListener("enterpictureinpicture", onEnter);

    await video.requestPictureInPicture();

    expect(plugin.enter).toHaveBeenCalledWith({ width: 720, height: 960 });
    expect(skin.hasAttribute("data-native-pip")).toBe(true);
    expect(document.documentElement.hasAttribute("data-native-pip")).toBe(true);
    expect(document.pictureInPictureElement).toBe(video);
    expect(onEnter).toHaveBeenCalled();
  });

  it("leaving PiP restores the layout and notifies the player", async () => {
    await freshInstall();
    const { skin, video } = mountPlayer();
    const onLeave = vi.fn();
    video.addEventListener("leavepictureinpicture", onLeave);
    await video.requestPictureInPicture();

    plugin.listener?.({ active: false });

    expect(onLeave).toHaveBeenCalled();
    expect(skin.hasAttribute("data-native-pip")).toBe(false);
    expect(document.documentElement.hasAttribute("data-native-pip")).toBe(false);
    expect(document.pictureInPictureElement).toBeNull();
  });

  it("expanding the window back keeps the video playing", async () => {
    await freshInstall();
    const { video } = mountPlayer();
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    await video.requestPictureInPicture();

    plugin.listener?.({ active: false, dismissed: false });
    expect(pause).not.toHaveBeenCalled();
  });

  // Regression (review 2026-10-13): closing the PiP window left the video
  // playing in the background with no UI.
  it("closing the window pauses the video", async () => {
    await freshInstall();
    const { video } = mountPlayer();
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    await video.requestPictureInPicture();

    plugin.listener?.({ active: false, dismissed: true });
    expect(pause).toHaveBeenCalled();
  });

  it("a refused PiP rolls the layout back and rejects", async () => {
    plugin.entered = false;
    await freshInstall();
    const { skin, video } = mountPlayer();

    await expect(video.requestPictureInPicture()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(skin.hasAttribute("data-native-pip")).toBe(false);
    expect(document.pictureInPictureElement).toBeNull();
  });

  it("refuses before metadata (no size yet), like the web API", async () => {
    await freshInstall();
    const { video } = mountPlayer(0, 0);

    await expect(video.requestPictureInPicture()).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(plugin.enter).not.toHaveBeenCalled();
  });
});
