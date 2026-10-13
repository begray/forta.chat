# Докачка медиа и «Скачать заново» — план — 2026-10-11

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-11-resumable-media-download.md`. Начни с этапа «…». Перед правкой сверь
> > предпосылки этапа с кодом — номера строк в плане могут устареть, ориентируйся на имена функций.
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет. Synapse — репозиторий
> `pocketnetteam/synapse`, локальная копия `C:\inetpub2025\synapse`.

## Статус (2026-10-11)

План написан, ничего не начато. Ветка Synapse для PR почти наверняка `rebase/v1.148.0` (раздел 2,
«Откуда собран прод»); подтвердить у тех, кто деплоит, и ответить на остальные вопросы раздела 8.

## 1. Цель

1. Оборванная загрузка медиа (видео, файл, голосовое, картинка) продолжается с места обрыва — и при
   повторе внутри одной загрузки, и после перезапуска приложения.
2. Кнопка «Скачать заново»: стирает всё, что есть по файлу на устройстве (куски, готовый файл), и качает
   с нуля. Видна, когда загрузка оборвалась, упала с ошибкой или файл не расшифровался.

Правило поддержки: **нет поддержки — нет докачки.** Сервер (оригинал, зеркало), клиент (старый WebView) или
путь (Tor) без поддержки диапазонов качают файл целиком, как сейчас. Никаких обходов.

Вне объёма: просмотр видео до конца загрузки. Файл шифруется целиком (`roomCrypto.decryptFile(blob)`),
расшифровать кусок нельзя; для стриминга нужен новый формат шифрования блоками — отдельная задача.

## 2. Что сейчас

### Сервер

- Прод `matrix.pocketnet.app`: `/_matrix/federation/v1/version` → Synapse **1.148.0**, перед ним nginx.
- Проверка 2026-10-11: `GET /_matrix/media/v3/download/matrix.pocketnet.app/jqMRYsZlMGlzoAkMjhInUfoL`
  с `Range: bytes=100-199` → **`200 OK`, `Content-Length: 17445376`** — весь файл. Диапазоны не
  поддерживаются ни Synapse, ни nginx (`proxy_force_ranges` не включён).
- CORS (`synapse/http/server.py`, `set_cors_headers`): `Access-Control-Allow-Headers: X-Requested-With,
  Content-Type, Authorization, Date`, `Access-Control-Expose-Headers: Synapse-Trace-Id, Server`. `Range`
  не разрешён, `Content-Range` не виден JS.
- Зеркало `matrix.2.pocketnet.app`: на ту же проверку (2026-10-11, несуществующий файл) ответило `502`.
- Локальный форк `C:\inetpub2025\synapse`, ветка `develop` = Synapse **1.114.0rc1** (коммит `2fbe1d3af`,
  2025-05-02) — устарела, прод собран не из неё.

#### Откуда собран прод (проверено 2026-10-11)

- `pocketnetteam/synapse`, ветка **`rebase/v1.148.0`**, голова `710b6559f` (2026-03-17, Anton Kovalev),
  `pyproject.toml` → `version = "1.148.0"`. Поверх апстрима `element-hq/synapse` `v1.148.0` — 7 коммитов:
  `50f3aa461` лимит списка публичных комнат, `156ea0280` без рассылки профиля в member-события,
  `2dadbdc2f` свои правила auth (kick, шифрование, звонки), `28b82ea3e` алиас комнаты в push,
  `383ea0a4b` документация форка (`CLAUDE.md`, `docs/fork_*.md`), `387a585a8` kick в личных комнатах,
  `710b6559f` CI-сборка Docker.
- Сборка `Yanotek/synapse` Actions run `23200903094` («Build Docker Image», `workflow_dispatch`,
  2026-03-17, success) — тот же коммит `710b6559f`, ветка `rebase/v1.148.0`. Workflow
  `.github/workflows/build-docker.yml` пушит образ `<DOCKERHUB_USERNAME>/matrix-synapse:1.148.0`.
  Это единственный запуск в `Yanotek/synapse`; после него в ветку ничего не коммитили.
- Совпадает с продом: версия 1.148.0 и CORS-заголовки (`X-Requested-With, Content-Type, Authorization,
  Date` — ветка `else` в `set_cors_headers`, `synapse/http/server.py:998`).
- Не доказано: что на сервере запущен именно этот образ. Подтвердить у того, кто деплоит (вопрос 8.1).
- В 1.148 диапазонов тоже нет: `respond_with_responder` (`synapse/media/_base.py:394`),
  `Responder.write_to_consumer` (`:489`), `ThreadedFileSender.beginFileTransfer` (`:719`),
  `FileResponder` (`synapse/media/media_storage.py:480`) — та же схема, что описана ниже по 1.114;
  номера строк в разделе 4 сверять с этой веткой.

Как Synapse отдаёт файл (форк, 1.114):

- `synapse/media/media_repository.py`: `get_local_media` / `get_remote_media` → `media_storage.fetch_media`
  → `respond_with_responder(request, responder, media_type, media_length, upload_name)`.
- `synapse/media/_base.py`: `respond_with_responder` → `add_file_headers` (ставит `Content-Length` = весь
  файл) → `responder.write_to_consumer(request)`.
- `synapse/media/media_storage.py`: `FileResponder.write_to_consumer` →
  `ThreadedFileSender.beginFileTransfer(open_file, consumer)` — читает файл с начала кусками по 16 КБ.
- Federation-путь (`respond_with_multipart_responder`) и миниатюры — отдельно, их не трогаем.

### Клиент

- `features/messaging/model/use-file-download.ts`, `downloadFile` (около строки 640): цикл
  `MAX_RETRIES = 3`, на каждой попытке свежий URL (`resolveMediaUrl` → `rewriteMediaHost` чередует
  оригинал и зеркало → `appendCacheBust` добавляет `cb=`), затем `fetchBlobWithProgress` или
  `downloadMediaViaTorFile`, затем расшифровка (`runFileDecrypt`). **Каждая попытка качает с нуля.**
- `shared/lib/file-transfer/fetch-blob-with-progress.ts`: собирает куски `reader.read()` в память, таймауты
  на заголовки и на тишину в теле (`DownloadStalledError`).
- Tor на Android: `TorFilePlugin.download` (Kotlin) пишет файл в `cacheDir/download_<ts>.<ext>`, без
  `Range`, отдаёт путь. JS-обёртка — `shared/lib/file-transfer/file-transfer-service.ts`.
- Готовые расшифрованные файлы — `shared/lib/media-cache/media-cache-repository.ts`
  (`mediaCacheIndex` / `mediaCacheBlobs` в Dexie, на native — Filesystem), ключ — `mxc`.
- Кэш object URL в памяти: `cache` в `use-file-download.ts`, сброс — `invalidateDownloadCache(key)`.
- UI загрузки: `features/messaging/ui/MediaDownloadProgress.vue` (кольцо, крестик отмены); ошибка и
  «Повторить» — в `MessageBubble.vue`. Голосовые: `VoiceMessage.vue`, путь `forceRefetch`.
- Dexie: последняя версия схемы — 19 (`shared/lib/local-db/schema.ts`).

## 3. Решения

1. **Диапазоны делаем в Synapse (PR в форк), не только в nginx.** nginx `proxy_force_ranges on` дал бы
   `206` без правки кода, но nginx всё равно тянет из Synapse весь файл на каждый запрос диапазона, а CORS
   всё равно правится в Synapse. Правка в `respond_with_responder` + `FileResponder` — несколько десятков
   строк. nginx остаётся запасным вариантом (раздел 4.4), если PR в прод не попадёт быстро.
2. **Поддержка определяется по ответу, а не по версии.** Клиент шлёт `Range: bytes=<есть>-`. `206` с
   правильным `Content-Range` → дописываем. `200` → сервер не умеет: выбрасываем куски, пишем ответ с
   нуля, запоминаем хост как «без диапазонов» на сессию. Так оригинал и зеркало получают поддержку
   независимо, и при обновлении сервера ничего в клиенте менять не надо.
3. **Куски — шифротекст, расшифровка один раз в конце.** Байты с сервера без ключа бесполезны, хранить их
   в IndexedDB безопасно. Ключ из события в хранилище кусков не пишется.
4. **Ключ кусков — `mxc` (сервер + media id), не URL.** URL меняется между попытками (хост, `cb=`), mxc —
   нет; содержимое mxc неизменно, поэтому склейка кусков с оригинала и зеркала корректна.
5. **Хранилище кусков — Dexie на web/WebView, файл на диске для Tor.** Нативный плагин и так пишет на диск;
   гонять байты через мост ради IndexedDB незачем.
6. **«Повторить» и «Скачать заново» — разные кнопки.** «Повторить» продолжает с сохранённого места (или с
   нуля, если места нет). «Скачать заново» всё стирает и качает с нуля без кэшей; показывается всегда в
   состоянии ошибки, а также в меню сообщения для уже скачанного файла (вопрос 8.4).

## 4. Сервер: Synapse

### 4.1. PR в `pocketnetteam/synapse`

Ветка — от `rebase/v1.148.0` (раздел 2), PR туда же. Тесты — `poetry run trial tests.media
tests.rest.client.test_media tests.test_server` (см. `CLAUDE.md` в ветке). После мержа — запуск
`Build Docker Image` и перезапуск контейнера с новым образом. Изменения:

1. `synapse/media/_base.py`:
   - `parse_range_header(header: bytes | None, size: int) -> tuple[int, int] | None` — только один
     диапазон `bytes=a-b`, `bytes=a-`, `bytes=-n`. Несколько диапазонов, мусор → `None` (отдать весь файл,
     как разрешает RFC 9110). `a >= size` → `416` с `Content-Range: bytes */size`.
   - `respond_with_responder`: если responder умеет `seek` (флаг, см. ниже), размер известен и диапазон
     валиден → `206`, `Content-Range: bytes a-b/size`, `Content-Length: b-a+1`, вызов
     `responder.write_to_consumer(request, offset=a, length=b-a+1)`. Иначе — как сейчас, `200`.
   - Всегда `Accept-Ranges: bytes` для seek-способных responder'ов, иначе `Accept-Ranges: none`.
   - `If-Range`: если пришёл и не совпадает с `ETag`/датой — отдать весь файл `200`. Synapse не ставит
     ETag на медиа, поэтому любой `If-Range` → `200` (браузерный `<video>` шлёт `If-Range`, см. запрос
     из DevTools 2026-10-11).
   - `ThreadedFileSender.beginFileTransfer(file, consumer, length=None)` — читать не больше `length`.
2. `synapse/media/media_storage.py`: `FileResponder` — `supports_range = True`,
   `write_to_consumer(consumer, offset=0, length=None)` делает `open_file.seek(offset)`.
   Базовый `Responder` — `supports_range = False`; сторонние storage provider'ы остаются на `200`.
3. `synapse/http/server.py`, `set_cors_headers`: добавить `Range` в `Access-Control-Allow-Headers`;
   `Content-Range, Accept-Ranges, Content-Length` в `Access-Control-Expose-Headers` (во всех трёх ветках).
4. Тесты: `tests/media/test_base.py` (разбор заголовка), `tests/rest/client/test_media.py` и
   `tests/media/test_media_storage.py` (`206` с правильными байтами, `416`, несколько диапазонов → `200`,
   `If-Range` → `200`, remote media из кэша → `206`, federation-путь не изменился), CORS — в
   `tests/test_server.py`.
5. `changelog.d/<n>.feature`: «Support single byte-range requests (`Range`) on media downloads.»

Апстрим: тот же патч можно предложить в `element-hq/synapse` — тогда при следующем мерже апстрима
конфликтов не будет. Не обязательно для нас.

Почему в апстриме этого нет (проверено 2026-10-13):

- `matrix-org/synapse#4780` «Media handler does not support HTTP range requests» — открыт с 2019, P4 /
  S-Minor, решения мейнтейнеров нет; репозиторий архивирован 2024-04-26 (разработка ушла в
  `element-hq/synapse`). Ранняя попытка — закрытый PR `#2909`.
