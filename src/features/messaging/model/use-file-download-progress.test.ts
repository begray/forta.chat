// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { effectScope } from "vue";

/**
 * Inbound media download UX: progress state, decrypt-timeout handling and
 * stall deadlines.
 *
 * Regressions covered:
 *  - a decrypt that hit its deadline fell into the generic retry loop and
 *    re-downloaded the whole file up to four times before failing;
 *  - the headers deadline aborted the fetch with a bare AbortError, which
 *    download() treats as a user cancel — the failure vanished silently and
 *    the bubble went back to its "tap to load" state.
 */

vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isElectron: false,
  isAndroid: false,
  isIOS: false,
  isWeb: true,
}));

let mockPcrypto: { rooms: Record<string, unknown> } | null = null;
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ get pcrypto() { return mockPcrypto; } })),
}));
vi.mock("@/shared/lib/matrix/functions", () => ({ hexEncode: (s: string) => s }));
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({ mxcToHttp: (mxc: string) => `https://hs.example/dl/${mxc.slice(6)}` }),
}));
const mockBugReportOpen = vi.fn();
vi.mock("@/features/bug-report", () => ({ useBugReport: () => ({ open: mockBugReportOpen }) }));
vi.mock("@/shared/lib/i18n", () => ({ tRaw: (k: string) => k }));
vi.mock("@/shared/lib/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/shared/lib/media-cache", () => ({ getMediaCache: () => null }));

const mockRunFileDecrypt: Mock = vi.fn();
vi.mock("./decrypt-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./decrypt-queue")>();
  return { ...actual, runFileDecrypt: (...args: unknown[]) => mockRunFileDecrypt(...args) };
});

const { useFileDownload, revokeAllFileUrls } = await import("./use-file-download");
const { DecryptTimeoutError } = await import("./decrypt-queue");

function encryptedVideo(id: string) {
  return {
    id: `$${id}`,
    _key: id,
    roomId: "!room:server",
    senderId: "@u:server",
    content: "clip.mp4",
    timestamp: 1,
    status: "sent",
    type: "video",
    fileInfo: {
      name: "clip.mp4",
      type: "video/mp4",
      size: 100,
      url: "mxc://server/clip",
      secrets: { keys: "k", block: 1, v: 1 },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function plainVideo(id: string) {
  const m = encryptedVideo(id);
  delete m.fileInfo.secrets;
  return m;
}

/** Response streaming `chunks`; `onRead` runs before each chunk is handed out. */
function streamed(chunks: number[], onRead?: (i: number) => void) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === "content-length" ? String(chunks.reduce((a, b) => a + b, 0)) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          onRead?.(i);
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: new Uint8Array(chunks[i++]) };
        },
      }),
    },
  };
}

describe("useFileDownload — progress and deadlines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    revokeAllFileUrls();
    mockPcrypto = {
      rooms: { "!room:server": { decryptKey: async () => "k", decryptFile: vi.fn() } },
    };
  });

  it("a decrypt timeout fails once without re-downloading the file", async () => {
    const fetchMock = vi.fn(async () => streamed([100]));
    vi.stubGlobal("fetch", fetchMock);
    mockRunFileDecrypt.mockRejectedValue(new DecryptTimeoutError(60_000));

    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      const result = await download(encryptedVideo("dt"));

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockRunFileDecrypt).toHaveBeenCalledTimes(1);
      const state = getState("dt");
      expect(state.error).toMatch(/timed out/);
      expect(state.loading).toBe(false);
      // A slow device is not a bug — no auto bug-report modal.
      expect(mockBugReportOpen).not.toHaveBeenCalled();
    });
    scope.stop();
  });

  it("exposes download progress, then the decrypt phase, then clears both", async () => {
    let seen: { phase: unknown; progress: unknown; loaded: unknown }[] = [];
    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      const snap = () => {
        const s = getState("pg");
        seen.push({ phase: s.phase, progress: s.progress, loaded: s.loadedBytes });
      };
      vi.stubGlobal("fetch", vi.fn(async () => streamed([25, 75], snap)));
      mockRunFileDecrypt.mockImplementation(async () => {
        snap();
        return new Blob(["plain"], { type: "video/mp4" });
      });

      seen = [];
      const url = await download(encryptedVideo("pg"));

      expect(url).toBeTruthy();
      expect(seen).toEqual([
        { phase: "download", progress: 0, loaded: 0 },
        { phase: "download", progress: 25, loaded: 25 },
        { phase: "download", progress: 100, loaded: 100 },
        { phase: "decrypt", progress: null, loaded: 0 },
      ]);
      const state = getState("pg");
      expect(state.phase).toBeNull();
      expect(state.progress).toBeNull();
    });
    scope.stop();
  });

  it("a cancelled download resets to idle without an error", async () => {
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
        ac.abort();
      }),
    ));

    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      await download(plainVideo("cx"), ac.signal);

      const state = getState("cx");
      expect(state.error).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.phase).toBeNull();
    });
    scope.stop();
  });

  it("a headers timeout surfaces an error instead of a silent cancel", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      }),
    ));

    const scope = effectScope();
    await scope.run(async () => {
      const { download, getState } = useFileDownload();
      const p = download(plainVideo("hd"));
      // 4 attempts × 30 s headers deadline + 1 + 3 + 6 s backoff.
      await vi.advanceTimersByTimeAsync(4 * 30_000 + 10_000);
      await p;

      const state = getState("hd");
      expect(state.error).not.toBeNull();
      expect(state.errorKind).toBe("network");
    });
    scope.stop();
    vi.useRealTimers();
  });
});
