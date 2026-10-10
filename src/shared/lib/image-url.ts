/**
 * Centralized image URL normalization for Pocketnet/Bastyon images.
 *
 * Archived peertube hosts are listed by the proxy; when a URL points to one of
 * those hosts, we rewrite it to the archive CDN (same idea as pocketnet
 * `replaceArchiveInImage`).
 */

import { shallowRef } from "vue";

const ARCHIVE_HOST = "peertube.archive.pocketnet.app";
const BASTYON_IMAGES_BASE = "https://bastyon.com/images/";

/** Last list the proxy returned, with the time it arrived. Survives restarts
 *  so avatars on archived hosts render right from the first frame, and an
 *  unreachable proxy (offline, blocked) falls back to the old list. */
const STORAGE_KEY = "archived_peertube_servers";
/** The list changes rarely: within this age the proxy is not asked again. */
export const ARCHIVED_SERVERS_TTL_MS = 2 * 24 * 60 * 60 * 1000;

interface StoredServers {
  servers: string[];
  at: number;
}

function readStored(): StoredServers | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<StoredServers> | null;
    if (!p || !Array.isArray(p.servers) || typeof p.at !== "number") return null;
    const servers = p.servers.filter((s): s is string => typeof s === "string" && s.length > 0);
    return servers.length > 0 ? { servers, at: p.at } : null;
  } catch {
    return null;
  }
}

// Reactive: the list arrives after the first avatars render, and computed URLs
// built from it must re-run then, or they keep pointing at the dead host.
const archivedServers = shallowRef<readonly string[]>(readStored()?.servers ?? []);

/** Replace the list of archived peertube server hostnames; a non-empty list
 *  is also stored for the next start. */
export function setArchivedPeertubeServers(servers: string[], now = Date.now()): void {
  archivedServers.value = servers;
  if (servers.length === 0) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ servers, at: now }));
  } catch {
    /* storage blocked — the list is just asked again next start */
  }
}

/** Read-only access to the current list (tests / debugging). */
export function getArchivedPeertubeServers(): readonly string[] {
  return archivedServers.value;
}

/** True when the stored list is younger than the TTL, so no request is needed. */
export function hasFreshArchivedPeertubeServers(now = Date.now()): boolean {
  const stored = readStored();
  return !!stored && now - stored.at >= 0 && now - stored.at < ARCHIVED_SERVERS_TTL_MS;
}

/**
 * Normalize a Pocketnet image URL: relative ids → bastyon images base,
 * archived peertube hosts → archive CDN, known host/protocol fixups.
 */
export function normalizePocketnetImageUrl(src: string | undefined | null): string {
  if (!src) return "";

  let url = src;

  if (!url.startsWith("http") && !url.startsWith("data:") && !url.startsWith("blob:")) {
    url = BASTYON_IMAGES_BASE + url;
  }

  for (const server of archivedServers.value) {
    if (url.includes(server)) {
      url = url.replace(server, ARCHIVE_HOST);
    }
  }

  url = url
    .replace("bastyon.com:8092", "pocketnet.app:8092")
    .replace("test.pocketnet", "pocketnet")
    .replace("https://http://", "http://");

  return url;
}

/**
 * Fetch archived peertube server hostnames from the proxy.
 * GET {proxyBaseUrl}/peertubeserversList
 * Response: { result: "success", data: { archivedPeertubeServers: string[] } }
 */
export async function loadArchivedPeertubeServers(proxyBaseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${proxyBaseUrl}/peertubeserversList`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn("[image-url] Failed to load peertube servers list:", response.status);
      return [];
    }

    const json = await response.json();
    const servers: string[] = json?.data?.archivedPeertubeServers ?? [];

    if (Array.isArray(servers) && servers.length > 0) {
      setArchivedPeertubeServers(servers);
      console.log(`[image-url] Loaded ${servers.length} archived peertube servers`);
      return servers;
    }

    return [];
  } catch (e) {
    console.warn("[image-url] Could not load peertube servers list:", e);
    return [];
  }
}
