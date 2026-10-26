// @vitest-environment happy-dom
/**
 * One share intent reaches the chat once. The capgo plugin delivers the
 * launch intent from load() and again from onNewIntent, keeps the event for
 * late listeners, and a re-created Activity hands over the same intent again.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExternalShareData } from "../share-target";

const addListener = vi.fn();
vi.mock("@capgo/capacitor-share-target", () => ({
  CapacitorShareTarget: { addListener: (...args: unknown[]) => addListener(...args) },
}));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: {}, Directory: { Cache: "CACHE" } }));
vi.mock("@/shared/lib/platform", () => ({ isNative: true }));

async function load() {
  vi.resetModules();
  return await import("../share-target");
}

const event = (names: string[], texts: string[] = []) => ({
  texts,
  files: names.map((n) => ({ uri: `/data/user/0/app/cache/shared_files/${n}`, name: n, mimeType: "image/jpeg" })),
});

describe("share intent identity", () => {
  beforeEach(() => {
    addListener.mockReset();
    localStorage.clear();
  });

  it("drops the same intent delivered twice, and passes its key on", async () => {
    const st = await load();
    const got: ExternalShareData[] = [];
    await st.initShareTargetListener((d) => got.push(d));
    const listener = addListener.mock.calls[0][1] as (e: unknown) => Promise<void>;

    await listener(event(["a.jpg", "b.jpg"]));
    await listener(event(["a.jpg", "b.jpg"]));
    await listener(event(["c.jpg"]));

    expect(got).toHaveLength(2);
    expect(got[0].key).toBe(st.shareKeyOf(event(["a.jpg", "b.jpg"])));
    const { getUploadLog } = await import("@/shared/lib/upload-log/upload-log");
    expect(getUploadLog().filter((e) => e.e === "share:repeat")).toHaveLength(1);
    expect(getUploadLog().filter((e) => e.e === "share:received")).toHaveLength(2);
  });

  it("a repeat is dropped within the window, while sending, and right after the send", async () => {
    const st = await load();
    const W = st.SHARE_REPEAT_WINDOW_MS;
    expect(st.acceptShare("k", 0)).toBe(true);
    expect(st.acceptShare("k", W - 1)).toBe(false);
    expect(st.claimShareSend("k", W + 10)).toBe(true);
    expect(st.claimShareSend("k", W + 20)).toBe(false); // second Send
    expect(st.acceptShare("k", 10 * W)).toBe(false); // still sending
    st.finishShareSend("k", 10 * W);
    expect(st.acceptShare("k", 10 * W + 1)).toBe(false);
    expect(st.claimShareSend("k", 10 * W + 1)).toBe(false);
    // Later on, the same photos shared again are a new share.
    expect(st.acceptShare("k", 12 * W)).toBe(true);
    expect(st.claimShareSend("k", 12 * W)).toBe(true);
  });

  it("forgets a share that sent nothing, so sharing it again works at once", async () => {
    const st = await load();
    expect(st.acceptShare("k", 0)).toBe(true);
    expect(st.claimShareSend("k", 1)).toBe(true);
    st.releaseShareClaim("k");
    expect(st.acceptShare("k", 2)).toBe(true);
  });

  it("keys on files and text, in order", async () => {
    const st = await load();
    expect(st.shareKeyOf(event(["a.jpg", "b.jpg"]))).not.toBe(st.shareKeyOf(event(["b.jpg", "a.jpg"])));
    expect(st.shareKeyOf({ ...event(["a.jpg"]), text: "hi" })).not.toBe(st.shareKeyOf(event(["a.jpg"])));
  });

  it("builds native file URIs with encoded names", async () => {
    const st = await load();
    expect(st.toNativeFileUri("/c/IMG 1#?.jpg")).toBe("file:///c/IMG%201%23%3F.jpg");
    expect(st.toNativeFileUri("file:///c/a%20b.jpg")).toBe("file:///c/a%20b.jpg");
    expect(st.toNativeFileUri("content://media/1")).toBe("content://media/1");
  });
});
