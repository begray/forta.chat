// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { PeerTubeSources } from "@/shared/lib/video-embed";

// Mutable mock state — hoisted: the locale store reads the platform at import.
const mock = vi.hoisted(() => ({ isNative: false, modern: true }));
vi.mock("@/shared/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/platform")>();
  return {
    ...actual,
    get isNative() {
      return mock.isNative;
    },
  };
});

// Browser fallback must never be a real no-op `window.open` on native; spy on it.
const openExternalUrl = vi.fn();
vi.mock("@/shared/lib/open-external-url", () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

// PeerTube API — controls which player the modal picks.
let mockSources: PeerTubeSources = { playlistUrl: null, fileUrl: null, thumbUrl: "", aspectRatio: null };
const fetchPeerTubeSources = vi.fn((_apiUrl?: string, _options?: { fresh?: boolean }) =>
  Promise.resolve(mockSources));
vi.mock("@/shared/lib/video-embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/video-embed")>();
  return {
    ...actual,
    fetchPeerTubeSources: (apiUrl: string, options?: { fresh?: boolean }) =>
      fetchPeerTubeSources(apiUrl, options),
  };
});

vi.mock("@/shared/lib/video-js/video-player-support", () => ({
  canUseModernPlayer: () => mock.modern,
}));

import VideoPlayer from "../VideoPlayer.vue";

const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PT_URL = "peertube://videos.example.com/a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PT_WATCH = "https://videos.example.com/videos/watch/a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PLAYLIST = "https://cdn.example.com/master.m3u8";
const FILE = "https://cdn.example.com/720-fragmented.mp4";

// Both players are stubbed: their own behavior is covered by
// use-feed-video-player.test.ts and use-video-js-player.test.ts; here we only
// assert the routing decision.
const mountOptions = { global: { stubs: { FeedVideoPlayer: true, PeerTubePlayer: true } } };

beforeEach(() => {
  setActivePinia(createPinia());
  mock.isNative = false;
  mock.modern = true;
  mockSources = { playlistUrl: null, fileUrl: null, thumbUrl: "", aspectRatio: null };
  openExternalUrl.mockClear();
  fetchPeerTubeSources.mockClear();
});

describe("VideoPlayer iframe (YouTube / Vimeo in the post modal)", () => {
  it("renders iframe with sandbox attribute set after play is clicked", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    expect(wrapper.find("iframe").exists()).toBe(false);

    await wrapper.find("button").trigger("click");
    await flushPromises();

    const iframe = wrapper.find("iframe");
    expect(iframe.exists()).toBe(true);

    const sandbox = iframe.attributes("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-presentation");
  });

  it("после @load iframe скрывает loading-overlay (WEE-70)", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(true);

    await wrapper.find("iframe").trigger("load");
    await flushPromises();
    expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(false);
  });

  it("на native не добавляет ?autoplay=1 в iframe src", async () => {
    mock.isNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    expect(wrapper.find("iframe").attributes("src")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  it("на web сохраняет ?autoplay=1 в iframe src", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();

    expect(wrapper.find("iframe").attributes("src") ?? "").toContain("autoplay=1");
  });

  it("не показывает «открыть внешне» поверх играющего видео — только при ошибке", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(false);

    await wrapper.find("iframe").trigger("error");
    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(true);
  });

  it("прячет overlay-спиннер по таймауту, даже если @load не сработал", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

      await wrapper.find("button").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(true);

      await vi.advanceTimersByTimeAsync(10_001);
      await flushPromises();

      expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("на native «открыть внешне» уходит через openExternalUrl, а не window.open", async () => {
    mock.isNative = true;
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL } });

    await wrapper.find("button").trigger("click");
    await flushPromises();
    await wrapper.find("iframe").trigger("error");

    await wrapper.find("[data-testid='video-external']").trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(YT_URL);
  });

  it("autoplay сразу монтирует iframe без тапа по overlay", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL, autoplay: true }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("iframe").attributes("src")).toContain("autoplay=1");
  });

  it("без autoplay overlay ждёт тапа", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: YT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.find("button").exists()).toBe(true);
  });
});

describe("VideoPlayer feed tile: тап всегда открывает модалку (WEE-74, 2026-10-13)", () => {
  it.each([
    ["web", false, YT_URL],
    ["native", true, YT_URL],
    ["web", false, PT_URL],
    ["native", true, PT_URL],
  ])("%s: тап по видео в ленте эмитит expand и ничего не играет (%s)", async (_label, native, url) => {
    mock.isNative = native as boolean;
    mockSources = { playlistUrl: PLAYLIST, fileUrl: FILE, thumbUrl: "https://cdn/p.jpg", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: url as string, inline: true }, ...mountOptions });
    await flushPromises();

    await wrapper.find("button").trigger("click");

    expect(wrapper.emitted("expand")).toHaveLength(1);
    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.findComponent({ name: "PeerTubePlayer" }).exists()).toBe(false);
    expect(wrapper.find("[data-testid='file-player']").exists()).toBe(false);
  });

  it("плитка PeerTube показывает превью из API", async () => {
    mockSources = { playlistUrl: PLAYLIST, fileUrl: null, thumbUrl: "https://cdn/p.jpg", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL, inline: true }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("img").attributes("src")).toBe("https://cdn/p.jpg");
  });
});

