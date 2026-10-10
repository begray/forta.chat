# Удаление аккаунта (как в Pocketnet) — план — 2026-10-10

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-10-delete-account.md`. Начни с этапа «…». Перед правкой сверь
> > предпосылки этапа с кодом — номера строк в плане могут устареть, ориентируйся на имена функций.
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет.

## Статус (2026-10-10)

Этапы 1–3 сделаны, этап 4 ждёт проверки на тестовом аккаунте (`docs/manual-verification.md`).
Ответ на вопросы раздела 6: «всё как в Pocketnet» — шаг PeerTube есть, порядок PeerTube → Matrix →
блокчейн. Отличия от текста плана и от Pocketnet:

- PeerTube: полная цепочка Pocketnet (`oauth-clients/local` → `users/blockChainAuth` с подписью
  `peertube` → `users/token` → `DELETE users/{id}`), но в `id` уходит адрес, а не `undefined`.
  Модуль `shared/lib/peertube/remove-peertube-account.ts`; все серверы параллельно, 15 с на сервер.
- Сценарий — `entities/auth/lib/delete-account.ts` (`runDeleteAccount`), store — только проводка.
- Pocketnet после удаления остаётся залогиненным и перезагружается; у нас `logout()` сразу после
  транзакции: Matrix-аккаунт уже деактивирован.
- Интерфейс — `features/auth/ui/delete-account-button/DeleteAccountButton.vue`, а не правка
  модалки `SettingsPanel` (панель и так около 800 строк).
- Свой адрес в кэш удалённых не пишется: `logout()` всё равно сбрасывает user store.

## 1. Цель

В настройках есть пункт «Удалить аккаунт». Он удаляет аккаунт навсегда так же, как Bastyon (Pocketnet):
деактивирует аккаунт на сервере Matrix со стиранием данных и отправляет в блокчейн транзакцию `accDel`.
После этого приложение чистит локальные данные, как при выходе, и открывает экран приветствия.

Зачем: Apple (App Store 5.1.1(v)) и Google Play требуют удаления аккаунта внутри приложения, если в нём
можно зарегистрироваться. Регистрация у нас есть.

Вне объёма: экран «аккаунт удалён» при входе с ключом удалённого аккаунта и подпись «Аккаунт удалён» у
собеседников. Это отдельные задачи, см. раздел 7.

## 2. Как это сделано в Pocketnet

Код: `pocketnet/js/satolist.js`, `sdk.user.deleteaccount(progress)`; интерфейс —
`pocketnet/components/usersettings/index.js`, `actions.removeAccount`; строки — `localization/*.js`, ключи
`removeAccount*`.

1. **Подтверждение.** Диалог «Вы действительно хотите удалить аккаунт навсегда? Это действие невозможно
   будет отменить.» с кнопками «Отмена» и «Да, удалить аккаунт навсегда». Дальше — глобальный прелоадер и
   строка прогресса по шагам.
2. **`prepare`.** Профиль пользователя (`ustate.me`) должен быть загружен, иначе ошибка `notprepared`.
   Затем `account.updateUnspents()` и `account.actualBalance().actual`: если баланс нулевой, ошибка
   `balance` (транзакция платная).
3. **`removePeertube`.** `peertube/allservers` → `DELETE users/{id}` на каждом сервере, ошибки
   глотаются. **В коде ошибка:** `id: address.address`, где `address` — строка, то есть запрос уходит на
   `users/undefined`. Шаг фактически ничего не делает.
4. **`removeMatrix`.** `client.deactivateAccount(credentials, true)`: `erase = true`, `auth` — объект
   `{ type: "m.login.password", user, password, username, address, sessionId: "" }` из
   `matrixCredentials()` (пароль — `sha256(sha256(privateKey))`, тот же, что при входе). Ошибки
   глотаются, клиент пересоздаётся.
5. **`removeBB`.** `new DeleteAccount()` → `actions.addActionAndSendIfCan(obj)`; затем очистка кэша
   `userInfo` и `userState` своего адреса, `matrixchat.destroy()`, перечитывание профиля.
6. **Финал.** Сообщение «Удаление вашего аккаунта прошло успешно. В течение 10 минут процедура должна
   завершиться полностью.» и `app.reload({ href: 'authorn' })`.

Ошибки показываются диалогом: `removeAccount_notprepared`, `removeAccount_balance`,
`removeAccount_undefinedError`.

## 3. Что уже есть в Forta Chat

- Тип транзакции `DeleteAccount` (`type = 'accDel'`) — `public/js/kit.js`, регистрируется в
  `kit.js` (`accDel : DeleteAccount`). В `src/global.d.ts` не объявлен.
- Отправка действий — `AppInitializer.editUserData()` (`app-initializer.ts`): `UserInfo` →
  `actions.addActionAndSendIfCan(..., null, address)` с таймаутом 30 с и разбором ошибки. Удаление
  строится так же.
- Баланс — `actions.getCurrentAccount()` уже используется в `getAccountRegistrationStatus()`; у
  аккаунта есть `updateUnspents()` и `actualBalance()`, как в Pocketnet.
- Matrix: `MatrixClientService` хранит `credentials` (`username`, `password`) для
  `passwordLogin()`; у клиента SDK есть `deactivateAccount(auth, erase)`. `passwordLogin()` уже
  возвращает `null` для деактивированного аккаунта.
- Выход — `authStore.logout()` (`entities/auth/model/stores.ts`): сбрасывает сторы, пуши, Matrix, ключи,
  `localStorage`, Dexie, медиакэш.
- Настройки — `widgets/sidebar/ui/SettingsPanel.vue`, кнопка «Выйти» внизу.
- **Конфликт имён:** `authStore.removeAccount()` и ключи `settings.removeAccount*` уже заняты — это
  выход из аккаунта и удаление его из списка на устройстве. Новую функцию называем `deleteAccount`,
  ключи — `settings.deleteAccount*`.

## 4. Этапы

### Этап 1. Транзакция и Matrix (без интерфейса)

- `global.d.ts`: объявить `DeleteAccount`.
- `AppInitializer.deleteAccountOnChain(address)`: `new DeleteAccount()` →
  `addActionAndSendIfCan(obj, null, address)`, таймаут и разбор ошибки как в `editUserData()`.
- `AppInitializer.getActualBalance()`: `getCurrentAccount()` → `updateUnspents()` →
  `actualBalance().actual`; `null`, если аккаунта нет.
- `MatrixClientService.deactivateAccount()`: `client.deactivateAccount({ type: "m.login.password",
  user: credentials.username, password: credentials.password }, true)`. Форма `auth` — как в Pocketnet;
  проверить на сервере, см. вопрос 6.3.
- Тесты: моки `Actions`/клиента — правильный тип транзакции, адрес, `erase = true`, форма `auth`,
  таймаут.

### Этап 2. Сценарий удаления в auth store

`authStore.deleteAccount(onProgress)` — порядок шагов как в Pocketnet:

1. `prepare`: профиль загружен (`userInfo`), иначе `notprepared`; баланс > 0, иначе `balance`.
2. `removeMatrix`: `deactivateAccount()`, ошибка не прерывает сценарий (как в Pocketnet), но пишется в
   лог с префиксом.
3. `removeBB`: `deleteAccountOnChain()`; ошибка — `undefinedError`, сценарий останавливается.
4. Свой адрес — в кэш удалённых `bastyon-chat-deleted-users` (уже есть в `user-store.ts`).
5. `logout()` и переход на `WelcomePage`.

Защита от повторного нажатия: пока сценарий идёт, второй вызов возвращает тот же промис.

Тесты: порядок шагов; `balance`/`notprepared` останавливают до Matrix; сбой Matrix не мешает
транзакции; сбой транзакции не вызывает `logout()`; повторный вызов не запускает второй сценарий.

### Этап 3. Интерфейс

- `SettingsPanel.vue`: пункт «Удалить аккаунт» под «Выйти», цвет `text-color-bad`.
- Подтверждение тем же модальным окном, что уже используется в панели (`showRemoveConfirm`), с текстом и
  кнопками Pocketnet.
- Во время удаления — оверлей с текущим шагом («Подготовка», «Удаление данных с сервера чата»,
  «Удаление аккаунта из блокчейна»); закрыть его нельзя.
- Итог: успех — сообщение Pocketnet про 10 минут, затем экран приветствия; ошибка — текст по коду.
- Строки в `locales/en.ts` и `ru.ts` — переводы из Pocketnet.
- Тест компонента: кнопка → подтверждение → вызов `deleteAccount`; отмена ничего не вызывает.

### Этап 4. Проверка на устройстве

Удаление необратимо, поэтому только на тестовом аккаунте с небольшим балансом PKOIN. Запись в
`docs/manual-verification.md` в том же коммите, что и этап 3: транзакция `accDel` видна в блокчейне,
`getuserprofile` отдаёт `deleted: true`, вход в Matrix с тем же ключом не проходит, локальные данные
стёрты.

## 5. Риски

- **Порядок шагов.** Как в Pocketnet, Matrix деактивируется до транзакции. Если транзакция потом не
  уйдёт (сеть, баланс), чат уже удалён, а аккаунт в блокчейне жив. Pocketnet с этим живёт; см. вопрос 6.2.
- **Форма `auth` для Matrix.** Pocketnet передаёт `user` и лишние поля без `session`. Synapse принимает
  `auth` в первом запросе и устаревшее поле `user`, но сервер Bastyon может вести себя иначе, а ошибку
  Pocketnet глотает — не исключено, что там Matrix не удаляется вовсе. Проверить на тестовом аккаунте
  до этапа 3.
- **Мультиаккаунт.** Удаляется только активный аккаунт; остальные сессии на устройстве остаются.

## 6. Вопросы

1. **PeerTube.** В Pocketnet шаг не работает (`users/undefined`), а своих видео на PeerTube Forta Chat от
   имени пользователя не загружает. Предложение — пропустить шаг. Или повторить как есть?
2. **Порядок.** Повторить порядок Pocketnet (Matrix → блокчейн) или сначала блокчейн, а Matrix только
   после успешной транзакции? Второй вариант не оставляет «полуудалённый» аккаунт.
3. **Тестовый аккаунт** для этапа 4: какой адрес и кто пополнит баланс.

## 7. Потом

- Вход с ключом удалённого аккаунта: сейчас `passwordLogin()` возвращает ошибку деактивации; нужен
  понятный экран («Аккаунт удалён», как `deletedAccount_deleted` в Pocketnet).
- Собеседники: показывать «Аккаунт удалён» вместо адреса (данные уже есть в кэше удалённых).
