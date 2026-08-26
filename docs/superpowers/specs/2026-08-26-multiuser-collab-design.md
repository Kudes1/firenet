# Дизайн: многопользовательский режим (auth + версионирование сущностей)

Дата: 2026-08-26
Статус: принят к реализации

## Контекст и цели

Сегодня `firenet serve` — однопользовательский HTTP-сервер без какой-либо
авторизации (`internal/httpapi/server.go`). `FileProjectStore`
(`internal/httpapi/store.go`) хранит один проект как четыре файла на диске
(`topology.yaml`, `subnets.yaml`, `rules.yaml`, layout), и `PUT
/api/topology|subnets|rules|layout` перезаписывают их целиком — при
параллельном сохранении второй запрос молча затирает правки первого.

Цель — дать команде из 2–8 человек безопасно работать над ОДНИМ общим
проектом одновременно:

- вход по логину/паролю, роли `admin`/`user`;
- текущая подтверждённая версия проекта видна всем на чтение, правки —
  только в личном черновике, применяются в неё только через подтверждение
  админом;
- версионирование результата: полная история подтверждённых изменений,
  дифф между любыми двумя версиями, откат к прошлой версии.

**Решение об архитектуре хранения:** рассматривались git-подобный подход
(ветки/коммиты/three-way merge построчным diff3) и подход на структурных
сущностях. Выбран второй: `topology.yaml`/`subnets.yaml`/`rules.yaml` —
это и так списки именованных сущностей (устройство, сеть, набор, объединение,
подсеть, правило внутри цепочки — см. `internal/httpapi/dto.go`), а не
свободный текст. Построчный merge может показать ложный конфликт там, где
два человека правили разные сущности, физически оказавшиеся рядом в
YAML. Версионирование на уровне сущностей избавляет от этого класса
ложных конфликтов и не требует своей реализации diff3/CAS-по-рефам —
конкурентность и атомарность решаются транзакциями обычной БД.

Не входит в эту фичу: живое совместное редактирование в реальном времени,
применение правил на реальные устройства (вне скоупа MVP — см. README),
SSO/LDAP (только точка расширения на будущее).

## Архитектура

Новые пакеты:

- **`internal/auth`** — пользователи, bcrypt-пароли, сессии
  (opaque-токен в httpOnly cookie), middleware `RequireAuth`/`RequireAdmin`.
  Аутентификация спрятана за интерфейсом `Authenticator`, чтобы позже
  подключить SSO/LDAP без переписывания хендлеров.
- **`internal/pgstore`** — Postgres-backed реализация версионирования и
  черновиков, полностью заменяет `FileProjectStore`. Наружу отдаёт те же
  DTO-типы, что уже определены в `internal/httpapi/dto.go`
  (`TopologyDoc`, `SubnetsDoc`, `PolicyDoc`, layout) — существующие
  хендлеры `getTopology`/`putRules`/... почти не меняются, просто читают
  и пишут через черновик вместо файла; вся entity-level логика (диффы,
  конфликты, история) спрятана внутри пакета.

Изменённые:

- **`internal/httpapi`** — хендлеры становятся draft-aware
  (`/api/drafts/{id}/...`), добавляются группы: auth, drafts, versions,
  users.
- **Web UI** — страница логина, индикатор текущей версии в шапке
  (read-only, только "Открыть черновик" для начала правок), страница
  черновиков с кнопкой «Отправить на подтверждение», страница истории
  версий (список + дифф), страница пользователей (только admin).

## Модель данных (PostgreSQL)

Все сущности проекта (устройство, сеть, набор, объединение, подсеть,
правило, цепочка, элемент layout) хранятся не как блоб YAML/JSON, а как
строки с натуральным ключом и версией, в которой они появились:

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Подтверждённая история. Append-only, линейная (без веток).
CREATE TABLE versions (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by UUID REFERENCES users(id),
  draft_id     UUID,        -- какой черновик подтверждён (без FK — см. ниже)
  note         TEXT         -- напр. "restored to v5"
);

-- Одна строка = одна сущность, изменившаяся в данной версии.
CREATE TABLE entity_changes (
  id         BIGSERIAL PRIMARY KEY,
  version_id BIGINT NOT NULL REFERENCES versions(id),
  kind       TEXT NOT NULL, -- device|link|network|set|union|subnet
                             -- |chain|rule|layout_device|layout_network
                             -- |layout_link|layout_camera
  key        TEXT NOT NULL, -- натуральный ключ, напр. имя устройства;
                             -- "chain::rule" для правил; "a|b" для links
  change     TEXT NOT NULL CHECK (change IN ('added','modified','removed')),
  data       JSONB,         -- NULL при change='removed'
  author     UUID NOT NULL REFERENCES users(id)
);
CREATE INDEX entity_changes_lookup ON entity_changes (kind, key, version_id DESC);

-- Личный черновик: правки поверх конкретной базовой версии.
CREATE TABLE drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner           UUID NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  base_version_id BIGINT NOT NULL REFERENCES versions(id),
  status          TEXT NOT NULL DEFAULT 'open', -- open|conflict|merged|closed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

