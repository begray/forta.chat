import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { removePeertubeAccount, flattenPeertubeServers } from "./remove-peertube-account";

const SIG = { nonce: "n", signature: "s", pubkey: "p", address: "PAddr", v: 1 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function happyFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth-clients/local")) return json({ client_id: "cid", client_secret: "csec" });
    if (url.endsWith("/users/blockChainAuth")) return json({ externalAuthToken: "ext", username: "paddr" });
    if (url.endsWith("/users/token")) return json({ access_token: "tok", refresh_token: "r", expires_in: 1 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 404);
  });
}

describe("removePeertubeAccount (Pocketnet removePeertube)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs in with the blockchain signature and deletes the account on each host", async () => {
    const fetchImpl = happyFetch();
    const sign = vi.fn(() => SIG);
    const removed = await removePeertubeAccount({
      hosts: ["a.example", "a.example", "b.example"],
      address: "PAddr",
      sign,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(removed.sort()).toEqual(["a.example", "b.example"]);
    const forA = fetchImpl.mock.calls.filter(([u]) => String(u).startsWith("https://a.example/"));
    expect(forA.map(([u]) => u)).toEqual([
      "https://a.example/api/v1/oauth-clients/local",
      "https://a.example/api/v1/users/blockChainAuth",
      "https://a.example/api/v1/users/token",
      "https://a.example/api/v1/users/PAddr",
    ]);
    expect(new URLSearchParams(String(forA[1][1]?.body)).get("signature")).toBe("s");
    const tokenBody = new URLSearchParams(String(forA[2][1]?.body));
    expect(tokenBody.get("client_id")).toBe("cid");
    expect(tokenBody.get("externalAuthToken")).toBe("ext");
    expect(tokenBody.get("grant_type")).toBe("password");
    expect(forA[3][1]).toMatchObject({ method: "DELETE", headers: { Authorization: "Bearer tok" } });
  });

  it("never throws: a failing host is skipped, the others still run", async () => {
    const ok = happyFetch();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://dead.example/")) throw new TypeError("Failed to fetch");
      return ok(url, init);
    });
    const removed = await removePeertubeAccount({
      hosts: ["dead.example", "b.example"],
      address: "PAddr",
      sign: () => SIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(removed).toEqual(["b.example"]);
  });

  it("gives up on a host that hangs after the timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = removePeertubeAccount({
      hosts: ["slow.example"],
      address: "PAddr",
      sign: () => SIG,
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual([]);
  });
});

describe("flattenPeertubeServers", () => {
  it("flattens and deduplicates the peertube/allservers groups", () => {
    expect(flattenPeertubeServers({ "0": ["a", "arch"], "1": ["b", "arch"], "2": "junk" })).toEqual(["a", "arch", "b"]);
    expect(flattenPeertubeServers(null)).toEqual([]);
  });
});