- Единственный технический довод (ShadowJonathan, 2022): медиа идёт через `fetch_media` и сторонние
  модули storage provider; поддержка диапазонов «сломает API медиа-модулей», а читать и выбрасывать байты —
  «некрасивый хак».
- Спека: MSC3469 «Mandate HTTP Range on Content Repository Endpoints» (2021) висит открытым — команда
  спеки против обязательного `MUST`, предлагает `SHOULD` без MSC. Запрета нет, просто никто не сделал.
- Наш план этот довод обходит: API модулей не меняется, диапазоны только у `FileResponder` (файл на
  локальном диске, `seek`), остальные responder'ы (S3 и пр.) отвечают `200`, как сейчас. Ограничение:
  если медиа на проде лежит во внешнем storage provider и не закэширована на диске, докачки не будет
  (вопрос 8.6).

### 4.2. nginx

- Не резать заголовки: `Range` и `If-Range` проходят в upstream по умолчанию; проверить, что в конфиге
  нет `proxy_set_header Range ""` и `max_ranges 0`.
- `proxy_buffering` — как есть (не мешает `206`).
- Если nginx добавляет свои CORS-заголовки поверх Synapse — синхронизировать с 4.1.3.

### 4.3. Зеркало `matrix.2.pocketnet.app`

Обновить так же, когда обновят оригинал. Пока не обновлено — клиент сам увидит `200` и не будет докачивать
с зеркала (решение 3.2). Отдельная работа не нужна. Сейчас зеркало отдаёт `502` — сообщить админам.

