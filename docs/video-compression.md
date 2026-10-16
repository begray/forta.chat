# FortaChat: compressing phone videos to fit the 50 MB upload limit (Android)

Date: 2026-10-15. Design note only, no code. Context: the standbyfix4 field log showed 52.8 MB and
92.8 MB Pixel 6a videos failing after a full upload. pocketnet's media repo drops bodies over
~50 MiB (nginx 502 without CORS). standbyfix5 refuses such files up front ("Video is 92.8 MB; the
limit is 52 MB"). This note covers how to *send* them anyway.

## 0. The cheapest option: raise the server limit
Two settings decide it: `max_upload_size` in Synapse (reported as `m.upload.size`) and
`client_max_body_size`/proxy timeouts in nginx. If pocketnet raises both to 200-500 MB,
nothing needs to change on the client. standbyfix5 reads `m.upload.size` and follows it,
capped at the app's 100 MB. Ask the pocketnet team first. Even then, compression is still
worth doing: 100+ MB over mobile data is slow, costly and fragile (no resumable upload,
audit R8).

## 1. How big phone videos are
- Pixel 6a default camera: 1080p30 H.264/HEVC at about 16-20 Mbit/s, so **~2.2 MB per
  second**. 50 MB is about 22 s of 1080p; 4K30 (~45-50 Mbit/s) is about 8 s.
- Messenger-grade targets:
  - 720p H.264 at 2.0-2.5 Mbit/s + AAC 96-128 kbit/s is ~18 MB/min, so **~2.5 min per 50 MB**.
    That is roughly what WhatsApp/Telegram send by default, and it looks fine on a phone screen.
  - 480p at 1.0-1.2 Mbit/s is ~9 MB/min (~5 min per 50 MB), visibly soft on a tablet.
  - 1080p at 4-5 Mbit/s is ~35 MB/min (~1.4 min). Good for "HD" sending.
- Pick the bitrate from the target, not a fixed quality:
  `videoBitrate = (0.92 * limitBytes * 8 / durationS) - audioBitrate`, clamped to a floor
  (≈ 600 kbit/s at 480p). If the floor does not fit, refuse with "Video is too long to send
  (max ~N min)" or offer to trim. Keep 8-10 % headroom for the container and the encryption
  padding.
- H.264 (AVC) is the safe output codec. Every recipient (web, old Android, iOS) can play it,
  and FortaChat's peers include browsers. HEVC would halve the size but is not playable
  everywhere.

## 2. Options

### A. Small native Capacitor plugin on Media3 Transformer (recommended)
- `androidx.media3:media3-transformer` (+ `media3-effect`, `media3-common`), the Jetpack
  replacement for hand-rolled MediaCodec pipelines.
  - It uses the hardware decoder/encoder and handles rotation, HDR→SDR tone mapping (Pixel HDR
    video), HEVC input, audio passthrough or re-encode, and the MP4 muxing.
  - minSdk 21; the app is at 24.
- Plugin shape: `VideoCompress.compress({ uri, maxHeight: 720, targetBytes, audioKbps }) →
  { path, size, durationMs, width, height }` with `progress` events (Transformer
  `getProgress()` polled every 500 ms) and `cancel(id)`. It writes to `cacheDir`, and the caller
  deletes the output after the send.
- **The input is the hard part, not the transcode.** Today videos come from the WebView `<input
  type=file>`, so JS only has a `File`/`Blob` and no `content://` URI.
  - Copying a 90 MB blob into a file over the Capacitor bridge (base64) costs ~1.33x the
    memory and is slow; that is exactly the Tor-upload problem (audit U4).
  - So pick videos natively (e.g. `@capawesome/capacitor-file-picker`, maintained for
    Capacitor 8, which returns a path/URI), or give the plugin its own picker method.
  - Images can stay on the current input.
- The output goes back into the existing pipeline. Read it with
  `fetch(Capacitor.convertFileSrc(path))` → Blob (no base64), then go through `readPickedFile`
  → `enqueueMediaSend` as today. Later, a native uploader (audit R8b) could take the path
  directly.
- UI:
  - a "Compressing… 40 %" state on the composer item (or a preparing bubble);
  - cancel;
  - an "HD / original" toggle for videos that already fit;
  - a log entry `prep:transcode ms= in= out= kbps=`.
- **Effort: ~4-5 days**:
  - plugin + Gradle deps: 1.5 d;
  - native video picking + wiring into `use-media-upload`/`sendFile`: 1 d;
  - UI states, cancel, size/duration policy: 1 d;
  - tests (JS policy unit tests; Android instrumented test on one sample clip) and device
    passes on the Pixel 6a: 1 d.
- iOS later: `AVAssetExportSession` (preset `AVAssetExportPreset1280x720`) behind the same
  plugin interface, ~1.5 d.
- APK size: Media3 transformer + effect add roughly 1-2 MB.

### B. Existing plugins
- No maintained Capacitor 8 plugin does video transcoding. npm search, 2026-10-15:
  - `@capgo/capacitor-file-compressor` is images only;
  - `@whiteguru/capacitor-plugin-media` only saves to the gallery;
  - `react-native-compressor` (WhatsApp-like, good) is React Native only.
- `cordova-plugin-video-editor` (jbavari), via `@awesome-cordova-plugins/video-editor`, runs
  under Capacitor's Cordova compatibility.
  - It is built on the old ypresto android-transcoder. The last plugin release was 2022 and
    the transcoder itself is unmaintained.
  - It has no HDR tone mapping and spotty HEVC/10-bit input handling (Pixel HDR clips), and
    its progress and cancel are crude.
  - It still needs a file URI, so the native-picking problem remains.
  - It saves ~1.5 days of plugin work but carries device-compatibility risk forever. **Not
    recommended.**
- Wrapping an FFmpeg build (ffmpeg-kit is retired; community forks exist):
  - it adds 15-40 MB to the APK;
  - it is software encoding unless MediaCodec is wired in, so slow and heavy on battery;
  - LGPL/GPL questions arise.
  - **No.**

### C. In-WebView transcoding with WebCodecs
- Android WebView (Chromium) has `VideoDecoder`/`VideoEncoder` with hardware acceleration. With
  mp4box.js (demux) and an MP4 muxer (e.g. mp4-muxer) a pure-JS transcode is possible, with no
  native code and the same code on the web.
- Costs:
  - demux, audio handling and A/V sync are ours to get right;
  - rotation metadata and HDR inputs are fiddly;
  - it runs on the main/JS thread budget and is throttled as soon as the screen goes off;
  - the whole file passes through JS memory again.
- Effort ~4-6 days with more risk than A. Interesting for a web build; on Android, A is
  simpler and more robust.

## 3. Quality and battery
- Hardware encoding on the Pixel 6a (Tensor): 1080p→720p H.264 runs at roughly 4-8x real
  time, so a 1-minute clip takes ~10-15 s. 4K/HDR input with tone mapping is slower,
  ~1.5-3x real time. Not measured yet: one benchmark run on the device is part of the 1-day
  test item.
- Battery: the hardware codec is a small, efficient block. A 1-minute transcode should cost
  well under 1 % of battery. It also removes 50-100+ MB of LTE upload, and on a weak uplink
  the radio's cost is larger than the transcode's. Net: compression usually *saves* battery
  and data. Software encoding (FFmpeg) would invert that: several % per minute, and the phone
  gets hot.
- Quality: 720p at ~2.5 Mbit/s is visually fine on phones. Fast motion and low light show
  blocking first. Offer "HD" (1080p, ~5 Mbit/s) when it fits, and always keep the original
  when the file is already under the limit and on Wi-Fi (product choice).
- Screen-off: a transcode in a plain plugin thread stops when Android freezes the app.
  - Keep compression a foreground step: the user waits for "Compressing…" in the composer.
  - Or run it inside the keep-alive foreground service from audit R8a.

## 4. Recommendation
1. Ask pocketnet to raise `max_upload_size`/`client_max_body_size` (zero client effort).
   standbyfix5 already follows the server value.
2. Build option A for Android (~4-5 d) as the next media step after the reliability work, with
   720p/2.5 Mbit/s default, bitrate from duration, HD toggle and cancel.
3. iOS (AVAssetExportSession) and WebCodecs for web only if those platforms need it.