describe("VideoPlayer PeerTube в модалке: HLS → mp4 → открыть внешне, без iframe", () => {
  it("HLS-плейлист и современный WebView → Video.js-плеер с autoplay и памятью позиции", async () => {
    mockSources = { playlistUrl: PLAYLIST, fileUrl: FILE, thumbUrl: "https://cdn/p.jpg", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL, autoplay: true }, ...mountOptions });
    await flushPromises();

    const hls = wrapper.findComponent({ name: "PeerTubePlayer" });
    expect(hls.exists()).toBe(true);
    expect(hls.props("src")).toBe(PLAYLIST);
    expect(hls.props("poster")).toBe("https://cdn/p.jpg");
    expect(hls.props("autoplay")).toBe(true);
    expect(hls.props("persistKey")).toBe(PT_URL);
    expect(wrapper.find("iframe").exists()).toBe(false);
  });

  it("соотношение сторон из API задаёт размер плеера (вертикальное видео)", async () => {
    mockSources = { playlistUrl: PLAYLIST, fileUrl: FILE, thumbUrl: "", aspectRatio: 0.75 };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.findComponent({ name: "PeerTubePlayer" }).props("aspectRatio")).toBe(0.75);
  });

  it("запасной mp4-плеер тоже берёт размер из соотношения сторон", async () => {
    mock.modern = false;
    mockSources = { playlistUrl: null, fileUrl: FILE, thumbUrl: "", aspectRatio: 0.75 };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    const file = wrapper.find("[data-testid='file-player']");
    expect(file.attributes("aspectratio") ?? file.attributes("aspect-ratio")).toBe("0.75");
    expect(file.classes()).toContain("max-h-[70vh]");
  });

  it("старый WebView (Video.js не тянет) → обычный <video> с mp4", async () => {
    mock.modern = false;
    mockSources = { playlistUrl: PLAYLIST, fileUrl: FILE, thumbUrl: "", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.findComponent({ name: "PeerTubePlayer" }).exists()).toBe(false);
    const file = wrapper.find("[data-testid='file-player']");
    expect(file.exists()).toBe(true);
    expect(file.attributes("src")).toBe(FILE);
  });

  it("фатальная ошибка HLS → откат на mp4", async () => {
    mockSources = { playlistUrl: PLAYLIST, fileUrl: FILE, thumbUrl: "", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    wrapper.findComponent({ name: "PeerTubePlayer" }).vm.$emit("fatal-error");
    await flushPromises();

    expect(wrapper.findComponent({ name: "PeerTubePlayer" }).exists()).toBe(false);
    expect(wrapper.find("[data-testid='file-player']").exists()).toBe(true);
    expect(wrapper.find("iframe").exists()).toBe(false);
  });

  it("фатальная ошибка HLS без mp4 → «открыть внешне» со ссылкой на страницу видео", async () => {
    mockSources = { playlistUrl: PLAYLIST, fileUrl: null, thumbUrl: "", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    wrapper.findComponent({ name: "PeerTubePlayer" }).vm.$emit("fatal-error");
    await flushPromises();

    const link = wrapper.find("[data-testid='video-external']");
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe(PT_WATCH);
    await link.trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(PT_WATCH);
  });

  it("ошибка mp4-плеера → «открыть внешне»", async () => {
    mock.modern = false;
    mockSources = { playlistUrl: null, fileUrl: FILE, thumbUrl: "", aspectRatio: null };
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    wrapper.findComponent({ name: "FeedVideoPlayer" }).vm.$emit("fatal-error");
    await flushPromises();

    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(true);
  });

  it("видео недоступно в API → «открыть внешне», iframe не появляется", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL, autoplay: true }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(true);
    expect(wrapper.find("iframe").exists()).toBe(false);
  });

  it("«Повторить» запрашивает API снова и запускает плеер, когда видео появилось", async () => {
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();
    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(true);

    mockSources = { playlistUrl: PLAYLIST, fileUrl: null, thumbUrl: "", aspectRatio: null };
    await wrapper.find("[data-testid='video-retry']").trigger("click");
    await flushPromises();

    expect(fetchPeerTubeSources).toHaveBeenCalledTimes(2);
    // Past the cache: the cached URLs may be the ones that failed.
    expect(fetchPeerTubeSources.mock.calls[1][1]).toEqual({ fresh: true });
    expect(wrapper.findComponent({ name: "PeerTubePlayer" }).exists()).toBe(true);
  });

  it("пока API отвечает — спиннер, без кнопок", async () => {
    fetchPeerTubeSources.mockImplementationOnce(() => new Promise<never>(() => {}));
    const wrapper = mount(VideoPlayer, { props: { url: PT_URL }, ...mountOptions });
    await flushPromises();

    expect(wrapper.find("[data-testid='video-loading']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='video-external']").exists()).toBe(false);
  });

  it("YouTube не запрашивает PeerTube API", async () => {
    mount(VideoPlayer, { props: { url: YT_URL }, ...mountOptions });
    await flushPromises();

    expect(fetchPeerTubeSources).not.toHaveBeenCalled();
  });
});
