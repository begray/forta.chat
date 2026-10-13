import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseVideoUrl,
  primePeerTubeSources,
  fetchPeerTubeSources,
  fetchPeerTubeThumb,
  _resetPeerTubeSourcesCache,
} from "./video-embed";

describe("parseVideoUrl", () => {
  // ─── YouTube ────────────────────────────────────────────────────

  it("parses youtube.com/watch?v= URL", () => {
    const result = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result).toEqual({
      type: "youtube",
      id: "dQw4w9WgXcQ",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
      thumbUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });

  it("parses youtu.be short URL", () => {
    const result = parseVideoUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("youtube");
    expect(result!.id).toBe("dQw4w9WgXcQ");
  });

  it("parses youtube.com/embed/ URL", () => {
    const result = parseVideoUrl("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("dQw4w9WgXcQ");
  });

  it("parses youtube.com/shorts/ URL", () => {
    const result = parseVideoUrl("https://www.youtube.com/shorts/AbCdEfGhIjK");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("youtube");
    expect(result!.id).toBe("AbCdEfGhIjK");
  });

  it("handles YouTube URL with extra params", () => {
    const result = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("dQw4w9WgXcQ");
  });

  // ─── Vimeo ──────────────────────────────────────────────────────

  it("parses vimeo.com URL", () => {
    const result = parseVideoUrl("https://vimeo.com/123456789");
    expect(result).toEqual({
      type: "vimeo",
      id: "123456789",
      embedUrl: "https://player.vimeo.com/video/123456789",
      thumbUrl: "",
    });
  });

  // ─── PeerTube ───────────────────────────────────────────────────

  it("parses peertube:// protocol URL", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = parseVideoUrl(`peertube://videos.example.com/${uuid}`);
    expect(result).toEqual({
      type: "peertube",
      id: uuid,
      embedUrl: `https://videos.example.com/videos/embed/${uuid}`,
      // Thumb is resolved lazily via the API (the preview UUID differs from
      // the video UUID) — parse returns the API URL instead.
      thumbUrl: "",
      apiUrl: `https://videos.example.com/api/v1/videos/${uuid}`,
      watchUrl: `https://videos.example.com/videos/watch/${uuid}`,
    });
  });

  // ─── Invalid / Edge cases ───────────────────────────────────────

  it("returns null for empty string", () => {
    expect(parseVideoUrl("")).toBeNull();
  });

  it("returns null for non-video URL", () => {
    expect(parseVideoUrl("https://example.com/page")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(parseVideoUrl("just some text")).toBeNull();
  });

  it("returns null for YouTube-like URL with wrong ID length", () => {
    expect(parseVideoUrl("https://youtube.com/watch?v=short")).toBeNull();
  });
});

describe("fetchPeerTubeSources", () => {
  const API_URL = "https://videos.example.com/api/v1/videos/abc";

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetPeerTubeSourcesCache();
  });

  function stubFetch(payload: unknown, ok = true) {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        json: () => Promise.resolve(payload),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns the HLS playlist, a fallback file and the preview", async () => {
    // Shape of a real PeerTube 4.2 HLS-only video (no web-video files).
    stubFetch({
      files: [],
      aspectRatio: 0.7497,
      previewPath: "/lazy-static/previews/p.jpg",
      streamingPlaylists: [
        {
          playlistUrl: "https://cdn/hls/master.m3u8",
          files: [
            { fileUrl: "https://cdn/hls/720-fragmented.mp4", resolution: { id: 720 } },
            { fileUrl: "https://cdn/hls/144-fragmented.mp4", resolution: { id: 144 } },
          ],
        },
      ],
    });
    await expect(fetchPeerTubeSources(API_URL)).resolves.toEqual({
      playlistUrl: "https://cdn/hls/master.m3u8",
      fileUrl: "https://cdn/hls/720-fragmented.mp4",
      thumbUrl: "https://videos.example.com/lazy-static/previews/p.jpg",
      aspectRatio: 0.7497,
    });
  });

  it("prefers the web-video file closest to 720p", async () => {
    stubFetch({
      files: [
        { fileUrl: "https://cdn/240.mp4", resolution: { id: 240 } },
        { fileUrl: "https://cdn/720.mp4", resolution: { id: 720 } },
        { fileUrl: "https://cdn/1080.mp4", resolution: { id: 1080 } },
      ],
    });
    const sources = await fetchPeerTubeSources(API_URL);
    expect(sources.fileUrl).toBe("https://cdn/720.mp4");
    expect(sources.playlistUrl).toBeNull();
  });

  it("ignores entries without fileUrl", async () => {
    stubFetch({
      files: [
        { resolution: { id: 720 } },
        { fileUrl: "https://cdn/360.mp4", resolution: { id: 360 } },
      ],
    });
    expect((await fetchPeerTubeSources(API_URL)).fileUrl).toBe("https://cdn/360.mp4");
  });

  it("returns empty sources when the video has nothing playable", async () => {
    stubFetch({ files: [], streamingPlaylists: [] });
    await expect(fetchPeerTubeSources(API_URL)).resolves.toEqual({
      playlistUrl: null,
      fileUrl: null,
      thumbUrl: "",
      aspectRatio: null,
    });
  });

  it("returns empty sources on HTTP error", async () => {
    stubFetch({}, false);
    expect((await fetchPeerTubeSources(API_URL)).playlistUrl).toBeNull();
  });

  it("returns empty sources on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect((await fetchPeerTubeSources(API_URL)).fileUrl).toBeNull();
  });

  it("asks the API once per video: thumb and player share the response", async () => {
    const fetchMock = stubFetch({
      previewPath: "/p.jpg",
      streamingPlaylists: [{ playlistUrl: "https://cdn/m.m3u8" }],
    });
    await fetchPeerTubeThumb(API_URL);
    await fetchPeerTubeSources(API_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure — the next call retries", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await fetchPeerTubeSources(API_URL);
    const fetchMock = stubFetch({ previewPath: "/p.jpg", files: [] });
    expect((await fetchPeerTubeSources(API_URL)).thumbUrl).toBe("https://videos.example.com/p.jpg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a video with nothing playable yet (still transcoding)", async () => {
    stubFetch({ files: [], streamingPlaylists: [] });
    await fetchPeerTubeSources(API_URL);
    const fetchMock = stubFetch({ streamingPlaylists: [{ playlistUrl: "https://cdn/m.m3u8" }] });
    expect((await fetchPeerTubeSources(API_URL)).playlistUrl).toBe("https://cdn/m.m3u8");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("works on engines without AbortSignal.timeout (iOS 15, old Android WebView)", async () => {
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    try {
      const fetchMock = stubFetch({ streamingPlaylists: [{ playlistUrl: "https://cdn/m.m3u8" }] });
      expect((await fetchPeerTubeSources(API_URL)).playlistUrl).toBe("https://cdn/m.m3u8");
      const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: original });
    }
  });

  it("clears its timeout once the response is in", async () => {
    vi.useFakeTimers();
    try {
      stubFetch({ streamingPlaylists: [{ playlistUrl: "https://cdn/m.m3u8" }] });
      await fetchPeerTubeSources(API_URL);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("`fresh` skips the cached answer (retry after the cached URLs failed)", async () => {
    stubFetch({ streamingPlaylists: [{ playlistUrl: "https://cdn/old.m3u8" }] });
    await fetchPeerTubeSources(API_URL);
    const fetchMock = stubFetch({ streamingPlaylists: [{ playlistUrl: "https://cdn/new.m3u8" }] });
    expect((await fetchPeerTubeSources(API_URL, { fresh: true })).playlistUrl).toBe("https://cdn/new.m3u8");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("primePeerTubeSources (rpc-ex/getprofilefeed videos)", () => {
  const URL_KEY = "peertube://peertube900.pocketnet.app/b2cde7de-e77e-44d3-ba75-4f936163a089";
  const API_URL = "https://peertube900.pocketnet.app/api/v1/videos/b2cde7de-e77e-44d3-ba75-4f936163a089";

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetPeerTubeSourcesCache();
  });

  it("feeds the cache from the feed's video objects — no API request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    primePeerTubeSources({
      [URL_KEY]: {
        aspectRatio: 1.7777777777777777,
        previewPath: "/lazy-static/previews/c5df.jpg",
        files: [],
        streamingPlaylists: [{
          playlistUrl: "https://peertube900.pocketnet.app/hls/master.m3u8",
          files: [{ fileUrl: "https://peertube900.pocketnet.app/hls/360-fragmented.mp4", resolution: { id: 360 } }],
        }],
      },
    });

    await expect(fetchPeerTubeSources(API_URL)).resolves.toEqual({
      playlistUrl: "https://peertube900.pocketnet.app/hls/master.m3u8",
      fileUrl: "https://peertube900.pocketnet.app/hls/360-fragmented.mp4",
      thumbUrl: "https://peertube900.pocketnet.app/lazy-static/previews/c5df.jpg",
      aspectRatio: 1.7777777777777777,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores entries with nothing playable and non-PeerTube keys", async () => {
    primePeerTubeSources({ [URL_KEY]: { files: [], streamingPlaylists: [] }, "https://x": {} });
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPeerTubeSources(API_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing videos map", () => {
    expect(() => primePeerTubeSources(undefined)).not.toThrow();
  });
});
