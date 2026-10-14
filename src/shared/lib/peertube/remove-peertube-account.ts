/**
 * Account deletion, PeerTube step — same flow as Pocketnet
 * (`satolist.js` deleteaccount → removePeertube, `js/peertube.js`):
 * on every video server, log in with a blockchain signature
 * (`oauth-clients/local` → `users/blockChainAuth` → `users/token`) and send
 * `DELETE api/v1/users/{id}`. Best effort: a dead host or a refusal never
 * stops the deletion, so every failure resolves.
 *
 * Pocketnet passes `id: address.address` there, which is `undefined` (the
 * address is a string); the account address is what it means to send.
 */

/** Signature object from `POCKETNETINSTANCE.user.signature(session)`. */
export interface PeertubeSignature {
  nonce: string;
  signature: string;
  pubkey: string;
  address: string;
  v: number;
}

export interface RemovePeertubeAccountOptions {
  hosts: string[];
  address: string;
  /** Signs for the `peertube` session, as Pocketnet's `app.user.signature('peertube')`. */
  sign: () => PeertubeSignature;
  /** Bound for each host's whole login + delete sequence. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const form = (data: Record<string, string | number | boolean>): string =>
  new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)])).toString();

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

async function readJson(res: Response, step: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${step}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function removeOnHost(
  host: string,
  opts: Required<Omit<RemovePeertubeAccountOptions, "hosts">>,
  signal: AbortSignal,
): Promise<void> {
  const base = `https://${host}/api/v1`;
  const f = opts.fetchImpl;

  const client = await readJson(await f(`${base}/oauth-clients/local`, { signal }), "oauthClientsLocal");
  if (!client.client_id || !client.client_secret) throw new Error("oauthClientsLocal: no client");

  const auth = await readJson(
    await f(`${base}/users/blockChainAuth`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ ...opts.sign() }),
      signal,
    }),
    "pocketnetAuth",
  );
  if (!auth.externalAuthToken || !auth.username) throw new Error("pocketnetAuth: no token");

  const token = await readJson(
    await f(`${base}/users/token`, {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({
        client_id: String(client.client_id),
        client_secret: String(client.client_secret),
        externalAuthToken: String(auth.externalAuthToken),
        username: String(auth.username),
        isNewUser: Boolean(auth.isNewUser),
        response_type: "code",
        grant_type: "password",
      }),
      signal,
    }),
    "getToken",
  );
  if (!token.access_token) throw new Error("getToken: no access token");

  const res = await f(`${base}/users/${encodeURIComponent(opts.address)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${String(token.access_token)}` },
    signal,
  });
  if (!res.ok) throw new Error(`removeAccount: HTTP ${res.status}`);
}

/** Runs on all hosts in parallel; resolves with the hosts that confirmed the delete. */
export async function removePeertubeAccount(options: RemovePeertubeAccountOptions): Promise<string[]> {
  const opts = {
    address: options.address,
    sign: options.sign,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const hosts = [...new Set(options.hosts.filter(Boolean))];
  const removed: string[] = [];
  await Promise.all(
    hosts.map(async (host) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        await removeOnHost(host, opts, controller.signal);
        removed.push(host);
      } catch (e) {
        console.warn(`[peertube] account removal on ${host} failed:`, e);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return removed;
}

/** Flattens Pocketnet's `peertube/allservers` answer: `{ "0": [hosts], "1": [hosts], … }`. */
export function flattenPeertubeServers(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const hosts: string[] = [];
  for (const group of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(group)) for (const h of group) if (typeof h === "string" && h) hosts.push(h);
  }
  return [...new Set(hosts)];
}
