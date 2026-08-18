# Склад — правила репозитория

Мобильное веб-приложение учёта остатков на складе + собственный сервер
синхронизации. Всё в этом репозитории; полное описание — в [`README.md`](README.md).

- **Фронтенд** — статический PWA, чистый HTML/CSS/JS без сборки (`index.html`,
  `assets/*`, `sw.js`, `manifest.webmanifest`, `icons/*`). Офлайн-первый: рабочее
  хранилище — `localStorage`, синк идёт фоном. Хостится на **GitHub Pages**
  (`https://y-gagar1n.github.io/sklad/`, `.nojekyll`, все пути относительные —
  работает из подпапки). Никаких секретов в статике нет.
- **Бэкенд** — один Go-бинарь (`backend/`): держит API синка, TLS через Let's
  Encrypt (`autocert`). Умеет и раздать апп (`-static`, резерв), но основной фронт
  на Pages — это другой origin, поэтому включён **CORS**: `-cors-origin` / env
  `SKLAD_CORS_ORIGIN` (через запятую; пусто — любой; авторизация всё равно по
  bearer-токену, поэтому `*` безопасен). Разворачивается на VM
  `yury-timofeev@213.165.212.180`, порт 443, изолированно от соседнего `todo-sync`.
- **Многотенантность** — токен = идентичность и граница изоляции. `-tokens-file`
  (`/etc/sklad-sync/tokens`, строки `tenantId: token`) задаёт соответствия; у
  каждого тенанта свой файл данных `-data-dir/<tenantId>.json` и свой `seq` — токен
  A не видит данные токена B. `tenantId` — стабильная метка (файл именуется по ней,
  не по токену), поэтому ротация токена сохраняет склад; на метку можно несколько
  токенов. Fallback: нет tokens-файла, но задан env `SKLAD_SYNC_TOKEN` → один тенант
  `default`. Реестр «кто есть кто» — локально `~/.config/sklad-sync/tokens`; управление
  — `./sklad-tokens.sh {list|add|rotate|remove}` (правит реестр, зеркалит на VM,
  рестартит сервис — без редеплоя). Ядро слияния от тенантов не зависит.

## ⛔ Секреты НЕ коммитить

**В репозиторий (он публичный) не попадает ни один секрет.** Никогда не
добавляй в git, в коммит-сообщения, в issue/PR и в скриншоты:

- **токены доступа** (реестр `tenantId: token`) — живут в `/etc/sklad-sync/tokens`
  на VM (mode 0600) и в `~/.config/sklad-sync/tokens` на dev-машине;
- приватные **TLS-ключи** (если когда-то используется режим `-tls-key`);
- содержимое `/etc/sklad-sync/{env,tokens}`, файлы из `~/.config/sklad-sync/`.

В репо — только код и публичные вещи. Данные сервера (`data/`, `tenants/`,
`sklad-sync.json`) и собранный бинарь — в `.gitignore`. Токен вводится на каждом
устройстве вручную (хранится в `localStorage`, не синкается) и подкладывается на
сервер через `bootstrap-sklad.sh`/`sklad-tokens.sh` по SSH — не через репозиторий.
Если токен утёк — `./sklad-tokens.sh rotate <tenantId>` (старый инвалидируется,
данные тенанта сохраняются), затем вбить новый на устройствах.

## Синхронизация — инварианты

- У каждой синкаемой записи есть `updatedAt` (ms, **монотонный** — см. `now()` в
  `store.js`) и `deleted` (тумбстоун вместо жёсткого удаления). Конфликты —
  whole-record **LWW по `updatedAt`**, одинаково для всех коллекций.
- Коллекции: `categories`, `items`, `floors`, `movements`, `settings`. **Движения
  иммутабельны** (создаются/тумбстоунятся, поля не меняют) → слияние = union по id.
- Device-local, **не синкается**: `activeFloorId`, свёрнутые категории, конфиг
  синка (адрес/токен).
- **При добавлении поля в модель** — добавить его в `COLLS` и в
  `exportRecords`/`applyServerRecords`/`replaceFromServerRecords` (`store.js`),
  иначе поле не будет синкаться. Клиентская логика синка — `assets/sync.js`,
  сервер «тупой» (opaque LWW + seq-курсор), менять его без нужды не стоит.