### 4.4. Запасной вариант без PR

`location /_matrix/media/ { proxy_force_ranges on; }` + `add_header` для `Range` в CORS (с
`proxy_hide_header` для заголовков Synapse, чтобы не было дублей). Работает сразу, цена — nginx тянет весь
файл из Synapse на каждый диапазон.

### 4.5. Проверка на сервере

```
curl -s -D - -o /dev/null -H "Range: bytes=100-199" https://matrix.pocketnet.app/_matrix/media/v3/download/<mxc>
#   ожидается: 206, Content-Range: bytes 100-199/<size>, Content-Length: 100
curl -s -D - -o /dev/null -X OPTIONS -H "Origin: http://localhost" \
  -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" <тот же URL>
#   ожидается: Range в Access-Control-Allow-Headers
```

## 5. Клиент

### 5.1. Хранилище кусков (web/WebView)

- Dexie v20, две таблицы:
  - `partialDownloads`: `mxc` (PK), `size` (ожидаемый полный размер), `received` (байт подряд с нуля),
    `roomId`, `updatedAt`. Индекс `updatedAt` — для чистки.
  - `partialDownloadChunks`: `[mxc+offset]` (PK), `blob`. Кусок ≈ 1 МБ.
- Модуль `shared/lib/media-cache/partial-download-repository.ts`: `get(mxc)`, `append(mxc, offset, blob)`
  (транзакция: кусок + `received`), `assemble(mxc) → Blob` (`new Blob(chunks)`, без копии в память),
  `delete(mxc)`, `prune({ olderThanMs, maxTotalBytes })`, `clearAll()`.
