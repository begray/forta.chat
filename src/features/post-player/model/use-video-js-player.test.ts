// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { useVideoJsPlayer, type VideoJsStore, type VideoJsPlayerOptions } from "./use-video-js-player";
import {
  getVideoPosition,
  saveVideoPosition,
  _resetVideoPositionCache,
} from "@/shared/lib/video-position-store";

/** Minimal stand-in for the Video.js player store. */
function createStore(init: Partial<VideoJsStore> = {}) {
  const listeners = new Set<() => void>();
  const state = {
    paused: true,
    ended: false,
    canPlay: false,
    currentTime: 0,
    duration: 0,
    error: null as unknown,
    ...init,
  };
  const store = {
    get paused() { return state.paused; },
    get ended() { return state.ended; },
    get canPlay() { return state.canPlay; },
    get currentTime() { return state.currentTime; },
    get duration() { return state.duration; },
    get error() { return state.error; },
    play: vi.fn(() => {
      state.paused = false;
      emit();
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      state.paused = true;
      emit();
    }),
    seek: vi.fn((t: number) => {
      state.currentTime = t;
      return Promise.resolve(t);
    }),
    subscribe: vi.fn((fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  };
  function emit() {
    listeners.forEach((fn) => fn());
  }
  function set(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    emit();
  }
  return { store, set, listeners };
}

function setup(options: VideoJsPlayerOptions = {}) {
  let api!: ReturnType<typeof useVideoJsPlayer>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useVideoJsPlayer(options);
        return () => h("div");
      },
    }),
  );
  return { api, wrapper };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  _resetVideoPositionCache();
});

describe("useVideoJsPlayer", () => {
  // Regression (2026-10-13): <hls-video> with preload="metadata" stops after
  // the manifest — canPlay stays false until play, so autoplay never fired.
  it("autoplay starts playback once metadata is in, without waiting for canPlay", async () => {
    const { api } = setup({ autoplay: true });
    const { store, set } = createStore();
    api.attach(store);
    set({ duration: 6.8 });
    await flush();
    expect(store.play).toHaveBeenCalledTimes(1);
  });

  it("autoplay starts playback once the source can play", async () => {
    const { api } = setup({ autoplay: true });
    const { store, set } = createStore();
    api.attach(store);
    expect(store.play).not.toHaveBeenCalled();

    set({ canPlay: true });
    await flush();
    expect(store.play).toHaveBeenCalledTimes(1);
  });

  it("without autoplay waits for the user", async () => {
    const { api } = setup();
    const { store, set } = createStore();
    api.attach(store);
    set({ canPlay: true });
    await flush();
    expect(store.play).not.toHaveBeenCalled();
  });

  it("a refused autoplay leaves the player usable", async () => {
    const { api } = setup({ autoplay: true });
    const { store, set } = createStore();
    store.play.mockImplementationOnce(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
    api.attach(store);
    set({ canPlay: true });
    await flush();
    expect(store.play).toHaveBeenCalled();
  });

  it("restores the saved position before autoplay", async () => {
    saveVideoPosition("video-1", 42, 120);
    const { api } = setup({ autoplay: true, persistKey: "video-1" });
    const { store, set } = createStore();
    api.attach(store);
    set({ canPlay: true });
    await flush();

    expect(store.seek).toHaveBeenCalledWith(42);
    expect(store.seek.mock.invocationCallOrder[0]).toBeLessThan(store.play.mock.invocationCallOrder[0]);
  });

  it("saves the position on pause", async () => {
    const { api } = setup({ persistKey: "video-1" });
    const { store, set } = createStore({ canPlay: true, duration: 120 });
    api.attach(store);
    await flush();
    set({ paused: false, currentTime: 30 });
    set({ paused: true, currentTime: 33 });

    expect(getVideoPosition("video-1")).toBe(33);
  });

  it("saves the position on unmount", async () => {
    const { api, wrapper } = setup({ persistKey: "video-1" });
    const { store, set } = createStore({ canPlay: true, duration: 120 });
    api.attach(store);
    await flush();
    set({ paused: false, currentTime: 50 });
    wrapper.unmount();

    expect(getVideoPosition("video-1")).toBe(50);
  });

  // Regression (review 2026-10-13): closing the modal while the manifest is
  // still loading flushed currentTime 0, which erased the saved position.
  it("closing before the player is ready keeps the saved position", () => {
    saveVideoPosition("video-1", 240, 600);
    const { api, wrapper } = setup({ persistKey: "video-1" });
    const { store } = createStore({ canPlay: false });
    api.attach(store);
    document.dispatchEvent(new Event("visibilitychange"));
    wrapper.unmount();

    expect(getVideoPosition("video-1")).toBe(240);
  });

  it("an ended video forgets its position (rewatch starts from 0)", async () => {
    saveVideoPosition("video-1", 42, 120);
    const { api } = setup({ persistKey: "video-1" });
    const { store, set } = createStore({ canPlay: true, duration: 120 });
    api.attach(store);
    await flush();
    set({ paused: false, currentTime: 60 });
    set({ paused: true, ended: true, currentTime: 120 });

    expect(getVideoPosition("video-1")).toBe(0);
  });

  it("a playback error is reported once as fatal", () => {
    const onFatalError = vi.fn();
    const { api } = setup({ onFatalError });
    const { store, set } = createStore();
    api.attach(store);
    set({ error: { code: 4, message: "unsupported" } });
    set({ currentTime: 1 });

    expect(onFatalError).toHaveBeenCalledTimes(1);
  });

  it("unmount unsubscribes from the store", () => {
    const { api, wrapper } = setup();
    const { store, listeners } = createStore();
    api.attach(store);
    expect(listeners.size).toBe(1);
    wrapper.unmount();
    expect(listeners.size).toBe(0);
  });
});
