// @vitest-environment node
/**
 * public/service-worker.js ships as-is, so it runs here in a vm context with
 * the scripts it imports stubbed and Node's own Request/Response.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SW_SOURCE = readFileSync(resolve(process.cwd(), "public/service-worker.js"), "utf8");
const TOR_PROXY = "http://127.0.0.1:8181/";

interface FetchEventStub {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
}
type ProxyInit = RequestInit & { duplex?: string };
interface FetchCall {
  input: RequestInfo | URL;
  init?: ProxyInit;
}

interface NetworkStatsEvent {
  status: string;
  url: string;
  bytesLength?: number;
}

function loadCapacitorWorker(torActive: boolean, respond: () => Response = () => new Response("{}", { status: 200 })) {
  const listeners = new Map<string, (event: FetchEventStub) => void>();
  const calls: FetchCall[] = [];
  const stats: NetworkStatsEvent[] = [];

  // Chrome refuses a streaming request body without `duplex` — the TypeError
  // the Samsung logged for every Tor-routed request that carried a body.
  const fetchLikeChrome = async (input: RequestInfo | URL, init?: ProxyInit): Promise<Response> => {
    if (init?.body instanceof ReadableStream && !init.duplex) {
      throw new TypeError(
        "Failed to execute 'fetch': The `duplex` member must be specified for a request with a streaming body",
      );
    }
    calls.push({ input, init });
    return respond();
  };

  class Broadcaster {
    async invoke(): Promise<boolean> {
      return torActive;
    }
    send(channel: string, payload: NetworkStatsEvent): void {
      if (channel === "network-stats") stats.push(payload);
    }
  }

  const context = createContext({
    importScripts: () => undefined,
    Broadcaster,
    location: "https://localhost/service-worker.js?platform=capacitor&appVersion=test",
    URL,
    Response,
    fetch: fetchLikeChrome,
    console,
    self: {
      addEventListener: (type: string, listener: (event: FetchEventStub) => void) => {
        listeners.set(type, listener);
      },
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    },
  });
  runInContext(SW_SOURCE, context);

  const onFetch = listeners.get("fetch");
  if (!onFetch) throw new Error("the worker registered no fetch listener");

  const dispatch = (request: Request): Promise<Response> =>
    new Promise((resolveResponse, rejectResponse) => {
      onFetch({
        request,
        respondWith: (response) => {
          response.then(resolveResponse, rejectResponse);
        },
      });
    });

  /** Whether the worker answered the request at all (called respondWith). */
  const answers = (request: Request): boolean => {
    let answered = false;
    onFetch({ request, respondWith: () => { answered = true; } });
    return answered;
  };

  return { dispatch, answers, calls, stats };
}

describe("service worker on Capacitor, Tor route", () => {
  it("sends a request body through the Tor proxy as bytes, not as a stream", async () => {
    const { dispatch, calls } = loadCapacitorWorker(true);
    const url = "https://matrix.pocketnet.app/_matrix/client/v3/rooms/r1/send/m.room.message/t1";
    const payload = JSON.stringify({ msgtype: "m.text", body: "hello" });

    const response = await dispatch(new Request(url, { method: "PUT", body: payload }));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe(TOR_PROXY + encodeURIComponent(url));
    expect(calls[0].init?.method).toBe("PUT");
    expect(new TextDecoder().decode(calls[0].init?.body as ArrayBuffer)).toBe(payload);
  });

  it("sends a GET through the Tor proxy without a body", async () => {
    const { dispatch, calls } = loadCapacitorWorker(true);
    const url = "https://1.pocketnet.app:8899/ping";

    const response = await dispatch(new Request(url));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe(TOR_PROXY + encodeURIComponent(url));
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("lets a request Tor does not claim go out directly, untouched", async () => {
    const { dispatch, calls } = loadCapacitorWorker(false);
    const request = new Request("https://1.pocketnet.app:8899/rpc/getnodeinfo", {
      method: "POST",
      body: "{}",
    });

    const response = await dispatch(request);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(request);
  });

  // The page flags an upload it already knows goes direct, so the XHR keeps
  // its upload progress (respondWith hides it).
  it("does not answer a flagged direct upload", () => {
    const { answers, calls } = loadCapacitorWorker(false);
    const upload = "https://matrix.pocketnet.app/_matrix/media/v3/upload";

    expect(answers(new Request(`${upload}?forta_direct=1`, { method: "POST", body: "x" }))).toBe(false);
    expect(answers(new Request(upload, { method: "POST", body: "x" }))).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

/** A body that sends `head` and then stays open until `finish` is called —
 *  a large media file still on the wire. */
function slowBody(head: Uint8Array) {
  let finish: (tail: Uint8Array) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
      finish = (tail) => {
        controller.enqueue(tail);
        controller.close();
      };
    },
  });
  return { stream, finish: (tail: Uint8Array) => finish(tail) };
}

describe("service worker, response body", () => {
  // A 17 MB video reached the page only once the worker had buffered all of
  // it for the stats: no download progress, and the page's 30 s headers
  // deadline fired on every retry.
  it("answers the page on headers, before the body has arrived", async () => {
    const body = slowBody(new Uint8Array(3));
    const { dispatch, stats } = loadCapacitorWorker(false, () => new Response(body.stream, { status: 200 }));
    const url = "https://matrix.pocketnet.app/_matrix/media/v3/download/matrix.pocketnet.app/abc";

    const response = await dispatch(new Request(url));

    expect(response.status).toBe(200);
    expect(stats).toHaveLength(0);

    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(3);
    body.finish(new Uint8Array(5));
    expect((await reader.read()).value?.byteLength).toBe(5);
    expect((await reader.read()).done).toBe(true);

    await vi.waitFor(() => expect(stats).toHaveLength(1));
    expect(stats[0]).toMatchObject({ status: "success", url, bytesLength: 8 });
  });

  it("takes the stats size from Content-Length without reading the body", async () => {
    const body = slowBody(new Uint8Array(3));
    const { dispatch, stats } = loadCapacitorWorker(true, () => new Response(body.stream, {
      status: 200,
      headers: { "content-length": "17445368" },
    }));

    await dispatch(new Request("https://matrix.pocketnet.app/_matrix/media/v3/download/x/y"));

    await vi.waitFor(() => expect(stats).toHaveLength(1));
    expect(stats[0]).toMatchObject({ status: "success", bytesLength: 17445368 });
  });
});