- Запись не на каждый `reader.read()` (16–64 КБ), а пачкой: ≥ 1 МБ или раз в 2 с, плюс при обрыве /
  отмене — то, что накопилось.
- Чистка: при старте и раз в сутки — старше 48 ч и сверх 300 МБ по LRU (вопрос 8.3); при `logout` и
  удалении аккаунта — всё; после успешной расшифровки — запись файла.
- Квота: `QuotaExceededError` при записи → удалить куски этого файла и докачивать дальше без сохранения.

### 5.2. Загрузка с диапазоном (`fetch-blob-with-progress.ts`)

- Новые опции: `resumeFrom?: number`, `onChunk?: (offset, bytes) => Promise<void>`.
- `resumeFrom > 0` → заголовок `Range: bytes=<resumeFrom>-`.
- Ответ:
  - `206` и `Content-Range: bytes <resumeFrom>-<end>/<total>` с тем же `total` → дописываем, прогресс
    стартует с `resumeFrom` («9,8 / 16,6 MB»).
  - `200` → сервер не умеет: результат `{ restarted: true }`, вызывающий выбрасывает куски; хост в
    `noRangeHosts` (память, на сессию).
  - `206` с другим `total` или началом → куски выбросить, повторить без `Range`.
  - `416` → куски битые (длиннее файла): выбросить, повторить без `Range`.
