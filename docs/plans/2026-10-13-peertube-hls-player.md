# Видео PeerTube: HLS-плеер на Video.js 10 вместо iframe — план — 2026-10-13

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-13-peertube-hls-player.md`. Начни с этапа «…». Перед правкой сверь
> > предпосылки этапа с кодом — номера строк в плане могут устареть, ориентируйся на имена функций.
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет.

## Статус (2026-10-13)

Этапы 0–6 сделаны в коде, не закоммичены. Этап 7 (устройства) — запись в `docs/manual-verification.md`
«Видео PeerTube: HLS-плеер Video.js в модалке поста, PiP». Проверено в headless Chrome 155 на собранном
чанке (`build.target: chrome60`): HLS играет (Pixel/iPhone-эмуляция, desktop), автокачество, подписи на
русском, `play` от `<hls-video>` ставит голосовое на паузу, PiP-шим Android входит/выходит без паузы.

Решения владельца (раздел 6): тап по видео в ленте **всегда** открывает модалку (все платформы); PiP на
Android только по кнопке; стартовое качество — авто (ABR).

### Как сделано (отличия от этапов ниже)

- Запасной плеер вместо iframe: `VideoPlayer.vue` → HLS (`PeerTubePlayer`) → mp4 (`FeedVideoPlayer`) →
  «Открыть видео в браузере» (`watchUrl` = `https://host/videos/watch/uuid`). iframe остался только для
  YouTube/Vimeo.
- Данные: `fetchPeerTubeSources` (`video-embed.ts`) — плейлист, mp4 и превью одним запросом, кэш на сессию;
  `fetchPeerTubeFileUrl` удалён.
- Скин: свои стили он кладёт в свой shadow root сам; глобальный `skin.css` не нужен (а через PostCSS с
  Tailwind 3 он и не собирается). Наши правки — подкласс `<forta-video-skin>` с доп. таблицей в shadow root.
- Язык: переводы работают только внутри `<media-i18n lang>` (его регистрирует скин); `lang` на
  `<video-player>` не действует. Русская локаль регистрируется в том же чанке.
- Пауза голосовых: `<hls-video>` сам пробрасывает `play`/`volumechange` на хост; слушатель в
  `use-audio-playback.ts` теперь принимает «медиа-подобные» элементы (`muted`/`volume`/`paused`).
- Один плеер за раз: `src/shared/lib/active-video-player.ts`, общий для `FeedVideoPlayer` и `PeerTubePlayer`.
- PiP Android: шим `src/shared/lib/video-js/android-pip.ts` подставляет стандартный PiP API поверх
  плагина `VideoPip` (`android/.../plugins/videopip/`), поэтому работает родная кнопка скина. Плеер на время
  PiP растягивается на весь WebView (`data-native-pip`, `main.css`). `MainActivity` —
  `supportsPictureInPicture`, событие `pipChanged` из `onPictureInPictureModeChanged`.
- Чанк `video-js` (manualChunks): 652 KB, 170 KB gzip, грузится только динамическим импортом.
- После ревью: `AbortSignal.timeout` с запасным `AbortController` (его нет в iOS 15 / старом WebView);
  в кэш источников попадают только ответы, где есть что играть; в состоянии «недоступно» есть «Повторить»;
  позиция не сохраняется, пока плеер не восстановил прежнюю (иначе закрытие на загрузке её стирало);
  закрытие окна PiP на Android (не разворот) ставит видео на паузу — `PipExitPolicy` по состоянию lifecycle.

## 1. Цель

1. Видео PeerTube в постах (лента канала, модалка поста) играют через HLS с адаптивным качеством,
   в нашем плеере, с первого тапа, на Web, Electron, Android и iOS.
2. Современный плеер без самописного UI: скин, жесты, fullscreen, выбор качества и скорости, i18n.
3. Окно в окне (PiP): Web и Electron, iOS, Android.
4. iframe-embed PeerTube убираем совсем. YouTube и Vimeo остаются на iframe — HLS у них нет.

