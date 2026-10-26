# FortaChat: media uploads with the screen off (Android)

Date: 2026-10-17. Status: implemented, not yet verified on a device.

## 1. The problem
Field logs from a Pixel 6a (Android 17) showed the same pattern every time:

- `app:background uploads=1` at 75 %, the phone locked for ~5 minutes, then on unlock
  `upload:try-fail sent=46947125 network error` and `upload:try n=2` from byte 0.
- A short background (11 s) did not break the upload. A Doze window of minutes always did.

The upload is an XHR in the WebView (or a native Tor transfer). Once the screen is off, Android
puts the backgrounded app into Doze. Its network access is cut, and the socket dies. The error is
only delivered on resume. The resume restart (docs/media-upload-standby.md) then sends the whole
file again. The video encoder has the same issue: it waits for the foreground before retrying.

## 2. What we do
A small keep-alive **foreground service** runs while any media send is in progress. It shows an
ongoing notification:

    Sending 3 of 12 · 40%
    Uploading                                   [Cancel]

The service does no uploading of its own. It keeps the process at foreground-service priority. That
keeps network access in Doze, and the WebView XHRs, the Tor transfer and the Media3 encoder keep
running. It also holds a partial wake lock (and a Wi-Fi lock below Android 14), but only while
there is work.

### Pieces
- `android/.../plugins/backgroundupload/BackgroundUploadService.kt`: the `dataSync` foreground
  service. It holds the notification, the wake/Wi-Fi locks, the idle cap, `onTimeout` and a
  15 s heartbeat.
- `.../BackgroundUploadPlugin.kt`: the Capacitor bridge. Methods: `start` / `update` / `stop`,
  plus the notification permission. Events: `cancelAll`, `heartbeat` and `stopped {reason}`.
- `.../KeepAliveState.kt`: pure bookkeeping (what counts as progress, when it is idle), unit
  tested.
- `src/shared/lib/background-transfer/`: the JS coordinator. It decides when to start, update and
  stop, composes the translated notification text, and writes the `fgs:*` upload-log events.
  iOS/web get a no-op plugin.
- `src/features/messaging/model/background-upload.ts`: feeds the coordinator from the send
  pipeline (wired in the auth store next to the SyncEngine connectivity hooks).

### When it runs
Several parts of the pipeline report what they are working on, each keyed by the message
clientId:

| source     | what                                                                      |
|------------|---------------------------------------------------------------------------|
| `send`     | a `sendFile`/`sendImage` call, from compression until the item is queued   |
| `compress` | video compression jobs                                                    |
| `batch`    | batch items not sent yet (queued ones have no op)                         |
| `engine`   | the SyncEngine's unfinished `send_file` ops (pending, running, in backoff), with upload percent |

An item is active while any source holds it, so hand-offs (compressor → queue) never look like
"all done". The engine reports from the queue table itself (`setMediaWorkListener`), not from
outcome hooks, so no failure path can leave an item reported. Failed ops (waiting for the user's
Retry) do not count.

- **Start**: once work has been active for 1 s (a photo that sends within a second never
  flashes a notification), or immediately when the page is hidden with work pending. Android 12+
  only allows the start while the app is visible, so the start happens at send time, in the
  foreground. A refused start is logged as `fgs:denied`. The old resume-on-unlock restart still
  covers that upload, and the start is retried the next time the app is visible.
- **Update**: at most once a second, only when the text or percent changed.
- **Stop**: 2 s after the last item finished (a new item within the grace keeps the same
  service), on logout, or when the activity is destroyed (the WebView doing the uploads is gone).
- **On its own** (`stopped` event → `fgs:stop reason=…` / `fgs:timeout`):
  - `idle`: the notice has not changed for 30 min (stuck or offline). The wake lock is renewed
    on progress and auto-expires 5 min after the idle cap, so a leak cannot hold the CPU.
  - `timeout`: Android 15+ `onTimeout` (the dataSync time limit). The service stops at once, as
    required, and uploads fall back to resume-on-unlock.
  - `start-failed` / `system`.
- **Cancel** (notification action) → JS `cancelAllMedia`: every open batch item in every room,
  every single send, and a single video still compressing. If the composer never configured its
  cancel (only recovered queue items after a restart), the engine's `cancelMediaUpload` is used.
  The bubble is then caught by the orphan sweep as failed (Retry/Delete).
- **Heartbeat**: Chromium throttles timers in a hidden page (to once a second; Chrome goes down to
  once a minute for chained timers after 5 minutes hidden, and the WebView may do the same). The batch runner's ticker and the queue's retry wake-ups are timers. Every
  15 s the service sends `heartbeat`, which runs the batch tick and `processQueue()`. Event delivery
  is a task posted by `evaluateJavascript`, not a timer, so it is not throttled.

### WebView timers and Capacitor
`BridgeActivity.onPause` → `Bridge.onPause` → `MockCordovaWebViewImpl.handlePause(keepRunning)`.
This only pauses the WebView (`webView.onPause()` + `pauseTimers()`) when the `KeepRunning`
preference is false. It defaults to true (`Bridge.shouldKeepRunning`), and the app does not set
it. So Capacitor does not freeze JS. The page becomes hidden, and Chromium's own background
throttling applies, which the heartbeat covers. Network activity (XHR progress events) is not
throttled.

