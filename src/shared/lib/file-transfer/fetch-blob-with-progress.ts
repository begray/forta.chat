/** Bytes received so far. `total` is 0 when neither Content-Length nor the
 *  caller's expected size is known — the consumer shows an indeterminate state. */
export interface TransferProgress {
  loaded: number;
  total: number;
}

/** Our own deadline fired: no response headers, or no body bytes for too long.
 *  The message carries "timeout" so the media download path classifies it as a
 *  transient network failure (retry, then MediaUnavailableError) instead of
 *  confusing it with a user cancel, which is a bare AbortError. */
export class DownloadStalledError extends Error {
  constructor(public readonly stage: "headers" | "body", ms: number) {
    super(`Download timeout: no ${stage === "headers" ? "response" : "data"} for ${ms}ms`);
    this.name = "DownloadStalledError";
  }
}

export interface FetchBlobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  /** Size to report against when the server sends no Content-Length. */
  expectedSize?: number;
  /** Deadline for the response headers. */
  headersTimeoutMs: number;
  /** Deadline between two body chunks — a connection that stays open with
   *  no data (MIUI, Tor) fails here instead of spinning forever. */
  idleTimeoutMs: number;
}

/** Error carrying the HTTP status so callers can skip retries on 4xx. */
export class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`Download failed: ${status}`);
    this.name = "HttpStatusError";
  }
}

/**
 * Fetch `url` into a Blob, reporting progress and failing on stalls.
 *
 * One AbortController covers the headers and the whole body, so a connection
 * that delivers headers and then goes silent is torn down too. WebViews without
 * a readable `response.body` fall back to `response.blob()` with no body
 * deadline and no progress.
 */
export async function fetchBlobWithProgress(url: string, opts: FetchBlobOptions): Promise<Blob> {
  const ac = new AbortController();
  // Held in an object: TS would narrow a plain `let` to null at the catch.
  const deadline: { stalled: DownloadStalledError | null } = { stalled: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (stage: "headers" | "body", ms: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      deadline.stalled = new DownloadStalledError(stage, ms);
      ac.abort();
    }, ms);
  };
  const abortOuter = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", abortOuter, { once: true });
  }

  try {
    arm("headers", opts.headersTimeoutMs);
    const response = await fetch(url, { signal: ac.signal });
    if (!response.ok) throw new HttpStatusError(response.status);

    arm("body", opts.idleTimeoutMs);
    const lengthHeader = Number(response.headers?.get?.("content-length") ?? 0);
    const total = lengthHeader > 0 ? lengthHeader : opts.expectedSize ?? 0;
    const reader = response.body?.getReader?.();
    if (!reader) {
      // No stream means no way to tell a slow body from a dead one; a fixed
      // deadline here would cap the whole download, so wait as before.
      if (timer !== null) clearTimeout(timer);
      return await response.blob();
    }

    const chunks: BlobPart[] = [];
    let loaded = 0;
    opts.onProgress?.({ loaded, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm("body", opts.idleTimeoutMs);
      chunks.push(value as Uint8Array<ArrayBuffer>);
      loaded += value.byteLength;
      opts.onProgress?.({ loaded, total: Math.max(total, loaded) });
    }
    const type = response.headers?.get?.("content-type") ?? "";
    return new Blob(chunks, type ? { type } : undefined);
  } catch (e) {
    if (deadline.stalled) throw deadline.stalled;
    throw e;
  } finally {
    if (timer !== null) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortOuter);
  }
}
