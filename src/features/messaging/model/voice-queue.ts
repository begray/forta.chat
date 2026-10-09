import type { Message } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { getChatDb, isChatDbReady, localToMessage } from "@/shared/lib/local-db";
import { useFileDownload, pinFileUrl, unpinFileUrl } from "./use-file-download";

/** Where the voice player stands in a chat. The queue keeps only this cursor,
 *  not a snapshot of the following voices: the next one is read from Dexie
 *  when the current one ends, so voices that arrive, get deleted or get
 *  listened elsewhere meanwhile are seen as they are. */
export interface VoiceCursor {
  roomId: string;
  timestamp: number;
  /** Timeline id of the current message (`Message.id` = `eventId ?? clientId`). */
  id: string;
}

/** The next unlistened voice message of the cursor's chat, skipping the
 *  user's own; null at the end of the chain. */
export async function findNextVoice(cursor: VoiceCursor): Promise<Message | null> {
  if (!isChatDbReady()) return null;
  const db = getChatDb();
  const next = await db.messages.getNextAudioAfter(cursor.roomId, cursor, {
    excludeSenderId: useAuthStore().address || undefined,
    clearedAtTs: db.eventWriter.getClearedAtTs(cursor.roomId),
  });
  return next ? localToMessage(next) : null;
}

/** One downloader for the queue. Created outside any effect scope, so it does
 *  not count as a mounted consumer and works with no chat open. */
let downloader: ReturnType<typeof useFileDownload> | null = null;

/** Queue downloads in flight, by cache key. The auto-advance joins the
 *  prefetch of the same file: a second `download()` on the one downloader
 *  would hit its "already loading" guard and get no URL, ending the chain. */
const inflight = new Map<string, Promise<string | null>>();

/** Download and decrypt a voice file; null when it cannot be fetched. Uses the
 *  same cache key as the bubble (`_key || id`), so a prefetched file is a
 *  cache hit for both. Silent: nobody tapped this voice, so a failure must not
 *  pop a toast or a bug report over the current screen. */
export function fetchVoiceUrl(message: Message, signal?: AbortSignal): Promise<string | null> {
  const key = message._key || message.id;
  const running = inflight.get(key);
  if (running) return running;
  const dl = (downloader ??= useFileDownload());
  const promise = (async () => {
    try {
      return (await dl.download(message, signal, { silent: true })) ?? null;
    } finally {
      inflight.delete(key);
      // The URL stays in the shared cache. This instance lives outside any
      // effect scope, so revokes never clear its state — drop it here, or
      // it would hold every decrypted Blob of the session.
      delete dl.states.value[key];
    }
  })();
  inflight.set(key, promise);
  return promise;
}

let prefetch: { key: string | null; controller: AbortController } | null = null;

/** Download the voice after the cursor ahead of time, so the chain does not
 *  pause on fetch and decrypt between messages. Only one is kept: decrypted
 *  bytes live in RAM. Its URL is pinned so a chat switch does not revoke it. */
export function prefetchNextVoice(cursor: VoiceCursor): void {
  cancelPrefetch();
  const entry: { key: string | null; controller: AbortController } = {
    key: null,
    controller: new AbortController(),
  };
  prefetch = entry;
  void (async () => {
    try {
      const next = await findNextVoice(cursor);
      if (!next || entry.controller.signal.aborted) return;
      entry.key = next._key || next.id;
      pinFileUrl(entry.key);
      await fetchVoiceUrl(next, entry.controller.signal);
    } catch (e) {
      console.warn("[voice-queue] prefetch failed:", e);
    }
  })();
}

/** Abort the prefetch and release its pin. */
export function cancelPrefetch(): void {
  if (!prefetch) return;
  prefetch.controller.abort();
  if (prefetch.key) unpinFileUrl(prefetch.key);
  prefetch = null;
}