### Permissions
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC`: already declared (ModelDownloadService
  and AiInferenceForegroundService use `dataSync`). `WAKE_LOCK`: already declared.
- `POST_NOTIFICATIONS` (Android 13+): asked once (localStorage flag) at the first "big" send, which
  means 2+ items or a video that needs compressing. Login already asks for it on builds with push.
  If it is denied, the service still runs and Android only hides the notification (it stays
  listed in the task manager). The result is logged as `fgs:notif`.

## 3. Why a `dataSync` foreground service and not a user-initiated data transfer job
Android 14 added user-initiated data transfer (UIDT) jobs: `JobInfo.Builder.setUserInitiated(true)`
plus the `RUN_USER_INITIATED_JOBS` permission. They are meant for exactly "the user tapped send".
They are not subject to the dataSync 6 h/day quota, and Play prefers them for new transfer
features. We still chose the foreground service:

1. **The work is not in the job.** A UIDT job is expected to do the transfer in its `JobService`.
   Here the transfer runs in the WebView (and in Tor/Media3 plugins). A job would only be a
   keep-alive with a network constraint. When the network constraint drops (Wi-Fi ↔ cellular
   handover, a short outage), the system calls `onStopJob`, and we would have to reschedule. That
   is only allowed again from the foreground.
2. **minSdk 24.** UIDT exists only on Android 14+. Android 8-13 would still need the foreground
   service, so we would ship and test two mechanisms.
3. **Precedent and permissions.** The app already runs two `dataSync` services with the same
   permission set. UIDT would add a new permission and a Play declaration.
4. **The quota does not matter here.** Media sends take minutes, not hours. The 6 h/day
   dataSync budget (shared with the model download and local-AI services) is far away. When it
   is hit, `onTimeout` stops us cleanly, and uploads behave as before this change.

`shortService` (3 min cap) is too short for a batch of videos.

If Play policy ever requires it, the native side can be swapped for a UIDT job behind the same
JS contract (`start`/`update`/`stop`/events).

## 4. Limits
- **Not verified on a device yet.** Doze behaviour, OEM battery savers and Android 17 changes
  can only be checked on the phone (docs/manual-verification.md).
- Android 15+: 6 h of `dataSync` per 24 h for the whole app. After that, starts are refused
  (`fgs:denied`) and a running service gets `onTimeout` (`fgs:timeout`).
- The user can stop the app from the task manager or swipe the notification away (Android 14+).
  Swiping only hides the notification. "Stop" in the task manager kills the process. Uploads then
  resume on the next app start (the queue is persisted), from byte 0.
- An upload whose socket already died is still restarted from byte 0. There is no resumable
  upload on the server side (audit R4).
- Queued batch items that have not started yet are in memory only. If Android kills the process
  anyway, they have to be picked again (unchanged from before).
- iOS: no-op. It would need a URLSession background upload, which is a different design.

## 5. Upload log events
`fgs:start {items, visible}`, `fgs:denied {error, visible}`, `fgs:stop {reason: done|idle|start-failed|system, n}`,
`fgs:timeout {items}`, `fgs:cancel {items}`, `fgs:cancel-failed`, `fgs:notif {state, asked}`,
`fgs:unavailable {reason, items}` (once, Android without the plugin: a log with sends and no
`fgs:start` then says why).

The log header names the build: `app: <versionName> (versionCode N, commit abcdef12)`. The commit
comes from `VITE_BUILD_COMMIT` at `npm run build` time (e.g.
`VITE_BUILD_COMMIT=$(git rev-parse --short=8 HEAD) npm run build`); without it the header has
the version name and versionCode only.

## 6. Media shared from another app
Media shared into Forta (Android share sheet → Forta → chat → Send) goes through the same path
as a gallery pick (`features/messaging/model/share-send.ts`):
- The keep-alive needs nothing extra: it follows the SyncEngine queue, the batch and the send
  calls, whatever the entry point (also media forwards and a Retry after a restart).
- Send takes the share off the composer before the first slow step and claims it. Before, the
  composer kept the share and an enabled Send until the last file was through (one at a time, ~5 s
  of image preparation before the first bubble), and a second tap sent the whole share again
  (field log 2026-10-26: 11 items, 22 sends). Upstream has the same code.
- The share intent itself is keyed by its files and text (`shareKeyOf`): the same intent again
  within 15 s, while it is being sent, or within 15 s after, is dropped (`share:repeat`). The capgo
  plugin delivers the launch intent from `load()` and from `onNewIntent`, and a re-created
  Activity hands over the same intent again.
- The plugin's copies in `cache/shared_files` become sourced Files (kind `share`): read natively
  when each send runs, opened by the video compressor directly (`compress:start src=share`, no
  copy through the WebView), deleted once no send holds them.
- Log: `share:received {n, text}`, `share:repeat {n}`, `share:dup {n}` (a second Send),
  `pick:share {n, src: share, native, memory, unreadable}`, then the usual `batch:*` for 2+ items.