Вне объёма:
- Видео-вложения Matrix (зашифрованные файлы в `MediaViewer`) — другой путь, файл расшифровывается целиком.
- Плеер Бастиона (`public/js/satolist.js`) с P2P через WebRTC — для чатов не нужен, не трогаем.
- P2P-загрузка сегментов. Качаем с CDN-узлов PeerTube напрямую.

## 2. Что сейчас

### Код

- `src/shared/lib/video-embed.ts`: `parseVideoUrl` разбирает `peertube://host/uuid` в `embedUrl` и
  `apiUrl`. `fetchPeerTubeFileUrl(apiUrl)` берёт из `/api/v1/videos/{uuid}` один файл, ближайший к
  720p: сначала `files[]` (web videos), иначе `streamingPlaylists[].files[]` (fMP4). Плейлист `.m3u8`
  не используется. `fetchPeerTubeThumb` делает второй запрос к тому же API.
- `src/features/post-player/ui/VideoPlayer.vue`: PeerTube с прямым файлом играет в
  `FeedVideoPlayer` (`<video>` с одним mp4), без файла — iframe. На native инлайн в ленте не играет, тап
  открывает модалку (`emit("expand")`, WEE-74: iframe в ленте перехватывал жесты Android WebView).
- `src/shared/ui/feed-video-player/FeedVideoPlayer.vue` и `src/shared/lib/use-feed-video-player.ts`
  (407 строк): свой UI, повторы при ошибке, правило «играет один плеер» (`activePlayer`), пауза вне
  экрана (IntersectionObserver), память позиции (`src/shared/lib/video-position-store.ts`).
- Где используется: `PostCard.vue` (лента канала и пост в сообщении), `PostPlayerModal.vue`.
  `PostEmbed.vue` только показывает превью (`fetchPeerTubeThumb`), не играет.
- Голосовые встают на паузу, когда начинает звучать другой `<video>`/`<audio>`: слушатель `play` и
  `volumechange` на `document` в фазе capture (`use-audio-playback.ts`, `interruptVoicePlayback`).
- Сборка: `vite.config.ts` → `build.target: "chrome60"` (старый WebView Android 7).

### Незакоммиченный фикс (этап 0)

Симптом: на вебе тап по видео в канале не запускал воспроизведение. Причина: embed PeerTube
игнорирует `?autoplay=1` для iOS user agent (в т.ч. DevTools «iPhone»), после нашего тапа показывал
свой постер и свою кнопку play. Фикс: в `VideoPlayer.vue` путь с прямым файлом (`FeedVideoPlayer`)
включён и на вебе (`routesToModal`), тесты в `VideoPlayer.test.ts`, запись в `manual-verification.md`.

### Сервер PeerTube (проверено 2026-10-13, `peertube3502.pocketnet.app`)

- PeerTube **4.2.2**. У видео канала OTYKEN `files: []`, есть только `streamingPlaylists` (HLS).
- Мастер-плейлист: `streamingPlaylists[0].playlistUrl`, качества 720p и 144p (у других видео
  480/360/144). `CODECS="avc1.64001f,mp4a.40.2"`.
- Медиаплейлист: `#EXT-X-PLAYLIST-TYPE:VOD`, `#EXT-X-VERSION:7`, сегменты по 4 с — **byte-range внутри
  одного fMP4** (`#EXT-X-MAP ... BYTERANGE`, `#EXT-X-BYTERANGE`).
