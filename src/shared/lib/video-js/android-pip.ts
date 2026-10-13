import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Picture-in-picture for the Android app.
 *
 * Android WebView has no working `requestPictureInPicture`, so the Video.js
 * skin hides its PiP button there. Android PiP is an Activity mode instead:
 * the whole WebView shrinks into the floating window. This shim backs the
 * standard Picture-in-Picture API with the native `VideoPip` plugin, so the
 * skin's own button appears and works unchanged:
 *
 * - `document.pictureInPictureEnabled` → true (the device supports PiP);
 * - `video.requestPictureInPicture()` → the player covers the viewport
 *   (`data-native-pip`), then MainActivity enters PiP with the video's ratio;
 * - leaving PiP (native event) → `leavepictureinpicture`, layout restored;
 *   a closed (not expanded) window also pauses the video, or its sound would
 *   go on in the background with nothing on screen.
 *
 * Installed only on Android native, before the player chunk loads.
 */
interface VideoPipPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  enter(options: { width: number; height: number }): Promise<{ entered: boolean }>;
  addListener(event: "pipChanged", listener: (data: PipChange) => void): Promise<PluginListenerHandle>;
}

interface PipChange {
  active: boolean;
  /** The user closed the window rather than expanding it back. */
  dismissed?: boolean;
}

const VideoPip = registerPlugin<VideoPipPlugin>("VideoPip");

/** Attribute on <html> and on the player host while the Activity is in PiP. */
export const NATIVE_PIP_ATTR = "data-native-pip";

let installing: Promise<void> | null = null;
let pipVideo: HTMLVideoElement | null = null;
let pipHost: Element | null = null;

/** The element to blow up to the viewport: the skin around the shadow <video>. */
function findPlayerHost(video: HTMLVideoElement): Element {
  // <hls-video> keeps its <video> in a shadow root; a plain <video> is slotted.
  const root = video.getRootNode();
  const mediaHost = root instanceof ShadowRoot ? root.host : video;
  return mediaHost.closest("forta-video-skin") ?? mediaHost;
}

function clearPipState(): void {
  document.documentElement.removeAttribute(NATIVE_PIP_ATTR);
  pipHost?.removeAttribute(NATIVE_PIP_ATTR);
  pipHost = null;
  pipVideo = null;
}

async function requestNativePip(video: HTMLVideoElement): Promise<PictureInPictureWindow> {
  if (!video.videoWidth || !video.videoHeight) {
    throw new DOMException("Video metadata is not loaded", "InvalidStateError");
  }

  pipVideo = video;
  pipHost = findPlayerHost(video);
  pipHost.setAttribute(NATIVE_PIP_ATTR, "");
  document.documentElement.setAttribute(NATIVE_PIP_ATTR, "");

  let entered = false;
  try {
    ({ entered } = await VideoPip.enter({ width: video.videoWidth, height: video.videoHeight }));
  } catch (e) {
    console.warn("[AndroidPip] enter failed:", e);
  }
  if (!entered) {
    clearPipState();
    throw new DOMException("Picture-in-picture was refused", "NotAllowedError");
  }

  video.dispatchEvent(new Event("enterpictureinpicture"));
  // Activity PiP has no web-side window object; the API only needs a value.
  return {} as PictureInPictureWindow;
}

function onPipChanged({ active, dismissed }: PipChange): void {
  if (active || !pipVideo) return;
  const video = pipVideo;
  clearPipState();
  if (dismissed) video.pause();
  video.dispatchEvent(new Event("leavepictureinpicture"));
}

function patchPictureInPictureApi(): void {
  Object.defineProperty(document, "pictureInPictureEnabled", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => pipVideo,
  });
  // Activity PiP is left by the user (expand / close), not by the page.
  document.exitPictureInPicture = () => Promise.resolve();
  HTMLVideoElement.prototype.requestPictureInPicture = function requestPictureInPicture(
    this: HTMLVideoElement,
  ) {
    return requestNativePip(this);
  };
}

/**
 * Patch the PiP API when the device supports it. Idempotent; resolves even on
 * failure (the player then simply has no PiP button).
 */
export function installAndroidVideoPip(): Promise<void> {
  if (!installing) {
    installing = (async () => {
      try {
        const { supported } = await VideoPip.isSupported();
        if (!supported) return;
        await VideoPip.addListener("pipChanged", onPipChanged);
        patchPictureInPictureApi();
      } catch (e) {
        console.warn("[AndroidPip] install failed:", e);
      }
    })();
  }
  return installing;
}
