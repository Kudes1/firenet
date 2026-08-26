# Дизайн: многопользовательский режим (auth + git-ветки)

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
- рабочая версия (`main`) доступна всем на чтение, редактирование —
  только через личную ветку и merge request с ревью;
- реальное git-версионирование (ветки, коммиты, three-way merge с
  конфликт-маркерами), а не "последний сохранивший выиграл".

Не входит в эту фичу: живое совместное редактирование в реальном времени
(веткам это не нужно), применение правил на реальные устройства (и так вне
скоупа MVP — см. README), SSO/LDAP (только точка расширения на будущее),
структурный/entity-aware diff и merge (только построчный, как у обычного
`git diff`/`git merge`).

## Архитектура

Новые пакеты:

- **`internal/auth`** — пользователи, bcrypt-пароли, сессии
  (opaque-токен в httpOnly cookie), middleware `RequireAuth`/`RequireAdmin`.
  Аутентификация спрятана за интерфейсом `Authenticator`, чтобы позже
  подключить SSO/LDAP без переписывания хендлеров.
- **`internal/vcs`** — обёртка над bare-репозиторием `go-git`, полностью
  заменяет `FileProjectStore` как persistence-слой проекта: чтение/запись
  файла в конкретной ветке, ветвление, история, diff, three-way merge.
  Работает in-process, без внешнего `git`-бинарника и без checkout —
  каждая операция читает/пишет объекты репозитория напрямую.

Изменённые:

- **`internal/httpapi`** — существующие хендлеры (`getTopology`,
  `putRules` и т.п.) становятся branch-aware
  (`/api/branches/{branch}/...`), добавляются группы хендлеров auth,
  branches, merge-requests, users.
- **Web UI** — страница логина, переключатель текущей ветки в шапке
  (read-only индикатор на `main`, кнопка «Форкнуть» для начала правок),
  страница Merge Requests (список / диф / approve), страница
  пользователей (только admin).

`ProjectStore`-интерфейс из `store.go` был спроектирован как seam именно
под такое расширение — его форма (Read/Write topology/subnets/rules/layout)
сохраняется, просто у каждого метода появляется параметр ветки, а
единственная реализация становится git-based; прямая файловая реализация
остаётся только для одноразовой миграции существующих `*.yaml` в первый
коммит `main` при первом запуске новой версии.

## Модель данных

**Git-репозиторий** (bare, `go-git`), в корне дерева каждого коммита — те
же четыре файла, что и сейчас: `topology.yaml`, `subnets.yaml`,
`rules.yaml`, `layout.json`.

Ветки:

- `main` — рабочая версия, доступна всем на чтение, прямая запись
  запрещена (только через merge).
- `user/<username>/<branch-name>` — личная ветка, создаётся форком от
  текущего `main`; писать в неё может только её владелец.

**JSON-метаданные** (по образцу `writeFileAtomic` из `store.go`: временный
файл + rename, плюс мьютекс в процессе на каждый файл):

```go
// users.json
type User struct {
    ID           string
    Username     string
    PasswordHash string // bcrypt
    Role         string // "admin" | "user"
    CreatedAt    time.Time
}

// sessions.json
type Session struct {
    Token     string
    UserID    string
    ExpiresAt time.Time
}

// merge_requests.json
type MergeRequest struct {
    ID           string
    SourceBranch string
    TargetBranch string // всегда "main"
    Author       string
    Status       string // "open" | "conflict" | "merged" | "closed"
    CreatedAt    time.Time
    MergedAt     *time.Time
    MergedBy     string
}
```

Протухшие сессии вычищаются при чтении `sessions.json`.

**Конкурентная запись в одну ветку** — CAS по хешу текущего коммита
ветки: `GET .../{branch}/topology` отдаёт заголовок `X-Commit: <sha>`,
`PUT` требует его обратно; несовпадение (кто-то уже закоммитил в эту же
ветку, например из второй открытой вкладки) → `409`, клиент перечитывает
и повторяет правку поверх свежих данных.

## `internal/vcs`

```go
package vcs

type Store struct{ repo *git.Repository }

func Open(path string) (*Store, error)
func Init(path string, seed map[string][]byte) (*Store, error)

func (s *Store) ReadFile(branch, path string) (content []byte, commit string, err error)
func (s *Store) WriteFile(branch, path string, content []byte, expectCommit string, author User, message string) (newCommit string, err error) // ErrCommitMismatch на CAS-конфликт

func (s *Store) CreateBranch(from, name string, owner string) error
func (s *Store) ListBranches() ([]BranchInfo, error) // включает Owner
func (s *Store) DeleteBranch(name string) error
func (s *Store) History(branch string, limit int) ([]CommitInfo, error)

func (s *Store) Diff(base, head string) ([]FileDiff, error) // построчный unified diff на файл

type MergeResult struct {
    Merged   bool
    Commit   string              // если Merged
    Conflicts map[string][]byte  // path -> контент с <<<<<<< маркерами, если не Merged
}
func (s *Store) Merge(source, target string, actor User) (MergeResult, error)
```

