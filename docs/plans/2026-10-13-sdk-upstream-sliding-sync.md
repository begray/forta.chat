# Форк matrix-js-sdk-bastyon → свежий upstream и sliding sync — план — 2026-10-13

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-13-sdk-upstream-sliding-sync.md`. Начни с этапа «…». Перед правкой сверь
> > предпосылки этапа с кодом форка и обоих потребителей (Forta Chat и bastyon-chat).
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет.

Связанный план: [2026-10-03-initial-sync-lazy-members.md](2026-10-03-initial-sync-lazy-members.md), вариант D
(sliding sync) вынесен сюда.

---

## 1. Цель

Перейти на simplified sliding sync (MSC4186), чтобы большие аккаунты (~5000 комнат) не ждали тяжёлый первый
`/sync`. Путь: обновить форк до свежего upstream, перенести на него наши патчи, затем включить sliding sync.
Offline-first обязателен: без кэша состояния на устройстве переход не делаем (раздел 5).

## 2. Факты (проверено 2026-10-13)

**Форк.** `github.com/maxgithubprofile/matrix-js-sdk`, ветка `develop`. Локальная копия:
`C:\inetpub2022\matrix-js-sdk` (remote `upstream` = `matrix-org/matrix-js-sdk` уже настроен). Публикация в npm
(`matrix-js-sdk-bastyon`) — вручную, владельцем пакета.

- Номер `23.2.x` условный. Реальная база — upstream `develop` от 15.08.2024 (`d6080398`), то есть **v34.3.0**.
  Переход — с 34 на 43 (upstream `develop`), а не с 23.
- Отличия от базы: ~290 строк в 13 файлах (`git diff d6080398 3a3d964f -- src`).

**Потребители форка — два проекта, оба надо проверять:**

| Проект | Версия в `package.json` | Установлено (`git-revision.txt`) |
|---|---|---|
| Forta Chat (`C:\inetpub2025\forta.chat`) | `^23.2.5` | `3a3d964f` (23.2.5) |
| bastyon-chat (`C:\inetpub2020\wwwroot\bastyon-chat`) | `23.2.4` | `0e1ba5fb` (23.2.3) |

Между `0e1ba5fb` и `3a3d964f`: новый формат STUN/TURN (`client.ts`), `pickServersForId` (`call.ts`), глубокая
копия в `sync-accumulator.ts`. bastyon-chat этих изменений пока не получил.

**Upstream.**

- MSC4186 в upstream с **v37.3.0** (PR #4400, март 2025). Форк сейчас умеет только старый MSC3575 через прокси
  (`/_matrix/client/unstable/org.matrix.msc3575`). С нашим Synapse это не работает.
- Целевой релиз upstream — **v44.0.0** (последний стабильный, вышел 2026-10-13; проверить перед этапом 1, не
  вышел ли патч-релиз). В нём есть всё, что импортирует Forta: `lib/browser-index.js`,
  `lib/indexeddb-worker.js`, `lib/webrtc/call`, `lib/webrtc/callFeed`; эндпоинт
  `/_matrix/client/unstable/org.matrix.simplified_msc3575`. Опция `useAuthorizationHeader` на месте.
  Требует `node >= 22`.
- Legacy Olm-крипта в upstream удалена. **Нас это не касается:** ни Forta, ни bastyon-chat не вызывают
  `initCrypto`/`initRustCrypto`, шифрование своё (pcrypto).

**Synapse** (`C:\inetpub2025\synapse`, 1.148.0). `msc3575_enabled` по умолчанию `True`, эндпоинт
`/_matrix/client/unstable/org.matrix.simplified_msc3575/sync`. Соединение sliding sync (`pos`) живёт 7 дней
без использования (`CONNECTION_EXPIRY` в `synapse/storage/databases/main/sliding_sync.py`).

**Совместимость SDK 44 с сервером (проверено 2026-10-13).**

- Прод `matrix.pocketnet.app`: Synapse **1.148.0**, спецификация v1.1–v1.12, в `unstable_features`
  `org.matrix.simplified_msc3575: true`; эндпоинт sliding sync отвечает 401 без токена (есть, требует
  авторизацию).
- SDK 44 требует минимум v1.1; возможности v1.16 (расширенные профили и др.) проверяет по `/versions` и без них
  работает по-старому.
- Токен в query (`access_token=`) Synapse принимает (`synapse/api/auth/base.py`); в спецификации он
  deprecated с v1.11, но не удалён.
- Ссылки на медиа SDK 44 строит как 23.x: по умолчанию неаутентифицированные `/_matrix/media/v3/...`.
- Изменения форка Synapse (`event_auth.py`, профили без распространения в членство, push) — серверные, от
  версии клиентского SDK не зависят.

## 3. Инвентаризация патчей форка и решения

| Патч | Где | Кто использует | Решение |
|---|---|---|---|
| STUN-список с `_type: stun / stunGlobal`, TURN от `/voip/turnServer` по одной записи на URI с `_type: 'turn'`, TTL `1000000 * 1000`, `TurnServers` отправляется всегда | `client.ts`, `checkTurnServers` | оба (звонки) | **Оставить в форке, формат в точности как сейчас** |
| `pickServersForId`: детерминированный по `callId` выбор 2 TURN + 2 STUN + 1 `stunGlobal`; `createPeerConnection(callId)` | `webrtc/call.ts` | оба | **Оставить в точности.** Два `console.log` в `createPeerConnection` — убрать или перевести на `logger` (решить при переносе) |
| `ITurnServer._type`, `TurnServer.credential` вместо `password` | `client.ts`, `webrtc/call.ts` | часть патча выше | Оставить |
| `facingMode` в video-constraints | `webrtc/mediaHandler.ts` | оба | Оставить |
| Глубокая копия `JSON.parse(JSON.stringify())` в `getJSON(forDatabase)` | `sync-accumulator.ts` | оба | **Оставить.** В bastyon-chat в объект sync попадали реактивные Vue-объекты, и сохранение иногда ломалось. Исходная ошибка не найдена, поэтому копию не убираем. Причина записана здесь и должна попасть комментарием в код |
| `getLastReplacement()` синхронный, без расшифровки | `models/relations.ts` | **bastyon-chat** (`src/components/chat/list/index.js:319`, `src/components/events/event/index.vue:389`, `src/vuex/store.js:948` — вызывают без `await`) | **Оставить синхронным.** В upstream метод `async`: без патча `last.event` будет `undefined`, и правки сообщений молча перестанут подменять текст |
| `setRoomAvatarUrl(roomId, url)` | `client.ts` | **bastyon-chat** (`src/components/chatSettings/index.js:93`) | Оставить |
| `setRoomRetention(roomId, content)` | `client.ts` | **bastyon-chat** (`src/application/index.js:848`) | Оставить |
| `setInvitedAccess(roomId)` | `client.ts` | никто (grep по обоим проектам) | Можно не переносить |
| `RoomEvent.Avatar` (`"Room.avater"`) + reEmit в `sync.ts` | `models/room.ts`, `sync.ts`, `client.ts` | никто напрямую (grep по обоим проектам) | Можно не переносить; если оставляем — значение строки не менять |
| `useAuthorizationHeader ?? false` (токен в query) | `http-api/fetch.ts` | оба (неявно, через дефолт) | Оставить дефолт в форке. Альтернатива — передавать `useAuthorizationHeader: false` в `createClient` в обоих проектах |
| XHR-загрузка отключена (`usexml = false`) | `http-api/index.ts` | оба (неявно) | Оставить. Forta загружает файлы сама (`src/shared/lib/file-transfer/xhr-upload.ts`); для bastyon-chat не проверено |
| `ISendEventResponse.event_id?`, `addRule` → `string \| undefined` | `@types/requests.ts`, `models/invites-ignorer.ts` | типы | Можно не переносить |
| `export type *` → `export *` | `types.ts` | сборка bastyon-chat (старый TS/babel) | Проверить на сборке bastyon-chat; если не нужно — не переносить |
| Имя `matrix-js-sdk-bastyon`, `engines.node`, `typescript: 5.5.4` | `package.json` | — | Имя оставить; `engines` и `typescript` взять из upstream |

Отдельно в Forta: опция `request: this.request.bind(this)` в `matrix-client.ts` (сборка `userClientData`) — API
старого SDK, в v34 уже игнорируется. Решить при переходе: удалить или подключить через `fetchFn`.

## 4. Этапы

**Порядок работы.** Всё делается локально в `C:\inetpub2022\matrix-js-sdk` и проверяется на Forta Chat через
локальную сборку пакета. В npm публикует владелец пакета, только после этапа 6. До публикации `package.json`
Forta и bastyon-chat не меняется.

| # | Что | Где | Статус |
|---|---|---|---|
| 0 | Схема кэша для sliding sync | — | Решено: вариант A (раздел 5) |
| 1 | Ветка `bastyon` от тега upstream `v44.0.0` (или его патч-релиза; не `develop`). Перенести патчи «Оставить» из раздела 3: **один патч — один коммит**, каждая правка в upstream-файле помечена `// BASTYON: <зачем>`. Тесты патчей в `spec/unit/bastyon/` (раздел 7). `BASTYON.md` в корне форка: список патчей, зачем, кто использует, как обновляться | форк | Сделано 2026-10-13, ветка `bastyon` (раздел 10) |
| 2 | Forta на локальной сборке форка **с обычным `/sync`** (раздел 6): сборка, тесты, звонки (`iceServers` в `RTCPeerConnection` до и после совпадают), загрузки, правки сообщений | форк → Forta | Сборка и тесты — да; ручная проверка — `manual-verification.md` |
| 3 | Кэш sliding sync по варианту A (раздел 5) + тесты в `spec/unit/bastyon/` | форк | Не начато |
| 4 | Sliding sync в Forta за флагом на локальной сборке; замер на аккаунте с ~5000 комнат: время до списка чатов, холодный и тёплый старт, офлайн-старт | форк → Forta | Не начато |
| 5 | **Инструкции по использованию** (раздел 8): для Forta Chat и для bastyon-chat — как перейти на новую версию, что изменилось в API, как включить sliding sync и кэш, как проверить | форк (`BASTYON.md`) + Forta (`docs/`) | Не начато |
| 6 | Публикация в npm (владелец) с номером версии upstream (раздел 6) | npm | Не начато |
| 7 | Forta: зависимость на опубликованную версию, коммит | Forta | Не начато |
| 8 | bastyon-chat: переход по инструкции из этапа 5 — сборка (`export type *`, `node >= 22`), правки сообщений (`getLastReplacement`), аватар и retention комнаты, звонки | bastyon-chat | Не начато |

