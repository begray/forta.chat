// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const loadVideoJs = vi.fn(() => Promise.resolve());
vi.mock("@/shared/lib/video-js/prepare-video-js", () => ({ prepareVideoJs: () => loadVideoJs() }));

import PeerTubePlayer from "../PeerTubePlayer.vue";

// Stand-in for the real <video-player>: an element exposing a store.
const fakeStore = {
  paused: true, ended: false, canPlay: false, currentTime: 0, duration: 0,
  error: null, isFullscreen: false,
  play: vi.fn(() => Promise.resolve()), pause: vi.fn(), seek: vi.fn(() => Promise.resolve(0)),
  exitFullscreen: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(() => () => {}),
};
if (!customElements.get("video-player")) {
  customElements.define("video-player", class extends HTMLElement {
    store = fakeStore;
  });
}

const PLAYLIST = "https://cdn.example.com/master.m3u8";

beforeEach(() => {
  setActivePinia(createPinia());
  loadVideoJs.mockReset();
  loadVideoJs.mockImplementation(() => Promise.resolve());
  fakeStore.subscribe.mockClear();
});

describe("PeerTubePlayer", () => {
  it("renders the Video.js player with the playlist once the chunk loads", async () => {
    const wrapper = mount(PeerTubePlayer, { props: { src: PLAYLIST, poster: "https://cdn/p.jpg" } });
    // Poster + spinner while loading
    expect(wrapper.find("video-player").exists()).toBe(false);
    expect(wrapper.find("img").attributes("src")).toBe("https://cdn/p.jpg");

    await flushPromises();

    const media = wrapper.find("hls-video");
    expect(media.exists()).toBe(true);
    expect(media.attributes("src")).toBe(PLAYLIST);
    expect(media.attributes("playsinline")).toBeDefined();
    expect(fakeStore.subscribe).toHaveBeenCalledTimes(1);
  });

  it("a vertical video gets a height-capped container with its own ratio", async () => {
    const wrapper = mount(PeerTubePlayer, { props: { src: PLAYLIST, aspectRatio: 0.75 } });
    const box = wrapper.find("[data-testid='peertube-player']");
    expect(box.attributes("data-orientation")).toBe("vertical");
    expect(box.attributes("style")).toContain("aspect-ratio: 0.75");
    expect(box.classes()).toContain("max-h-[70vh]");
  });

  it("a horizontal video keeps the full width", async () => {
    const wrapper = mount(PeerTubePlayer, { props: { src: PLAYLIST, aspectRatio: 16 / 9 } });
    const box = wrapper.find("[data-testid='peertube-player']");
    expect(box.attributes("data-orientation")).toBe("horizontal");
    expect(box.classes()).not.toContain("max-h-[70vh]");
  });

  it("passes the app language to the player UI", async () => {
    const wrapper = mount(PeerTubePlayer, { props: { src: PLAYLIST } });
    await flushPromises();
    expect(wrapper.find("media-i18n").attributes("lang")).toMatch(/^(en|ru)$/);
  });

  it("a chunk that fails to load hands off to the fallback player", async () => {
    loadVideoJs.mockImplementation(() => Promise.reject(new Error("chunk failed")));
    const wrapper = mount(PeerTubePlayer, { props: { src: PLAYLIST } });
    await flushPromises();

    expect(wrapper.emitted("fatal-error")).toHaveLength(1);
    expect(wrapper.find("video-player").exists()).toBe(false);
  });

  it("closing before the chunk arrives neither renders nor reports an error", async () => {
    let finishLoad!: () => void;
    loadVideoJs.mockImplementation(() => new Promise<void>((r) => { finishLoad = r; }));
    const wrapper = mount(PeerTubePlayer, { props: { src: PLAYLIST } });
    wrapper.unmount();
    finishLoad();
    await flushPromises();

    expect(wrapper.emitted("fatal-error")).toBeUndefined();
    expect(fakeStore.subscribe).not.toHaveBeenCalled();
  });
});