`Merge` находит общего предка (merge-base) `source` и `target`, для
каждого из четырёх файлов делает three-way merge построчным diff3-алгоритмом
(реализуется в пакете, без внешних зависимостей на сам merge — только
чтение объектов через `go-git`). Если хотя бы один файл конфликтует —
`Merged=false`, `Conflicts` содержит итоговый текст со стандартными
`<<<<<<<`/`=======`/`>>>>>>>` маркерами для каждого затронутого файла (не
затронутые конфликтом файлы берутся из `source` как есть). Если конфликтов
нет — создаётся merge-коммит с двумя родителями, ref `target` двигается
на него (тоже через CAS, на случай гонки с другим merge).

## Request-флоу

**Просмотр:** UI по умолчанию открывает `main` в read-only режиме — все
кнопки сохранения задизейблены, виден баннер «только чтение, форкните
ветку для правок». `GET /api/branches/{branch}/{topology|subnets|rules|layout}`
работает для любой ветки, видимой пользователю (все ветки читаемы всеми
авторизованными — нужно для ревью MR).

**Начало правок:** `POST /api/branches {from: "main", name: "..."}` →
`vcs.CreateBranch`, владелец — текущий пользователь. UI переключается на
неё, кнопки Save становятся активными.

**Редактирование:** `PUT /api/branches/{branch}/{...}` — `403`, если
текущий пользователь не владелец ветки или ветка — `main`. Иначе —
`vcs.WriteFile` с CAS (раздел «Модель данных»).

**Merge request:** `POST /api/merge-requests {sourceBranch}` (`target`
всегда `main`) — только владелец `sourceBranch`. `GET
/api/merge-requests/{id}` — построчный diff по каждому изменённому файлу
между `main` и веткой (`vcs.Diff`), виден всем авторизованным.

**Approve/merge:** `POST /api/merge-requests/{id}/approve` затем
`POST .../merge` — только `admin`. `merge` вызывает `vcs.Merge(source,
"main", actor)`:
- чисто → MR → `merged`, `MergedAt`/`MergedBy` проставляются;
- конфликт → MR → `conflict`, тело ответа — конфликтующие файлы с
  маркерами (то же, что вернул бы `vcs.Merge`).

**Разрешение конфликта** — на стороне автора ветки, не admin: у владельца
ветки есть `POST /api/branches/{branch}/sync-main`, который делает
`vcs.Merge("main", branch, actor)` (в обратную сторону — вливает свежий
`main` в его личную ветку) тем же движком. При конфликте — тот же формат
ответа с маркерами; конфликтующий файл просто открывается в текстовом
редакторе страницы как есть (с маркерами внутри YAML), автор правит
руками и сохраняет обычным `PUT` (это и есть разрешение конфликта — новый
коммит в его ветке без маркеров). После этого повторный `merge` со
стороны admin проходит чисто.

## Права и ошибки

`RequireAuth` — на весь `/api/*` и `/ui/*`, кроме `/login`.
`RequireAdmin` — на управление пользователями и approve/merge MR.

| Действие | admin | user (не владелец) | user (владелец ветки) |
|---|---|---|---|
| читать `main`/любую ветку/MR-диффы | ✅ | ✅ | ✅ |
| форкнуть ветку от `main` | ✅ | ✅ | — |
| писать в свою ветку | ✅ | ❌ | ✅ |
| открыть MR из своей ветки | ✅ | ❌ | ✅ |
| approve/merge MR | ✅ | ❌ | ❌ |
| управлять пользователями | ✅ | ❌ | ❌ |

Ошибки: `401` (+ редирект на `/login` для UI-роутов, JSON для API) при
отсутствии/протухшей сессии; `403` при записи в чужую ветку или `main`
напрямую, а также при недостатке роли; `409` при CAS-конфликте на `PUT`.
Мердж-конфликт — не HTTP-ошибка, а обычный ответ со статусом MR
`conflict` и телом-диффом.

## Миграция

При первом запуске новой версии `firenet serve`, если git-репозитория в
data-директории ещё нет — он инициализируется, текущее содержимое
`topology.yaml`/`subnets.yaml`/`rules.yaml`/layout (или seed-заглушки,
как сейчас делает `EnsureSeeded`) становится первым коммитом `main`.
Одновременно, раз UI регистрации пока нет, обязателен bootstrap первого
admin-аккаунта из `FIRENET_ADMIN_USER`/`FIRENET_ADMIN_PASSWORD` — без них
сервер с пустым `users.json` не стартует.

`FileProjectStore` и однопользовательский режим `serve` полностью
заменяются `internal/vcs`, без флага совместимости — по стилю проекта
(без backward-compat костылей для уже вышедшей в разработке функциональности).

## Тестирование

| Слой | Что покрываем |
|------|----------------|
| `internal/vcs` | создание repo во временной директории; чтение/запись/CAS-конфликт на PUT; создание/список/удаление веток; three-way merge — чистый случай и случай с конфликтом на каждом из четырёх файлов; `sync-main` в обе стороны |
| `internal/auth` | выдача/протухание сессии, bcrypt hash/verify, middleware пропускает/блокирует по роли |
| `internal/httpapi` | новые хендлеры (branches, merge-requests, users, login/logout) через `httptest`, по образцу `handlers_test.go`; старые branch-aware хендлеры — happy path + 403/409 |
| web (`node --test`) | переключатель ветки, read-only баннер на `main`, экран MR-диффа с конфликт-маркерами |

Без ручного браузерного прогона на каждое изменение — только автотесты
(`go build ./...`, `go vet ./...`, `gofmt -l .`, `go test ./...`,
`node --test 'internal/httpapi/web/*.test.js'`).