Можно выпустить промежуточную версию после этапа 2 (обновление SDK без смены протокола), если sliding sync
затянется. Тогда этапы 5–8 проходят дважды.

## 5. Кэш при sliding sync

**Проблема.** Upstream `SlidingSyncSdk` (`src/sliding-sync-sdk.ts`) не пользуется кэшем store:
нет `getSavedSync`, `setSyncData`, `save`. `pos` хранится в локальной переменной `SlidingSync.start()`
(`src/sliding-sync.ts`) и после перезапуска теряется. Итог: каждый холодный старт — пустой SDK и новое соединение
с сервером, офлайн-старта на уровне SDK нет.

**Что известно для решения:**

- Если восстановить комнаты в store до старта и продолжить со старым `pos`, сервер пришлёт дельты. Ветка
  `if (!roomData.initial)` в `SlidingSyncSdk` ожидает, что комната уже есть в store, — гидрация закрывает этот
  случай.
- `pos` старше 7 дней сервер не примет: нужно новое соединение. Кэш комнат при этом остаётся годным для показа,
  а данные с `initial: true` сливаются поверх.
- Требование: offline-first, желательно внутри matrix SDK (общий форк для обоих проектов).

**Решение (2026-10-13): вариант A** — ответы sliding sync идут в существующий `SyncAccumulator` /
`IndexedDBStore`, старт поднимается через существующий `SyncApi.syncFromCache`.