-- Текущее состояние правок черновика: по одной строке на затронутую
-- сущность (не история — перезаписывается при каждом сохранении).
CREATE TABLE draft_entity_changes (
  draft_id UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  key      TEXT NOT NULL,
  change   TEXT NOT NULL CHECK (change IN ('added','modified','removed')),
  data     JSONB,
  PRIMARY KEY (draft_id, kind, key)
);
```

`versions.draft_id` намеренно без FK на `drafts` — иначе цикл
`versions ↔ drafts` (`drafts.base_version_id → versions`,
`versions.draft_id → drafts`); ссылка нужна только для отображения "какой
черновик стал этой версией" в истории, не для целостности.

**Текущее состояние сущности** (для сборки `TopologyDoc`/`SubnetsDoc`/
`PolicyDoc`/layout на чтение) = для каждого `(kind, key)` строка
`entity_changes` с максимальным `version_id ≤ N`, если её `change != removed`.
Тот же запрос с `N = текущая последняя версия` даёт "главную" версию,
с произвольным `N` — снимок любой прошлой версии.

**Черновик на чтение** = состояние базовой версии, с точечной заменой по
`(kind, key)` из `draft_entity_changes` (added/modified — берётся `data`
черновика, removed — сущность выкидывается).

## `internal/pgstore`

```go
package pgstore

// Только чтение подтверждённой истории.
func (s *Store) CurrentVersion(ctx) (int64, error)
func (s *Store) ReadAt(ctx, version int64) (ProjectDoc, error)
func (s *Store) History(ctx, limit int) ([]VersionInfo, error)
func (s *Store) DiffVersions(ctx, from, to int64) ([]EntityDiff, error)
func (s *Store) Restore(ctx, toVersion int64, actor User) (newVersion int64, err error)

// Черновики.
func (s *Store) CreateDraft(ctx, owner User, name string) (Draft, error) // baseVersion = текущая последняя
func (s *Store) ListDrafts(ctx, owner *User) ([]Draft, error)            // owner=nil — все (для ревью)
func (s *Store) ReadDraft(ctx, draftID string) (doc ProjectDoc, revision string, err error)
func (s *Store) WriteDraft(ctx, draftID string, doc ProjectDoc, expectRevision string) (newRevision string, err error) // ErrRevisionMismatch на CAS-конфликт
func (s *Store) DeleteDraft(ctx, draftID string) error

