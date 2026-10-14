import { describe, it, expect, vi, beforeEach } from "vitest";

const mock = vi.hoisted(() => ({ isNative: false, isAndroid: false }));
vi.mock("@/shared/lib/platform", () => ({
  get isNative() { return mock.isNative; },
  get isAndroid() { return mock.isAndroid; },
}));

const loadVideoJs = vi.fn(() => Promise.resolve());
vi.mock("./load-video-js", () => ({ loadVideoJs: () => loadVideoJs() }));
const installAndroidVideoPip = vi.fn(() => Promise.resolve());
vi.mock("./android-pip", () => ({ installAndroidVideoPip: () => installAndroidVideoPip() }));

import { prepareVideoJs } from "./prepare-video-js";

beforeEach(() => {
  mock.isNative = false;
  mock.isAndroid = false;
  loadVideoJs.mockReset();
  loadVideoJs.mockImplementation(() => Promise.resolve());
  installAndroidVideoPip.mockReset();
  installAndroidVideoPip.mockImplementation(() => Promise.resolve());
});

describe("prepareVideoJs", () => {
  it("on Android waits for the PiP bridge and the chunk, fetched in parallel", async () => {
    mock.isNative = true;
    mock.isAndroid = true;
    let finishPip!: () => void;
    installAndroidVideoPip.mockImplementation(() => new Promise<void>((r) => { finishPip = r; }));
    let done = false;
    const pending = prepareVideoJs().then(() => { done = true; });
    await Promise.resolve();

    expect(loadVideoJs).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    finishPip();
    await pending;
    expect(done).toBe(true);
  });

  it("on web leaves PiP alone", async () => {
    await prepareVideoJs();
    expect(installAndroidVideoPip).not.toHaveBeenCalled();
  });

  it("rejects when the chunk fails to load", async () => {
    loadVideoJs.mockImplementation(() => Promise.reject(new Error("chunk failed")));
    await expect(prepareVideoJs()).rejects.toThrow("chunk failed");
  });
});