Что даёт upstream без патча:

- `SlidingSync` после каждого ответа шлёт `SlidingSyncEvent.Lifecycle` (`RequestFinished`) с целым ответом
  (`pos`, rooms, extensions) — кэш собирается подпиской, без правки ядра.
- `IndexedDBStore.setSyncData()` → `SyncAccumulator` → `save()` хранит данные вместе с токеном; `pos` ложится в
  `nextBatch`.
- `SyncApi.syncFromCache()` поднимает комнаты и шлёт `SyncState.Prepared`; конструктор `SyncApi` почти без
  побочных эффектов.

Правки в upstream-файлах (всего ~10–15 строк, все с `// BASTYON:`):

| Файл | Правка |
|---|---|
| `sliding-sync.ts` | `start(initialPos?)` — `pos` сейчас локальная переменная |
| `sync.ts` | `syncFromCache` доступен снаружи |
| `sliding-sync-sdk.ts` | в начале `sync()` — гидрация из кэша до сети (сейчас первым идёт сетевой `getPushRules`, офлайн застрянет); подписка на `Lifecycle` |
| `client.ts` | проброс опции кэша |

Логика — в новом файле `src/bastyon/sliding-sync-cache.ts`: перевод MSC4186 → v2 (`IJoinedRoom`), запись в
store, гидрация, протухший `pos`.

