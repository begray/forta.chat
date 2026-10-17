# Review guide: media upload reliability + video compression

This fork holds 26 commits on top of upstream `4c4a51e7` (pocketnetteam/forta.chat master,
2026-10-09). They fix photos and videos that break while sending (screen lock, upload loops,
stuck "sending" bubbles, files over the server limit) and add on-phone video compression, a
native gallery picker, proper `m.video` messages and a compact bar for multi-item sends.

The work is split into 7 stacked draft PRs inside this fork. Each PR's base is the previous
PR's branch, so every PR shows only its own commits. Nothing here targets upstream yet.

## Reading order

| PR | Branch | Base |
|---|---|---|
| 1 | `review/01-standby` | `review/base` (= upstream `4c4a51e7`) |
| 2 | `review/02-upload-loop` | `review/01-standby` |
| 3 | `review/03-upload-log` | `review/02-upload-loop` |
| 4 | `review/04-stuck-bubbles` | `review/03-upload-log` |
| 5 | `review/05-size-limit-cancel` | `review/04-stuck-bubbles` |
| 6 | `review/06-video-compression` | `review/05-size-limit-cancel` |
| 7 | `review/07-video-messages-batch` | `review/06-video-compression` |

Read them in this order. Each PR description lists the files to read closely and the ones you
can skim (tests, mocks, i18n).

### 1. Standby: uploads resume after unlock (4 commits)
Startup recovery of stuck media threw a Dexie `SchemaError` in production (no `status` index;
the test hid it with its own index), so it never ran. Uploads that failed while the screen was
locked stayed failed, because Android cuts the network without flipping `navigator.onLine`.
Retry re-read the file from a `blob:` URL that dies when the WebView reloads. The fixes: recovery
uses the `[roomId+status]` index, a `resumeAfterBackground()` hook re-arms failed ops on
foreground, and Retry uses the persisted copy in `attachments.localBlob`. The 4th commit (FCM
guard) only matters for builds without `google-services.json` and is not meant for upstream.

### 2. Upload loop: no more endless re-uploads (1 commit)
The upstream 4-minute upload deadline rejected but never aborted the XHR or Tor upload, so the
retry uploaded the same video next to the old one, and both missed the deadline again. Our own
PR 1 made it unbounded by re-arming on every foreground. Now the deadline aborts and waits for
the upload to settle, grows with the file size, resume only acts after a real background, free
restarts are capped at 2, and a 90 s foreground idle aborts a stuck upload.

### 3. Upload log: diagnostics export (3 commits)
A bounded log of upload events (1500 entries, localStorage, redacted) with Copy/Share under
Settings > About > Diagnostics. It found the bugs fixed in PRs 4-6. It is a field-testing tool,
probably not for upstream as is; later PRs call it, so an upstream split has to strip or keep
those calls.

### 4. Stuck bubbles: atomic send, orphan sweep, visible cancel (4 commits)
Upstream wrote the bubble, the file copy and the upload op as three separate awaits. If the
picked file could not be read, the bubble stayed "sending" forever with no op and no Retry, and
`Promise.allSettled` in MessageInput swallowed the error. Now the three rows are written in one
Dexie transaction after the file has been read, an in-session watchdog fails orphaned bubbles
(with a "file lost" state when the copy is gone too), multi-file sends report errors, and the
cancel X is visible at 0%.

### 5. Size limit, terminal cancel, small media overtake (4 commits)
The server's proxy drops bodies over ~50 MiB with a 502 that carries no CORS header, so the app
saw "network error" after 100% and retried forever. The app now reads `m.upload.size`, refuses
too-large files before sending, and treats a size refusal as terminal. Cancel is terminal (no
retry, no "failed" bubble). A photo of up to 20 MiB may overtake a big upload in the same room
(texts stay strictly FIFO).