func (s *Store) DiffDraft(ctx, draftID string) ([]EntityDiff, error)       // vs base_version
func (s *Store) Conflicts(ctx, draftID string) ([]EntityConflict, error)   // пересечение с тем, что изменилось между base и текущей версией
func (s *Store) Confirm(ctx, draftID string, admin User) (newVersion int64, conflicts []EntityConflict, err error)
```

`WriteDraft` сравнивает входящий `ProjectDoc` с состоянием базовой версии,
вычисляет добавленные/изменённые/удалённые сущности и одним `UPSERT`
записывает их в `draft_entity_changes` (плюс `DELETE` для сущностей,
вернувшихся к состоянию базовой версии — черновик хранит только реальные
отличия). CAS — обычная `UPDATE drafts SET updated_at=now() WHERE id=$1
AND updated_at=$2`; 0 обновлённых строк → `ErrRevisionMismatch` → `409`
(гонка второй вкладки того же пользователя).

`Confirm` в одной транзакции: для каждого `(kind,key)` в
`draft_entity_changes` сравнивает состояние на `base_version_id` и на
текущей последней версии; если хоть где-то есть расхождение — коммит
откатывается, возвращается список `EntityConflict` (сущность, значение в
черновике, текущее значение), `drafts.status = 'conflict'`, версия не
создаётся. Если конфликтов нет — вставляется новая строка `versions`,
для каждой затронутой сущности — строка в `entity_changes` со значением
из черновика, `drafts.status = 'merged'`.

## Request-флоу

**Просмотр:** UI по умолчанию открывает текущую версию в read-only —
`GET /api/versions/current/{topology|subnets|rules|layout}`. Кнопки
сохранения скрыты; виден баннер «только чтение» и кнопка «Открыть
черновик».

**Начало правок:** `POST /api/drafts {name}` → `pgstore.CreateDraft` от
текущей версии, владелец — текущий пользователь. Можно иметь несколько
именованных черновиков параллельно.

**Редактирование:** `GET/PUT /api/drafts/{id}/{topology|subnets|rules|layout}`
— `403`, если не владелец. `PUT` — `pgstore.WriteDraft` с CAS по ревизии
из предыдущего `GET` (заголовок `X-Draft-Revision`).

**Отправка на подтверждение:** явного отдельного MR-объекта не заводим —
черновик сам по себе и есть заявка; `GET /api/drafts/{id}/diff` (список
затронутых сущностей, `pgstore.DiffDraft`) виден владельцу и всем admin
для ревью.

**Подтверждение:** `POST /api/drafts/{id}/confirm` — только admin.
- Конфликтов нет → `pgstore.Confirm` создаёт версию, черновик закрывается
  (`merged`), в ответе — номер новой версии.
- Конфликты есть → `409` с телом `EntityConflict[]` (сущность: значение в
  черновике / текущее значение), `drafts.status = 'conflict'`.

**Разрешение конфликта** — на стороне автора черновика, не admin:
конфликтующие сущности приходят через `GET /api/drafts/{id}/diff`
(конфликтные помечены отдельно) прямо в форму редактирования — конкретные
устройство/сеть/правило с обоими вариантами полей; автор решает, какое
значение оставить, сохраняет обычным `PUT` (это меняет
`draft_entity_changes`, конфликт этой сущности снят). Admin повторно жмёт
«Подтвердить» — на этот раз конфликта по этой сущности уже нет.

**История:** `GET /api/versions?limit=N` — список версий с changelog;
`GET /api/versions/diff?from=X&to=Y` — дифф между любыми двумя;
`POST /api/versions/{n}/restore` (только admin) — откат: создаёт новую
версию, содержимое которой равно версии `n`.

## Права и ошибки

`RequireAuth` — весь `/api/*` и `/ui/*`, кроме `/login`.
`RequireAdmin` — подтверждение/откат версий и управление пользователями.

| Действие | admin | user (не владелец) | user (владелец черновика) |
|---|---|---|---|
| читать текущую версию/историю/чужой дифф черновика | ✅ | ✅ | ✅ |
| создать черновик | ✅ | ✅ | — |
| писать в черновик | ✅ (свой) | ❌ | ✅ |
| подтвердить/отклонить черновик | ✅ | ❌ | ❌ |
| откат версии | ✅ | ❌ | ❌ |
| управлять пользователями | ✅ | ❌ | ❌ |

Ошибки: `401` (+ редирект на `/login` для UI, JSON для API) без валидной
сессии; `403` при записи в чужой черновик или недостатке роли; `409` при
CAS-гонке на `PUT` черновика **и** при конфликте на `confirm` (в обоих
случаях тело ответа объясняет, что именно разошлось, чтобы клиент мог
показать актуальные данные, не просто "ошибка").

## Деплой

`docker-compose.yml` с двумя сервисами:

- **`app`** — образ firenet (Go-бинарник, как сейчас, плюс подключение к
  Postgres через `DATABASE_URL`); флаги/env первого запуска
  `FIRENET_ADMIN_USER`/`FIRENET_ADMIN_PASSWORD` для бутстрапа первого
  admin-аккаунта, если таблица `users` пуста.
  Драйвер — `pgx` (без cgo, тот же принцип "один статический бинарник",
  что уже соблюдается для веб-ассетов через `go:embed`).
- **`db`** — `postgres:16`, именованный volume для данных, healthcheck,
  `app` стартует по `depends_on: db: condition: service_healthy`.

Миграции — набор пронумерованных `.sql`-файлов, встроенных через
`go:embed` (по аналогии с уже встроенными веб-ассетами), применяются
автоматически при старте `app` (таблица `schema_migrations` отслеживает
применённые) — без отдельного шага/контейнера для миграций и без
тяжёлого migration-фреймворка, которого проекту такого размера не нужно.

## Миграция существующих данных

При первом запуске новой версии, если `versions` пуста — текущие
`topology.yaml`/`subnets.yaml`/`rules.yaml`/layout (или seed-заглушки, как
сейчас делает `EnsureSeeded`) парсятся в сущности и записываются как
версия 1 без автора-черновика (`draft_id = NULL`, `note = "initial
import"`). `FileProjectStore` и однопользовательский режим `serve`
полностью заменяются `internal/pgstore`, без флага совместимости — по
стилю проекта (без backward-compat костылей для функциональности, ещё не
вышедшей в релиз).

## Тестирование

| Слой | Что покрываем |
|------|----------------|
| `internal/pgstore` | против реального Postgres в докере (`testcontainers-go` или `docker-compose` в CI) либо `pgx`-совместимого in-memory — таблица случаев: чтение/запись черновика с CAS-конфликтом; сборка `ProjectDoc` из сущностей на текущей версии и на произвольной прошлой; `Confirm` без конфликтов; `Confirm` с конфликтом на одной сущности из нескольких; `Restore` |
| `internal/auth` | выдача/протухание сессии, bcrypt hash/verify, middleware пропускает/блокирует по роли |
| `internal/httpapi` | новые хендлеры (drafts, versions, users, login/logout) через `httptest`; старые draft-aware хендлеры — happy path + 403/409 |
| web (`node --test`) | read-only баннер на текущей версии, экран диффа черновика с выделенными конфликтами |

Без ручного браузерного прогона на каждое изменение — только автотесты
(`go build ./...`, `go vet ./...`, `gofmt -l .`, `go test ./...`,
`node --test 'internal/httpapi/web/*.test.js'`).
