# Media uploads break when the phone goes to standby

Report: sending many photos/videos, the screen locks mid-upload, the uploads
break and Retry does nothing.

Line numbers below refer to the base commit `4c4a51e7` (master, 2026-10-09).

## Pipeline

pick → `sendImage` / `sendFile` / `sendAudio` / `sendVideoCircle`
(`features/messaging/model/use-messages.ts`) → optimistic row in `messages`
(`localBlobUrl` = `blob:` URL) + the File persisted in `attachments.localBlob`
+ `send_file` op in `pendingOps` → `SyncEngine.syncSendFile`
(`shared/lib/local-db/sync-engine.ts`: encrypt → upload with 3 in-attempt
retries → send event → `confirmMediaSent`) → on failure op backoff, after
`maxRetries` (5) op and message become `failed` → bubble shows Retry
(`MessageBubble.vue`) → `retryMediaUpload`.

The queue itself is persistent and crash-safe (stranded `syncing` ops are
recovered on start). The breakage is around it.

## Root causes

1. **Retry reads the file from a dead `blob:` URL.**
   `use-messages.ts:1808-1841` — `retryMediaUpload` ignores the queued
   `send_file` op and the persisted `attachments.localBlob`, and runs its own
   pipeline on `fetch(localMsg.localBlobUrl)`. Android reloads/kills the
   WebView of a backgrounded app (likely with a big photo/video batch in
   memory), which invalidates every `blob:` URL; the fetch fails and Retry
   returns silently (`console.error` only, line 1839). It also returned
   silently when Matrix was not ready yet (line 1814), i.e. right after resume.

2. **Nothing re-arms uploads that failed while the phone slept.**
   While the screen is locked Android cuts the network (Doze) without flipping
   `navigator.onLine`. Queued ops burn their retries (`sync-engine.ts:685`) and
   land in `failed`. Failed ops are only re-armed by `setOnline` on an
   offline→online edge or the first online signal (`sync-engine.ts:247-271`),
   which never happens here — the app subscribes only to connectivity
   (`stores.ts:612`), not to app resume. `retryAllFailed` (`:1351`) also left
   the messages themselves in `failed`.

3. **Uploads hang after unlock.** A socket dropped during Doze often neither
   progresses nor errors; the upload then waits out `MEDIA_UPLOAD_TIMEOUT_MS`
   (4 min, `sync-engine.ts:73`) with a frozen progress ring.

4. **Startup recovery never ran.** `recoverStuckMedia` / `cleanupCancelledUploads`
   (`message-repository.ts:738-757`) query `where("status")`, but `messages`
   has no standalone `status` index (`schema.ts:885`), so Dexie throws
   `SchemaError` and the call is swallowed (`local-db/index.ts:241-245`). The
   unit test hid it by adding a `status` index to its own schema. Had it run, it
   would also have flipped media whose upload was still queued to `failed`.

5. Image / video / video-note bubbles in `failed` had Retry but no Cancel
   (`MessageBubble.vue:1015,1081,1227`); only file/audio bubbles had both.

## Fix

- `SyncEngine.resumeAfterBackground()` — wired to app foreground
  (`onForeground`: `visibilitychange` + Capacitor `appStateChange`) next to the
  connectivity subscription in `stores.ts`. Aborts uploads with no progress for
  15 s and restarts them without counting a retry, then `retryAllFailed()`.
  Debounced (both signals fire on one resume); no-op while offline.
- `retryAllFailed` now also moves the messages back to `pending`.
- `SyncEngine.retryMediaOperation(clientId)` — Retry re-arms the queued
  `send_file` op, which uploads from `attachments.localBlob`.
- `retryMediaUpload` uses it first; without an op it rebuilds the send from
  the persisted blob (blob URL only as a last resort) and reports
  `errors.send.uploadFailed` instead of returning silently.
- `recoverStuckMedia` / `cleanupCancelledUploads` query via the
  `[roomId+status]` index; messages with a live op are not failed; dead
  `blob:` previews of unsent media are re-minted from the persisted blob.
- Cancel button on failed image / video / video-note overlays.

Tests: `local-db/__tests__/sync-engine-background-resume.test.ts`,
`local-db/__tests__/recover-stuck-media.test.ts` (schema now mirrors
production), `messaging/model/__tests__/retry-media-upload.test.ts`.