Что закрыть в реализации:

- **Смена режима.** В `nextBatch` лежит `pos`, не токен v2. Токен помечается префиксом; при смене режима
  (sliding ↔ `/sync`) кэш сбрасывается.
- **Протухший `pos`** (> 7 дней): upstream на любой 400 делает `resetup()`. Кэш остаётся, комнаты с `initial`
  сливаются поверх.
- **Имена и аватары.** В sliding sync `name` считает сервер, в кэше v2 — SDK из состояния. В `required_state`
  запрашивать `m.room.name`, `m.room.avatar` и участников для героев, иначе имена после офлайн-старта разойдутся
  с онлайновыми.

## 6. Локальная проверка и публикация

**Проверка на Forta до публикации.** Через `npm pack`, не `npm link`: симлинк ломает дедупликацию и
`optimizeDeps` у Vite.

Upstream 44 собирается pnpm 12 (`devEngines`); `npm pack`/`npm publish` внутри форка npm отклоняет. Закреплённый
pnpm запускать **вне** каталога форка (подробно — `BASTYON.md` в форке):

```bash
npx -y pnpm@12.3.4 --dir C:/inetpub2022/matrix-js-sdk pack   # сборка + matrix-js-sdk-bastyon-<версия>.tgz
cd C:/inetpub2025/forta.chat
npm install --no-save C:/inetpub2022/matrix-js-sdk/matrix-js-sdk-bastyon-<версия>.tgz
cat node_modules/matrix-js-sdk-bastyon/git-revision.txt   # совпадает с HEAD ветки bastyon
```

`--no-save` — `package.json` и lock-файл Forta не меняются до публикации. Откат: `npm ci`.

**Номер версии = версия upstream, на которую перешли** (для v44.0.0 — `44.0.0`). По номеру сразу видно, какой
upstream внутри. Мажор отличается от нынешнего `23.x`, поэтому ни Forta (`^23.2.5`), ни bastyon-chat (`23.2.4`)
не подтянут новую версию сами — только явным обновлением на этапах 7 и 8.

Открыто: npm не даёт опубликовать один номер дважды. Если понадобится исправление только в форке, без нового
релиза upstream, нужна схема номера (например, следующий патч `44.0.1`, рискуя совпасть с будущим upstream
`44.0.1`, или пре-релизный суффикс). Решить до первой такой правки.

**Откат.**

| Уровень | Как откатиться |
|---|---|
| Форк (git) | Работа идёт в новой ветке `bastyon`; `develop` (`3a3d964f`, 23.2.5) не трогается. Откат — переключиться на `develop` |
| Forta до публикации | `npm ci` — вернёт `23.2.5` из lock-файла |
| Forta после публикации | Вернуть `"matrix-js-sdk-bastyon": "23.2.5"` в `package.json` и `npm install`. Старые версии в npm остаются |
| Протокол (без смены SDK) | Sliding sync включается флагом; выключили — клиент работает по обычному `/sync`. Флаг runtime-настройка (без пересборки), чтобы переключать при ручной проверке. При смене режима кэш SDK сбрасывается (раздел 5), Dexie не трогается |
| Хранилище | SDK 44 поднимает схему кэша SDK в IndexedDB с 4 до 5 (store `user_profile`); 23.2.5 такую базу не открывает (`VersionError`). Закрыто в Forta: `sync-store-reset.ts` на `VersionError` удаляет кэш SDK и создаёт заново (полный `/sync`), Dexie не трогается. Работает в обе стороны, если откатывать на сборку Forta, где этот код уже есть. Проверить на устройстве: `docs/manual-verification.md` |

## 7. Тесты патчей в форке (`spec/unit/bastyon/`)

Фиксируют ровно то, что нам важно; после каждого rebase на новый upstream гоняются первыми.

- Формат TURN/STUN из `checkTurnServers` — сравнение с эталоном.
- `pickServersForId` — один `callId` даёт один и тот же набор у обеих сторон; 2 TURN + 2 STUN + 1 `stunGlobal`.
- `getLastReplacement()` возвращает событие, а не `Promise`.
- `getJSON(forDatabase)` отдаёт глубокую копию (объект с прокси/геттерами внутри сериализуется без ошибок).
- `setRoomAvatarUrl`, `setRoomRetention` шлют правильные state-события.
- Кэш: ответ sliding sync сохранён → перезапуск без сети → комнаты на месте, `SyncState.Prepared` → продолжение
  с сохранённым `pos`; протухший `pos`; смена режима.

