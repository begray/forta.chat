import { describe, expect, it, vi } from "vitest";
import { isIndexedDbVersionError, startSyncStoreWithReset, type StartableStore } from "./sync-store-reset";

function versionError(): Error {
  const e = new Error("The requested version (4) is less than the existing version (5).");
  e.name = "VersionError";
  return e;
}

function makeDeps(startResults: Array<Error | null>) {
  const stores: StartableStore[] = [];
  const results = [...startResults];
  return {
    stores,
    deps: {
      dbName: "matrix-js-sdk-v7:alice",
      create: vi.fn(() => {
        const store = { startup: vi.fn(async () => {}) };
        stores.push(store);
        return store;
      }),
      start: vi.fn(async () => {
        const result = results.shift();
        if (result) throw result;
      }),
      release: vi.fn(),
      deleteDb: vi.fn(async () => {}),
    },
  };
}

describe("isIndexedDbVersionError", () => {
  it("recognises a VersionError from the main thread or the store worker", () => {
    expect(isIndexedDbVersionError(versionError())).toBe(true);
    expect(isIndexedDbVersionError({ name: "VersionError", message: "x" })).toBe(true);
    expect(isIndexedDbVersionError(new Error("timeout"))).toBe(false);
    expect(isIndexedDbVersionError(null)).toBe(false);
  });
});

describe("startSyncStoreWithReset", () => {
  it("returns the store untouched when it starts", async () => {
    const { deps, stores } = makeDeps([null]);

    const store = await startSyncStoreWithReset(deps);

    expect(store).toBe(stores[0]);
    expect(deps.deleteDb).not.toHaveBeenCalled();
  });

  // Regression: after rolling back from SDK 44 (schema v5) to 23.x (v4) the old
  // store never opened and the client ran without its cache.
  it("deletes and recreates a store written by a newer SDK", async () => {
    const { deps, stores } = makeDeps([versionError(), null]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = await startSyncStoreWithReset(deps);

    expect(deps.release).toHaveBeenCalledWith(stores[0]);
    expect(deps.deleteDb).toHaveBeenCalledWith("matrix-js-sdk-v7:alice");
    expect(store).toBe(stores[1]);
    expect(deps.start).toHaveBeenCalledTimes(2);
  });

  it("keeps the cache on other startup errors", async () => {
    const { deps, stores } = makeDeps([new Error("Matrix IndexedDB startup timed out")]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const store = await startSyncStoreWithReset(deps);

    expect(store).toBe(stores[0]);
    expect(deps.deleteDb).not.toHaveBeenCalled();
  });

  it("never throws, even if the reset fails", async () => {
    const { deps } = makeDeps([versionError(), versionError()]);
    deps.deleteDb.mockRejectedValueOnce(new Error("blocked"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startSyncStoreWithReset(deps)).resolves.toBeDefined();
  });
});