### 6. Video compression + native picker (6 commits)
Android-only. A `VideoCompress` Capacitor plugin (Media3 Transformer, H.264/AAC, 720p/480p,
HDR tone-mapped to SDR) re-encodes videos over 15 MiB or over the limit before sending. A
`MediaPicker` plugin on the system photo picker copies small items into app storage right after
the pick and keeps big videos on a persistable `content://` grant, because WebView `File`
handles went `NotReadableError` mid-batch and 14 of 19 items were lost. An encode that failed
while the screen was locked is retried once in the foreground.

### 7. m.video messages + batch bar (4 commits)
Upstream sends gallery videos as `m.file`, so recipients see a grey box with the raw file name
(often a UUID). Videos now go out as `m.video` with size, dimensions, duration, caption and a
JPEG thumbnail. Multi-item sends get one compact bar (current item, "Uploading 3 of 12 · 40%",
per-item cancel, one summary at the end) with at most 2 items in flight. Also adds the
video-compression design notes.

## Build and test locally

Requirements: Node.js 22+, JDK 21 for Gradle, Android SDK (compileSdk 36) for the APK.

```bash
git fetch https://github.com/begray/forta.chat.git review/07-video-messages-batch
git checkout FETCH_HEAD          # or any review/* branch
npm ci
npm run build                    # vue-tsc + vite build (the type gate)
npm run test                     # full vitest suite (run it alone, ~10 min timeout)
npm run test -- src/shared/lib/local-db/__tests__/sync-engine-resume-loop.test.ts   # one file
```

Kotlin unit tests (PRs 6 and 7):

```bash
npm run build && npx cap sync android
cd android && ./gradlew testSideloadDebugUnitTest --tests 'com.forta.chat.plugins.*'
```

Debug APK: `npm run build && npx cap sync android`, then `cd android && ./gradlew assembleSideloadDebug`. Without a
`google-services.json` the build has no push, which is why PR 1 has the FCM guard.

At the tip the suite was 5287/5288 and Kotlin 14/14. The one failure is a known timing flake: `sync-engine-resume-loop`
("hung upload ends as failed" / "past its deadline") fails about 1 run in 2-3 under full-suite
load and passes alone. That test is ours (PR 2) and should be made deterministic before upstream.

## Known risks and open questions

- **Screen off is not device-tested.** The resume logic is unit-tested. One combined test build
  (PR 7 tip) was tried on a Pixel 6a and worked for normal sends, but the "lock the phone in the
  middle of an upload" case has not been checked on a device. Nothing uploads or compresses
  while the screen is off; a foreground service would be needed for that.
- **Media3 version.** `media3Version = '1.10.1'` (Transformer, Effect, Common). It adds ~3 MB to
  the APK and needs compileSdk 36. HEVC, 10-bit HDR, 4K60 and slow-motion input are not
  device-checked.
- **Picker and compression are Android only.** iOS and web keep `<input type=file>` and refuse
  over-limit videos (no compression there).
- **The batch waiting queue is in memory.** If Android kills the app mid-batch, items that have
  not started yet are lost (started ones are in the crash-safe Dexie queue).
- **Upstream master has moved on since `4c4a51e7`.** Every upstream PR needs a rebase first, and
  `use-messages.ts` / `sync-engine.ts` are the likely conflict spots.
- The size-limit heuristics are tuned to pocketnet's server (a 502 or network error after the
  full body of a file of 45 MiB or more counts as "too large").
- `m.video` thumbnails in encrypted rooms use Bastyon secrets in `info.thumbnail_file`, not
  Matrix AES `EncryptedFile`. Store-build recipients get the length badge but no poster until
  they tap.
- Attachment blobs (and now video thumbnails) are still never deleted from IndexedDB (upstream
  storage leak, not fixed here).
- Tor uploads still cannot be aborted natively; the deadline only stops waiting for them.

## How to comment

Comment on lines in the PRs ("Files changed" tab, `+` on a line), or leave a general comment on
the PR. Use "Start a review" to batch comments, then "Comment" or "Request changes". Questions
about the overall split go on the "Start here" PR that adds this file.