- CORS: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers` содержит `Range`. Range-запрос к
  файлу → `206`.

## 3. Выбор библиотеки

Исследование 2026-10-13:

- **Video.js 10** вышел в GA 2026-10-01 (10.0.1 — 2026-10-02). Переписан с нуля командами Video.js,
  Plyr, Vidstack, Media Chrome и Mux Player. Apache-2.0. Пакет `@videojs/html` — web components,
  во Vue подключается через `isCustomElement` (официальный гайд `guides/vue`).
- **Plyr** объявлен устаревшим (только security), **Vidstack** и **Media Chrome** — команды ушли в
  Video.js 10, есть гайды миграции. Брать их — брать код без развития.
- ArtPlayer, xgplayer — живы, но экосистема и стиль не наши. Shaka — тяжёлый, заточен под DASH.
- Свой UI поверх hls.js (light-сборка ~107 KB gzip) — легче, но PiP, fullscreen, меню качества, жесты и
  доступность пишем и поддерживаем сами.

**Решение: Video.js 10, `hls-video` (свой движок SPF).** Запасной движок — `hlsjs-video` (отдельный пакет
`@videojs/hlsjs-video`), если SPF не справится на устройствах.

### Прототип (scratchpad, headless Chrome 155, 2026-10-13)

- `@videojs/html@10.0.1`: `video/player` + `video/skin` + `media/hls-video`, плейлист PeerTube выше.
- Desktop: играет с клика. Эмуляция Pixel 7 и iPhone 13: первый тап показывает панель, тап по
  `media-play-button` — играет (`videoWidth` 720, ошибок нет). Byte-range fMP4 SPF понимает.
- В панели по умолчанию: play, громкость, прогресс, настройки (качество), Cast, PiP, fullscreen.
- Размер (esbuild, minify, gzip): player + skin без движка ~136 KB JS + ~10 KB CSS; с `hls-video` (SPF)
  ~169 KB. Для сравнения: hls.js 161 KB, hls.js light 107 KB.
- На реальных устройствах не проверялось.

### Ограничения Video.js 10, которые формируют план

- **Минимальные браузеры: Chrome/Edge 111, Safari и iOS 16.4**, Firefox 121. Для Android WebView минимум
  не указан. Скин требует `@layer`, `:has()`, `@container`, `color-mix()`/`oklch()`, `adoptedStyleSheets`.
  У нас Android 7+ и iOS 15+ → нужна проверка возможностей и запасной плеер (этап 2).
- Наш `build.target: "chrome60"` даунлевелит синтаксис, но не даст `customElements`, `adoptedStyleSheets`
  и CSS-возможности. Значит, чанк Video.js грузится **только** динамическим `import()` после проверки.
- `<video>` у Video.js внутри shadow DOM. События `play`/`volumechange` не `composed` и до слушателя на
  `document` не доходят → пауза голосовых сама не сработает (этап 3).
- PiP: стандартный API + WebKit presentation mode на iOS. В Android WebView `requestPictureInPicture`,
  насколько известно, недоступен — кнопка будет скрыта (`pictureInPictureAvailability: 'unsupported'`),
  нужен нативный путь (этап 6). Проверить на устройстве.

## 4. Этапы

### Этап 0. Закоммитить фикс первого тапа

- Коммит из раздела 2 (`VideoPlayer.vue`, `VideoPlayer.test.ts`, `manual-verification.md`).
- Он остаётся запасным путём для браузеров, которые не тянут Video.js (этап 2).

### Этап 1. Данные: плейлист и список качеств

- `video-embed.ts`: одна функция вместо двух запросов, например `fetchPeerTubeSources(apiUrl)` →
  `{ playlistUrl: string | null; fileUrl: string | null; thumbUrl: string; duration?: number }`.
  `fileUrl` — как сейчас (ближайший к 720p), для запасного плеера.
- Кэш ответа на сессию по `apiUrl`: превью в ленте и плеер в модалке не должны ходить в API дважды.
- Тесты в `video-embed.test.ts`: видео только с HLS (как у OTYKEN), только с `files`, без того и другого,
  ошибка сети, таймаут.

### Этап 2. Подключение Video.js и проверка возможностей

- `npm i @videojs/html` (точная версия), при необходимости `@videojs/hlsjs-video` — решить по этапу 7.
- `vite.config.ts`: `isCustomElement` только для используемых тегов (`video-player`, `video-skin`,
  `hls-video`, плюс то, что понадобится из `media-*`). Широкое правило «все теги с дефисом» не ставить.
- `src/shared/lib/video-player-support.ts`: `canUseModernPlayer()` — `customElements`,
  `adoptedStyleSheets`, `CSS.supports('selector(:has(a))')`, `CSS.supports('container-type: inline-size')`,
  `CSS.supports('color', 'oklch(0 0 0)')`, плюс `MediaSource`/`ManagedMediaSource` **или** нативный HLS
  (`canPlayType('application/vnd.apple.mpegurl')`). Тесты на каждую ветку.
- Загрузчик: `loadVideoJs()` — один динамический `import()` (player, skin, CSS, `hls-video`), промис
  кэшируется. Отдельный чанк в `manualChunks`, в стартовый бандл не попадает.
- Проверить, что `npm run build` с `chrome60` собирает чанк без ошибок, и записать его размер.
- Lightning CSS, если включён в Vite, ломает `light-dark()` и `:dir()` в скине — исключить фичи по гайду
  Video.js «Browser support».

### Этап 3. Компонент `PeerTubePlayer` (модалка поста)

- `src/features/post-player/ui/PeerTubePlayer.vue`: `<video-player><video-skin><hls-video>` с
  `src` = `playlistUrl`, постер = превью. Props как у текущего плеера: `autoplay`, `persistKey`.
- Ветвление в `VideoPlayer.vue` для PeerTube:
  1. `canUseModernPlayer()` и есть `playlistUrl` → `PeerTubePlayer`;
  2. иначе есть `fileUrl` → `FeedVideoPlayer` (как после этапа 0);
  3. иначе / фатальная ошибка → заглушка «Ошибка воспроизведения» + «Открыть внешне»
     (`openExternalUrl`). **iframe для PeerTube нет.**
  Фатальная ошибка `PeerTubePlayer` → переход на п. 2, если есть `fileUrl`.
- Перенести из `use-feed-video-player.ts` то, что нужно обоим плеерам, в общий модуль:
  правило «играет один плеер» (`activePlayer`) и память позиции (`video-position-store.ts` уже общий).
- **Пауза голосовых:** подписаться на `play`/`volumechange` у `<video>` внутри `hls-video`
  (через store плеера или `shadowRoot`) и вызывать `interruptVoicePlayback()`. Тест обязателен —
  без него регрессия незаметна.
- Скин: цвета и скругления через CSS-переменные Video.js из наших токенов, тёмная и светлая тема.
  Если переменных не хватит — перенести исходник скина в проект (shadcn/Tailwind-вариант) и править.
- i18n: `createI18n`/`registerI18n` с русским и английским, тексты из наших ключей i18n. Тексты
  `FeedVideoPlayer` («Ошибка воспроизведения», «Повторить») заодно перевести на ключи i18n.
- Android back: выход из fullscreen плеера (как `post-video-fullscreen` в `VideoPlayer.vue`).
- Тесты (happy-dom, Video.js замокан): выбор ветки, переход на запасной плеер по ошибке, пауза голосовых,
  память позиции, автозапуск в модалке.

### Этап 4. Лента канала и пост в сообщении

- Тот же `PeerTubePlayer` инлайн в `PostCard.vue`, без автозапуска, правило «один плеер», пауза вне экрана.
- Решить, оставлять ли `emit("expand")` на native. Причина WEE-74 — iframe; без iframe инлайн-плеер на
  Android возможен. Проверить на устройстве, что жесты плеера (`media-gesture`) не забирают вертикальную
  прокрутку ленты. Если забирают — инлайн на native оставить через модалку.
- Ленивая загрузка: чанк Video.js и запрос к API — только когда карточка близко к экрану.

### Этап 5. Убрать iframe PeerTube и мёртвый код

- `VideoPlayer.vue`: ветка iframe только для YouTube и Vimeo; `embedUrl` для PeerTube не нужен.
- Обновить тесты `VideoPlayer.test.ts`, которые проверяют iframe-откат для PeerTube.
- `FeedVideoPlayer` остаётся запасным плеером для старых WebView и iOS < 16.4.

### Этап 6. Окно в окне

- **Web, Electron:** кнопка PiP из скина, стандартный API. Проверить в Electron 40.
- **iOS:** WebKit presentation mode — Video.js делает сам. Проверить на устройстве: вход в PiP,
  продолжение при сворачивании приложения (может потребоваться audio session — см. этап 7 плана
  `2026-10-08-background-voice-playback.md`).
- **Android:** нативный плагин, по образцу `CallActivity.kt` (`PictureInPictureParams`,
  `enterPictureInPictureMode`, `onPictureInPictureModeChanged`):
  - `android:supportsPictureInPicture="true"` у `MainActivity`;
  - JS: своя кнопка PiP в скине (стандартная скрыта) → плагин; перед входом видео разворачивается на весь
    WebView, на выходе — обратно (событие из `onPictureInPictureModeChanged`);
  - `setAutoEnterEnabled` (Android 12+) — по желанию: PiP при сворачивании, пока видео играет;
  - Android 7 (API 24–25): PiP нет, кнопку не показывать.
  - Kotlin-тесты на логику плагина, остальное — `manual-verification.md`.

### Этап 7. Проверка на устройствах

Запись в `docs/manual-verification.md` тем же коммитом, что и каждый этап, требующий устройства:

- Android 7 со старым WebView (ожидается запасной плеер), Android 12+, iPhone iOS 15 (запасной) и
  последний iOS, Electron Windows/macOS, Chrome, Safari.
- Сценарии: первый тап, переключение качества, ABR на медленной сети (DevTools throttling / Tor),
  перемотка, fullscreen и поворот, PiP, пауза голосового при старте видео, два видео в ленте, память позиции.
- Если SPF на каком-то устройстве не играет byte-range fMP4 — переключить на `hlsjs-video` и
  зафиксировать причину в этом плане.

## 5. Риски

- Video.js 10 вышел две недели назад — ждать патчей; версию фиксировать точно, обновлять осознанно.
- Размер чанка (~170 KB gzip) — грузится лениво, на старт не влияет; на медленной сети первый запуск
  видео дольше на время загрузки чанка. Можно прогревать чанк, когда карточка с видео появилась на экране.
- Старые WebView: всё, что не прошло `canUseModernPlayer()`, получает текущий плеер без HLS и без PiP.
- PeerTube-узлы pocketnet бывают недоступны или отвечают ошибкой — ошибки показываем, iframe не спасает.

## 6. Вопросы владельцу (отвечены 2026-10-13)

1. Инлайн-воспроизведение в ленте — нет: тап всегда открывает модалку.
2. PiP на Android — только по кнопке.
3. Стартовое качество — авто (ABR).

## 7. Доработки 2026-10-13 (вторая итерация)

- Верхняя группа кнопок скина (Cast / PiP / fullscreen) — слева: справа её закрывал крестик модалки.
- Автозапуск в модалке: `<hls-video>` с `preload="metadata"` не сообщает `canPlay` до нажатия play,
  поэтому запуск и восстановление позиции теперь ждут метаданных (`duration > 0`).
- Размер плеера по `aspectRatio` из PeerTube API (`shared/lib/video-frame.ts`): вертикальное, если < 0.9 —
  контейнер на всю ширину, высота не больше 70vh, по бокам чёрные полосы; горизонтальное — по ширине.
  Соотношение зажато в 9:21 … 21:9. Плитка в ленте осталась 16:9 (превью), меняется только плеер в модалке.
- Видео-вложения в сообщениях — тот же плеер: `<video>` пузыря внутри `VideoJsFrame`
  (`use-bubble-video-js.ts`); вся логика пузыря (постер, ошибки, длительность) осталась на этом элементе.
- Одно звучание на всё приложение (`active-video-player.ts`): любой звучащий медиаэлемент на странице
  ставит на паузу предыдущий; голосовые регистрируются сами; приглушённые превью и потоки звонков
  (`srcObject` = MediaStream) не трогаются.

## 8. Третья итерация (2026-10-13)

- Лента канала через `rpc-ex/getprofilefeed` (откат на `rpc`): ответ несёт `videos` — объекты PeerTube в
  формате API, ими заполняется кэш источников (`primePeerTubeSources`), отдельный запрос к PeerTube не
  нужен; `users` — профили авторов поста и последнего комментария, кладутся в стор пользователей для
  адресов, которых там ещё нет (`feedProfileToUser`). Нет `aspectRatio` → 16:9 (`videoFrame`).
- Кнопка трансляции (Cast) скрыта.
- Тач: тап по центру видео — play/pause, по краям — показать/скрыть панель (`retuneTouchGestures`).