- Удаления — только тумбстоуны; геттеры в `store.js` фильтруют `deleted`. Не
  возвращать к жёсткому `filter`-удалению — иначе удаление не распространится.

## Деплой — изоляция от `todo`

Скрипты `deploy-sklad.sh`/`bootstrap-sklad.sh`/`sklad-tokens.sh` и юниты
`backend/deploy/*` работают **только** с namespace `sklad-sync`: пользователь
`sklad-sync`, каталоги `/opt|/var/lib|/etc|/var/backups/sklad-sync`, порт 443,
данные `/var/lib/sklad-sync/tenants/<tenantId>.json` (бэкап — tar.gz всего каталога).
**Не трогать** `todo-sync` (порт 8080, `/var/lib/todo-sync/todo-sync.json`) и
`agent-site` (порт 80). Деплой проверяет, что 443 не занят чужим сервисом.

**Авто-деплой бэка по пушу.** `.github/workflows/deploy-backend.yml`: push в ветку
Pages с правками в `backend/**`/`deploy-sklad.sh` → тесты (`./test.sh` + `go test
-race`) как гейт → тот же `deploy-sklad.sh` по SSH на VM (ручной прогон —
`workflow_dispatch`). Секреты приложения воркфлоу не трогает (`/etc/sklad-sync/env`
уже на VM); ему нужен лишь SSH-доступ — секреты `SKLAD_DEPLOY_SSH_KEY` (приватный
ключ отдельной deploy-пары) и `SKLAD_DEPLOY_KNOWN_HOSTS` в GitHub Actions. Приватный
ключ в репозиторий не коммитить. `deploy-sklad.sh` вручную остаётся резервом.

**После пуша — проследи за деплоем.** Пуш в `backend/**` запускает воркфлоу
`Deploy backend` (джобы `test` → `deploy`). Не считай задачу законченной сразу после
`git push`: дождись завершения прогона и убедись, что оба джоба зелёные (Actions:
`https://github.com/y-gagar1n/sklad/actions`, репо публичный — статус виден без
логина; либо косвенно — обновился mtime бинаря на VM и `/health` отвечает). Если
прогон упал — разберись и **почини** (падение тестов-гейта, ошибка сборки или SSH на
шаге деплоя), не оставляй прод в полудеплое.

## Тесты — на каждую фичу, и прогонять

- JS: `./test.sh` (node:test, без зависимостей) — `tests/{calc,store,sync,xlsx-import}.test.mjs`.
- Бэкенд: `cd backend && go test -race ./...`.
- Новое поле payload'а/синка → тест на merge в `tests/sync.test.mjs`. Новая ветка
  серверной логики → таблица-тест в `backend/main_test.go`. Бизнес-правила
  выносить из View в чистые функции и покрывать. Фича не готова, пока тесты не
  зелёные.

## Локальные правила

- Комментарии в коде и user-facing текст — **по-русски**.
- Бэкенд — Go, минимум зависимостей (единственная — `x/crypto/acme/autocert`).
- Фронтенд без сборки и без сторонних библиотек в рантайме.
- После добавления `.swift`… — не про этот репозиторий; здесь нет нативных
  клиентов, только веб.

## Команды

```bash
# локальный запуск сервера (localhost — secure-context, TLS не нужен)
# один тенант из env (fallback):
cd backend && SKLAD_SYNC_TOKEN=dev go run . -addr 127.0.0.1:8099 -static .. -data-dir /tmp/sklad-dev
# несколько тенантов через tokens-файл:
printf 'anya: aaa\nbob: bbb\n' > /tmp/sklad-tokens
cd backend && go run . -addr 127.0.0.1:8099 -tokens-file /tmp/sklad-tokens -data-dir /tmp/sklad-dev

./test.sh                          # JS-тесты
cd backend && go test -race ./...  # тесты сервера

./bootstrap-sklad.sh               # разово: секреты на VM (домен+CORS+реестр токенов)
./deploy-sklad.sh                  # деплой на VM
./sklad-tokens.sh add <tenantId>   # завести пользователя (без редеплоя)
```