- Если `Content-Range` не виден (сервер не отдал `Expose-Headers`) — считаем, что поддержки нет (`200`-путь).
- Клиент без поддержки: запрос с `Range` падает на preflight (`TypeError` до заголовков) → хост в
  `noRangeHosts`, та же попытка сразу без `Range`. Это не сетевая ошибка, ретрай не тратится.

### 5.3. Цикл повторов (`use-file-download.ts`, `downloadFile`)

- Перед каждой попыткой: `received` из `partialDownloads` → `resumeFrom`, если хост попытки не в
  `noRangeHosts`.
- Чередование оригинал ↔ зеркало остаётся. Попытка на хосте из `noRangeHosts` (или ответившем `200`)
  качает весь файл в память без сохранения и куски **не** трогает: их докачает следующая попытка на
  оригинале. Куски удаляются только после успешной расшифровки, при несовпадении размера и по «Скачать
  заново» (вопрос 8.2).
- Таймауты (`FETCH_TIMEOUT_MS`, `FETCH_IDLE_TIMEOUT_MS`) — как есть; при `DownloadStalledError` уже
  принятые байты сохранены, следующая попытка продолжит.
- Отмена пользователем (крестик) — куски сохраняются; повторное нажатие ▶ продолжит.
- Перед расшифровкой: `assemble` → проверка размера (`fileInfo.size`, если известен, и `total` из
  `Content-Range`). Не совпало → удалить куски, ошибка `crypto`-класса не ставится, повтор с нуля.
- Расшифровка упала → удалить куски, состояние ошибки с «Скачать заново».

### 5.4. Tor (Android, `TorFilePlugin.kt`)

- `download` принимает `rangeStart` и `partialPath`; если `rangeStart > 0` → `Range: bytes=<n>-`, файл
  открывается на дозапись.
- Ответ `206` → дописываем; `200` → файл обнуляем, пишем с начала, в ответе `restarted: true`.
- Имя файла детерминированное: `partial_<sha1(mxc)>` в `cacheDir/partial-downloads/`, а не
  `download_<ts>` — иначе после обрыва его не найти.
- Чистка по тем же правилам 5.1 (метод `prunePartials(maxAgeMs, maxBytes)` в плагине).
- iOS: Tor-пути нет — web-путь 5.1–5.3.
- Если `Range` через Tor-прокси не проходит (проверить на стенде) — Tor без докачки, как договорились.

### 5.5. «Скачать заново»

- `redownloadMedia(message)` в `use-file-download.ts`: `invalidateDownloadCache(key)` + `mediaCache.delete(mxc)`
  + `partialDownloads.delete(mxc)` (+ native `deletePartial`) → `download(message, …, { forceRefetch: true })`.
- UI: в состоянии ошибки (`MessageBubble.vue`, `VoiceMessage.vue`, файл-документ) рядом с «Повторить» —
  «Скачать заново»; i18n `message.redownload` (ru «Скачать заново», en «Download again»).
- В контекстном меню сообщения с медиа — пункт «Скачать заново» (вопрос 8.4).

