/**
 * The poster frame that came with an m.video (info.thumbnail_file /
 * thumbnail_url), downloaded and decrypted once per session and shared by
 * every bubble that shows it. Before this, a received video was a grey box
 * until the whole video was downloaded.
 */
import type { Message } from "@/entities/chat";
import { getDecryptedBlobForMessage } from "./use-file-download";

const MAX_ENTRIES = 200;
const cache = new Map<string, Promise<string | null>>();

type PosterSource = Pick<Message, "fileInfo" | "roomId" | "senderId" | "timestamp">;

let fetchBlob: (m: PosterSource) => Promise<Blob | null> = (m) => getDecryptedBlobForMessage(m);

/** Test hook (null restores the real download). */
export function setVideoPosterFetchForTests(fn: ((m: PosterSource) => Promise<Blob | null>) | null): void {
  fetchBlob = fn ?? ((m) => getDecryptedBlobForMessage(m));
  for (const p of cache.values()) void p.then((u) => { if (u) URL.revokeObjectURL(u); });
  cache.clear();
}

/** A blob: URL of the message's video thumbnail, or null (none / failed).
 *  The URL belongs to the cache: callers must not revoke it. */
export function loadVideoPoster(message: PosterSource): Promise<string | null> {
  const thumb = message.fileInfo?.thumbnail;
  if (!thumb?.url) return Promise.resolve(null);
  const key = thumb.url;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const load = (async () => {
    try {
      const blob = await fetchBlob({
        fileInfo: { name: "thumbnail.jpg", type: thumb.mimetype ?? "image/jpeg", size: 0, url: thumb.url, secrets: thumb.secrets },
        roomId: message.roomId,
        senderId: message.senderId,
        timestamp: message.timestamp,
      });
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      // Let a later bubble try again.
      cache.delete(key);
      return null;
    }
  })();
  cache.set(key, load);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    const p = cache.get(oldest);
    cache.delete(oldest);
    void p?.then((u) => { if (u) URL.revokeObjectURL(u); });
  }
  return load;
}
