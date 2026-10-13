import { describe, it, expect, vi } from "vitest";
import { createVideoJsLoader } from "./load-video-js";

describe("loadVideoJs", () => {
  it("loads once and shares the promise between players", async () => {
    const importModules = vi.fn(() => Promise.resolve([]));
    const load = createVideoJsLoader(importModules);
    const a = load();
    const b = load();
    expect(a).toBe(b);
    await expect(a).resolves.toBeUndefined();
    await load();
    expect(importModules).toHaveBeenCalledTimes(1);
  });

  it("a failed load is not cached — the next open retries", async () => {
    const importModules = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce([]);
    const load = createVideoJsLoader(importModules);
    await expect(load()).rejects.toThrow("chunk failed");
    await expect(load()).resolves.toBeUndefined();
    expect(importModules).toHaveBeenCalledTimes(2);
  });
});
