import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DownloadStalledError,
  fetchBlobWithProgress,
  HttpStatusError,
} from "./fetch-blob-with-progress";

const OPTS = { headersTimeoutMs: 1_000, idleTimeoutMs: 1_000 };

/** A Response whose body hands out `chunks` one per read; `hangAfter` makes
 *  the read after that many chunks never settle until the fetch is aborted. */
function streamingResponse(
  chunks: Uint8Array[],
  init: { contentLength?: number; hangAfter?: number; signal?: AbortSignal } = {},
) {
  let i = 0;
  const reader = {
    read: () => {
      if (init.hangAfter !== undefined && i >= init.hangAfter) {
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: false, value: chunks[i++] });
    },
  };
  const headers = new Map<string, string>();
  if (init.contentLength !== undefined) headers.set("content-length", String(init.contentLength));
  headers.set("content-type", "video/mp4");
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k) ?? null },
    body: { getReader: () => reader },
    blob: () => Promise.reject(new Error("blob() must not be used when a reader exists")),
  };
}

describe("fetchBlobWithProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("assembles the body and reports progress against Content-Length", async () => {
    const chunks = [new Uint8Array(30), new Uint8Array(70)];
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(chunks, { contentLength: 100 })));
    const onProgress = vi.fn();

    const blob = await fetchBlobWithProgress("https://hs/x", { ...OPTS, onProgress });

    expect(blob.size).toBe(100);
    expect(blob.type).toBe("video/mp4");
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      { loaded: 0, total: 100 },
      { loaded: 30, total: 100 },
      { loaded: 100, total: 100 },
    ]);
  });

  it("falls back to the expected size when the server sends no Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse([new Uint8Array(10)])));
    const onProgress = vi.fn();

    await fetchBlobWithProgress("https://hs/x", { ...OPTS, onProgress, expectedSize: 40 });

    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 10, total: 40 });
  });

  it("fails with DownloadStalledError when the body goes silent mid-download", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { signal: AbortSignal }) =>
      streamingResponse([new Uint8Array(10)], { contentLength: 100, hangAfter: 1, signal: init.signal }),
    ));

    const p = fetchBlobWithProgress("https://hs/x", OPTS);
    const assertion = expect(p).rejects.toBeInstanceOf(DownloadStalledError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(p).rejects.toThrow(/timeout/);
  });

  it("fails with DownloadStalledError when headers never arrive", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    ));

    const p = fetchBlobWithProgress("https://hs/x", OPTS);
    const assertion = expect(p).rejects.toMatchObject({ name: "DownloadStalledError", stage: "headers" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("keeps a caller abort as AbortError, not a stall", async () => {
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { signal: AbortSignal }) =>
      streamingResponse([], { hangAfter: 0, signal: init.signal }),
    ));

    const p = fetchBlobWithProgress("https://hs/x", { ...OPTS, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws HttpStatusError with the status for non-2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));

    const p = fetchBlobWithProgress("https://hs/x", OPTS);
    await expect(p).rejects.toBeInstanceOf(HttpStatusError);
    await expect(p).rejects.toMatchObject({ status: 404, message: "Download failed: 404" });
  });

  it("puts no deadline on a body it cannot stream", async () => {
    // Regression: the idle deadline capped the whole blob() read, so a slow
    // but healthy download on such a WebView failed on every retry.
    let finish: (b: Blob) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: () => new Promise<Blob>((r) => { finish = r; }),
    })));

    const p = fetchBlobWithProgress("https://hs/x", OPTS);
    await vi.advanceTimersByTimeAsync(5_000);
    finish(new Blob(["late"]));
    await expect(p).resolves.toBeInstanceOf(Blob);
  });

  it("uses response.blob() when the WebView exposes no readable body", async () => {
    const blob = new Blob(["abc"]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob })));

    await expect(fetchBlobWithProgress("https://hs/x", OPTS)).resolves.toBe(blob);
  });
});
