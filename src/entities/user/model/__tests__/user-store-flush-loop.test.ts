// @vitest-environment happy-dom
/**
 * Regression: ProfileLoader's flush always fired triggerRef(users) and a full
 * localStorage rewrite, even when the batch changed nothing. The sidebar's
 * room list depends on `users` and re-enqueues the members it still lacks, so
 * addresses the server has no profile for looped forever: on a device, 30 such
 * addresses were re-enqueued every ~0.5s, each round re-rendering the list and
 * rewriting a 345KB localStorage entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { watchEffect } from "vue";

const profiles: Record<string, { name: string } | null> = {};
const rawRows: Record<string, { deleted?: boolean }> = {};
const loadUsersInfo = vi.fn(async (_addrs: string[]) => {});

vi.mock("@/app/providers/initializers/app-initializer", () => ({
  createAppInitializer: () => ({
    initApi: vi.fn(async () => {}),
    loadUsersInfo,
    getUserData: (addr: string) => profiles[addr] ?? null,
    getRawUserProfile: (addr: string) => rawRows[addr] ?? null,
  }),
}));

import { useUserStore } from "../user-store";

/** Lets the idle-scheduled flush (setTimeout fallback) and the 500ms persist debounce run. */
const settle = () => new Promise((r) => setTimeout(r, 1200));

describe("user-store — ProfileLoader flush", () => {
  let store: ReturnType<typeof useUserStore>;
  let renders = 0;
  let setItem: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    store = useUserStore();
    loadUsersInfo.mockReset();
    loadUsersInfo.mockImplementation(async () => {});
    for (const k of Object.keys(profiles)) delete profiles[k];
    for (const k of Object.keys(rawRows)) delete rawRows[k];
    renders = 0;
    watchEffect(() => { void store.users; renders++; }, { flush: "sync" });
    setItem = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not notify or persist when a flush loads nothing new", async () => {
    profiles.Ghost = null;
    store.enqueueProfiles(["Ghost"]);
    await settle();
    expect(loadUsersInfo).toHaveBeenCalledTimes(1);
    const rendersAfterFirst = renders;
    setItem.mockClear();

    // The sidebar re-enqueues the same missing address on every list change.
    store.enqueueProfiles(["Ghost"]);
    await settle();
    store.enqueueProfiles(["Ghost"]);
    await settle();

    expect(loadUsersInfo).toHaveBeenCalledTimes(1);
    expect(renders).toBe(rendersAfterFirst);
    expect(setItem).not.toHaveBeenCalledWith("bastyon-chat-users", expect.anything());
  });

  it("notifies once and persists when a flush loads a profile", async () => {
    profiles.Alice = { name: "Alice" };
    const before = renders;
    store.enqueueProfiles(["Alice"]);
    await settle();

    expect(store.users.Alice?.name).toBe("Alice");
    expect(renders).toBe(before + 1);
    expect(setItem).toHaveBeenCalledWith("bastyon-chat-users", expect.stringContaining("Alice"));
  });
});
