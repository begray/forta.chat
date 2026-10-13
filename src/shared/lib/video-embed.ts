export interface VideoInfo {
  type: "youtube" | "vimeo" | "peertube";
  id: string;
  embedUrl: string;
  thumbUrl: string;
  apiUrl?: string;
  /** Web page of the video on its PeerTube instance — "open externally". */
  watchUrl?: string;
}

const YT_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const VIMEO_RE = /vimeo\.com\/(\d+)/;
const PEERTUBE_RE = /peertube:\/\/([^/]+)\/([a-f0-9-]+)/;

export function parseVideoUrl(url: string): VideoInfo | null {
  if (!url) return null;

  const yt = url.match(YT_RE);
  if (yt) {
    return {
      type: "youtube",
      id: yt[1],
      embedUrl: `https://www.youtube.com/embed/${yt[1]}`,
      thumbUrl: `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`,
    };
  }

  const vim = url.match(VIMEO_RE);
  if (vim) {
    return {
      type: "vimeo",
      id: vim[1],
      embedUrl: `https://player.vimeo.com/video/${vim[1]}`,
      thumbUrl: "",
    };
  }

  const pt = url.match(PEERTUBE_RE);
  if (pt) {
    const host = pt[1];
    const id = pt[2];
    return {
      type: "peertube",
      id,
      embedUrl: `https://${host}/videos/embed/${id}`,
      thumbUrl: "",
      apiUrl: `https://${host}/api/v1/videos/${id}`,
      watchUrl: `https://${host}/videos/watch/${id}`,
    };
  }

  return null;
}

interface PeerTubeFile {
  fileUrl?: string;
  resolution?: { id?: number };
}

interface PeerTubePlaylist {
  playlistUrl?: string;
  files?: PeerTubeFile[];
}

/** Everything a PeerTube video needs for playback, from one API call. */
export interface PeerTubeSources {
  /** HLS master playlist — adaptive quality, the primary source. */
  playlistUrl: string | null;
  /** One progressive/fMP4 file near 720p — fallback for players without HLS. */
  fileUrl: string | null;
  /** Preview image (its UUID differs from the video UUID). */
  thumbUrl: string;
  /** Width / height of the video, when the instance reports it. */
  aspectRatio: number | null;
}

const EMPTY_SOURCES: PeerTubeSources = {
  playlistUrl: null,
  fileUrl: null,
  thumbUrl: "",
  aspectRatio: null,
};

/** Pick the file closest to 720p — good quality without mobile bandwidth waste. */
const TARGET_RESOLUTION = 720;

function pickBestFile(files: PeerTubeFile[]): string | null {
  const candidates = files.filter((f) => typeof f.fileUrl === "string" && f.fileUrl);
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => {
    const da = Math.abs((a.resolution?.id ?? 0) - TARGET_RESOLUTION);
    const db = Math.abs((b.resolution?.id ?? 0) - TARGET_RESOLUTION);
    return db < da ? b : a;
  });
  return best.fileUrl ?? null;
}

const API_TIMEOUT_MS = 5000;

/**
 * Our own timeout, not `AbortSignal.timeout`: that needs Chrome 103 / Safari 16,
 * and Android 7 / iOS 15 WebViews — exactly the ones that need the mp4
 * fallback from this response — may lack it. The timer is cleared once the
 * body is parsed, so it can't abort anything later.
 */
async function fetchJsonWithTimeout(url: string): Promise<Record<string, unknown>> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), API_TIMEOUT_MS) : null;
  try {
    const resp = await fetch(url, { signal: controller?.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Playback sources from a PeerTube video object (`/api/v1/videos/{id}` shape). */
function sourcesFromVideoData(apiUrl: string, data: Record<string, unknown>): PeerTubeSources {
  const playlists: PeerTubePlaylist[] = Array.isArray(data.streamingPlaylists)
    ? (data.streamingPlaylists as PeerTubePlaylist[])
    : [];
  const playlistUrl = playlists.find((p) => typeof p.playlistUrl === "string" && p.playlistUrl)
    ?.playlistUrl ?? null;

  // Web-video files first (plain progressive mp4), then the fMP4 files the HLS
  // playlist is cut from — both play in a plain <video>.
  const fileUrl = pickBestFile(Array.isArray(data.files) ? (data.files as PeerTubeFile[]) : [])
    ?? pickBestFile(playlists.flatMap((p) => (Array.isArray(p.files) ? p.files : [])));

  const path = (data.previewPath || data.thumbnailPath) as string | undefined;
  const thumbUrl = path ? `${new URL(apiUrl).origin}${path}` : "";

  const aspectRatio = typeof data.aspectRatio === "number" && data.aspectRatio > 0
    ? data.aspectRatio
    : null;

  return { playlistUrl, fileUrl, thumbUrl, aspectRatio };
}

async function loadPeerTubeSources(apiUrl: string): Promise<PeerTubeSources> {
  return sourcesFromVideoData(apiUrl, await fetchJsonWithTimeout(apiUrl));
}

// One request per video per session: the feed preview and the post modal ask
// for the same video. Only playable answers are kept: a failure, or a video
// with nothing to play yet (still transcoding), is asked again next time.
const sourcesCache = new Map<string, Promise<PeerTubeSources>>();

/**
 * Resolve playback sources of a PeerTube video. Never rejects: an unreachable
 * instance or an unknown video yields empty sources.
 */
export function fetchPeerTubeSources(
  apiUrl: string,
  options: { fresh?: boolean } = {},
): Promise<PeerTubeSources> {
  // `fresh`: the cached URLs failed to play (expired / re-transcoded) — ask again.
  if (options.fresh) sourcesCache.delete(apiUrl);
  const cached = sourcesCache.get(apiUrl);
  if (cached) return cached;

  const pending = loadPeerTubeSources(apiUrl).then(
    (sources) => {
      if (!sources.playlistUrl && !sources.fileUrl) sourcesCache.delete(apiUrl);
      return sources;
    },
    () => {
      sourcesCache.delete(apiUrl);
      return EMPTY_SOURCES;
    },
  );
  sourcesCache.set(apiUrl, pending);
  return pending;
}

/**
 * Seed the cache from video objects that came with other data — the
 * `rpc-ex/getprofilefeed` response carries `videos: { "peertube://…": {…} }`
 * in the same shape as the PeerTube API, so the feed and the post modal need
 * no request of their own. Already cached videos are left alone.
 */
export function primePeerTubeSources(videos: Record<string, unknown> | null | undefined): void {
  if (!videos || typeof videos !== "object") return;
  for (const [url, data] of Object.entries(videos)) {
    const apiUrl = parseVideoUrl(url)?.apiUrl;
    if (!apiUrl || sourcesCache.has(apiUrl) || !data || typeof data !== "object") continue;
    const sources = sourcesFromVideoData(apiUrl, data as Record<string, unknown>);
    if (sources.playlistUrl || sources.fileUrl) sourcesCache.set(apiUrl, Promise.resolve(sources));
  }
}

/** Exported for test cleanup only. */
export function _resetPeerTubeSourcesCache(): void {
  sourcesCache.clear();
}

/** Fetch PeerTube thumbnail via API (the preview UUID differs from the video UUID) */
export async function fetchPeerTubeThumb(apiUrl: string): Promise<string> {
  return (await fetchPeerTubeSources(apiUrl)).thumbUrl;
}