## 8. Инструкции для потребителей (этап 5)

Два документа, по одному на проект. Каждый — коротко и по шагам:

- **Forta Chat** (`docs/matrix-sdk-fork.md`, ссылка из `AGENTS.md` → Docs index): какая версия, что изменилось
  в API по сравнению с 23.x, как включается sliding sync и кэш (опции `createClient`), как откатиться на
  обычный `/sync`, что проверить после обновления (звонки, правки, офлайн-старт).
- **bastyon-chat** (раздел в `BASTYON.md` форка): что поменять в коде при переходе с 23.2.x (сборка под
  `node >= 22`, `export type *`, все ли патчи на месте — `getLastReplacement`, `setRoomAvatarUrl`,
  `setRoomRetention`, TURN-формат, глубокая копия), чек-лист ручной проверки.
- В `BASTYON.md` — порядок обновления форка на новый upstream: `git fetch upstream --tags` → `git rebase <тег>`
  → `grep -rn "BASTYON:" src` → `yarn test spec/unit/bastyon` → полный `yarn test` → раздел 6.

## 9. Открытые вопросы

- Нужна ли XHR-загрузка bastyon-chat (патч `usexml`).
- Нужен ли `export type *` → `export *` для сборки bastyon-chat.
- Поддерживает ли сборка Forta (Vite) код upstream 43 на Android 7 WebView без дополнительной транспиляции
  `node_modules`.

## 10. Этап 1 — что сделано (2026-10-13)

Ветка `bastyon` в `C:\inetpub2022\matrix-js-sdk` от `v44.0.0`, по коммиту на патч; подробности — `BASTYON.md`
в форке. Отличия от решений раздела 3:

- **Транспорт** (`useAuthorizationHeader: false`, загрузки через fetch) задаётся не в HTTP-слое, а в
  `createClient()` (`src/bastyon/client-defaults.ts`). Оба потребителя создают клиент через
  `sdk.createClient`, так что для них поведение прежнее, а upstream-тесты (около 30) не пришлось менять.
  Явная опция побеждает.
- **`getLastReplacement()`**: публичный — синхронный, как в 23.x; асинхронный вариант upstream с расшифровкой
  оставлен приватным для внутреннего пути правок (иначе ломается агрегация правок в тредах).
- **Новый патч** — `sync-accumulator.ts`: локальная копия `MAX_STICKY_DURATION_MS`. В v44 импорт из
  `models/event` тянул в воркер стора весь `MatrixClient` с динамическим `import()`, и Vite не собирал
  IIFE-воркер Forta. Теперь воркер — 13 модулей вместо 153.
- `setInvitedAccess`, `RoomEvent.Avatar`, `export type *` → `export *` не перенесены (никто не использует).

В Forta: `sync-store-reset.ts` — сброс кэша SDK при `VersionError` (откат на 23.2.5 после 44, раздел 6).

Найдено после первого прохода (Forta типизирует клиент как `any`, поэтому `vue-tsc` такие вещи не ловит):

- **`tokenRefreshFunction` удалён в upstream** (обновление токена — только для OAuth2). Forta на нём держит
  перелогин по паролю при `M_UNKNOWN_TOKEN`. Возвращён патчем форка (`src/bastyon/token-refresh.ts`).
  Остальные опции `createClient`/`startClient` Forta сверены с v44 — есть; все вызываемые методы клиента есть.
- **SDK 44 вызывает `Promise.withResolvers` (Chrome 119 / Safari 17.4) и `WeakRef` (Chrome 84)** — на iOS 15–17.3
  и старом Android WebView первый запрос падал бы. Полифиллы — в форке (`src/bastyon/runtime-polyfills.ts`,
  импортируются первыми в `matrix.ts`), так что их получают оба потребителя. Воркеру стора они не нужны.
- **bastyon-chat (webpack 4) не собирался с 44:** `lib/` форка теперь собирается в ES2019 (`babel.config.cjs`,
  тест `lib-syntax.spec.ts`). Но зависимости SDK (`content-type`, `p-retry`) и `matrix-sdk-crypto-wasm`
  (`import.meta`) webpack 4 сам не разберёт — в bastyon-chat нужны правки `vue.config.js` (раздел 8,
  проверено на копии проекта: сборка проходит).
- Synapse поддерживает MSC4222 (`state_after`, SDK 44 запрашивает всегда), но выключен
  (`experimental_features.msc4222_enabled`, по умолчанию false) — сервер параметр игнорирует.