## 6. Этапы

| # | Этап | Где | Зависит от |
|---|---|---|---|
| 0 | Ответы на вопросы раздела 8 | — | — |
| 1 | «Скачать заново» (5.5) | forta.chat | — |
| 2 | PR в Synapse (4.1) + тесты, ревью | synapse | 0 |
| 3 | Деплой на оригинал, nginx (4.2), проверка 4.5 | сервер | 2 |
| 4 | Хранилище кусков + чистка (5.1) | forta.chat | — |
| 5 | Диапазоны в fetch + цикл повторов (5.2, 5.3) | forta.chat | 4; проверка на живом сервере — после 3 |
| 6 | Tor (5.4) | android + forta.chat | 5 |
| 7 | Зеркало (4.3) | сервер | 3 |

Этапы 1, 2 и 4 независимы и могут идти параллельно. Клиент (4–5) безопасно выпускать до деплоя сервера:
при `200` он качает целиком, как сейчас.

## 7. Проверка

Автотесты (forta.chat, Vitest):

- `fetch-blob-with-progress.test.ts`: `Range` уходит при `resumeFrom`; `206` дописывается и прогресс
  стартует с `resumeFrom`; `200` → `restarted`; чужой `total` → сброс; `416` → сброс; preflight-`TypeError`
  → хост в `noRangeHosts`, повтор без `Range` без траты ретрая.
- `partial-download-repository.test.ts` (fake-indexeddb): `append`/`assemble`, пачки, `prune` по возрасту и
  размеру, `clearAll` при logout.
- `use-file-download`: обрыв на середине → следующая попытка с `Range` и итоговый файл байт в байт;
  обрыв → «перезапуск» (новый модуль) → докачка; зеркало без диапазонов не стирает куски оригинала;
  расшифровка упала → куски удалены; «Скачать заново» стирает кэш, медиа-кэш и куски.
- Kotlin (`TorFilePlugin`): дозапись при `206`, обнуление при `200`.

Synapse: тесты 4.1.4, `trial tests.media tests.rest.client.test_media`.

Ручная проверка (`docs/manual-verification.md`, тем же коммитом, что этап 5/6): видео 50+ МБ, режим полёта
посреди загрузки → вернуть сеть → кольцо продолжает с того же места; убить приложение посреди загрузки →
открыть → продолжает; Tor то же; старый WebView (Android 7 без обновлений) — качает целиком без ошибок;
«Скачать заново» на битом файле.

## 8. Открытые вопросы

1. **Подтвердить, что на проде образ `matrix-synapse:1.148.0` из `rebase/v1.148.0`** (раздел 2), чей это
   Docker Hub-аккаунт (секрет `DOCKERHUB_USERNAME` в `Yanotek/synapse`) и кто перезапускает контейнер.
2. Зеркало без диапазонов при наличии кусков с оригинала: качать с зеркала целиком и не сохранять (куски
   остаются для оригинала) — предлагаю так. Или пропускать зеркало, пока оригинал жив?
3. Лимиты хранения кусков: 48 ч и 300 МБ — подходят?
4. «Скачать заново» только в состоянии ошибки или ещё в меню сообщения для скачанных файлов?
5. Кто правит nginx на `matrix.pocketnet.app` и `matrix.2.pocketnet.app` (и чинит `502` на зеркале)?
6. Где на проде лежит медиа: локальный `media_store_path` или storage provider (S3 и т.п. в
   `homeserver.yaml`, `media_storage_providers`)? От этого зависит, будут ли диапазоны у всех файлов.
7. Права на запись в `pocketnetteam/synapse` для `maxgithubprofile` нет (push 2026-10-12 отклонён). Коммит
   регистрации `build-docker.yml` лежит в локальной ветке `ci/register-build-docker` (`d0c578591`): нужен
   доступ или человек с правами. Образ сейчас собирается в `Yanotek/synapse` — чей это аккаунт Docker Hub?
