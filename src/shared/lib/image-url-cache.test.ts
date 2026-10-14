// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEY = "archived_peertube_servers";
const DAY = 24 * 60 * 60 * 1000;

async function freshModule() {
  vi.resetModules();
  return import("./image-url");
}

describe("archived peertube servers cache", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts with the stored list, so offline starts still rewrite avatars", async () => {
    localStorage.setItem(KEY, JSON.stringify({ servers: ["peertube400.pocketnet.app"], at: 1 }));
    const m = await freshModule();
    expect(m.normalizePocketnetImageUrl("https://peertube400.pocketnet.app/images/a.jpg"))
      .toBe("https://peertube.archive.pocketnet.app/images/a.jpg");
  });

  it("stores a loaded list and treats it as fresh for two days", async () => {
    const m = await freshModule();
    const now = 10 * DAY;
    m.setArchivedPeertubeServers(["peertube400.pocketnet.app"], now);
    expect(m.hasFreshArchivedPeertubeServers(now + DAY)).toBe(true);
    expect(m.hasFreshArchivedPeertubeServers(now + 2 * DAY)).toBe(false);
  });

  it("does not store an empty list over the old one", async () => {
    const m = await freshModule();
    m.setArchivedPeertubeServers(["peertube400.pocketnet.app"], 5);
    m.setArchivedPeertubeServers([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ servers: ["peertube400.pocketnet.app"], at: 5 });
  });

  it("keeps the stored list when the proxy is unreachable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(KEY, JSON.stringify({ servers: ["peertube400.pocketnet.app"], at: 1 }));
    const m = await freshModule();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(m.loadArchivedPeertubeServers("https://1.pocketnet.app:8899")).resolves.toEqual([]);
    expect(m.getArchivedPeertubeServers()).toEqual(["peertube400.pocketnet.app"]);
    expect(m.hasFreshArchivedPeertubeServers(2)).toBe(true);
  });

  it("ignores a corrupted entry", async () => {
    localStorage.setItem(KEY, "{not json");
    const m = await freshModule();
    expect(m.getArchivedPeertubeServers()).toEqual([]);
    expect(m.hasFreshArchivedPeertubeServers()).toBe(false);
  });
});
