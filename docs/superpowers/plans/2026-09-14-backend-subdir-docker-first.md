# Backend Subdir + Docker-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести Go-бэкенд в `backend/` и перевести запуск, сборку и юнит-тесты на docker compose так, чтобы на хосте не требовались Go и Node.

**Architecture:** `go.mod`/`go.sum`, `cmd/`, `internal/`, `Dockerfile` и `.dockerignore` переезжают в `backend/` (module path `github.com/kudes1/firenet` не меняется). `docker-compose.yml`, `Makefile`, `nginx/`, документация остаются в корне. В Dockerfile'ах бэкенда и фронтенда добавляются `test`-стейджи, в compose — сервисы под профилем `test`. Makefile оборачивает compose; e2e на переходный период остаётся гибридным: Playwright, Node/Vite и `bin/firenet` работают на хосте, PostgreSQL запускается в Docker.

**Tech Stack:** Go 1.25, Docker Compose 5.5.1, postgres:16-alpine, Vite/React (Vitest), Playwright (временное гибридное исключение для e2e).

**Spec:** `docs/superpowers/specs/2026-09-14-backend-subdir-docker-first-design.md`

## Global Constraints

- Module path остаётся `github.com/kudes1/firenet` — ни один Go-импорт не редактируется.
- `docker-compose.yml`, `Makefile`, `nginx/firenet.conf`, `frontend/`, `e2e/`, `docs/` остаются в корне.
- Хостовая сборка Go/Node не предполагается: все цели Makefile, кроме `test-e2e`, не вызывают `go`/`npm` на хосте.
- `test-e2e` — единственное задокументированное гибридное исключение: Playwright, Node/Vite и `bin/firenet` запускаются на хосте, PostgreSQL — во временном Docker-контейнере; нужны Docker, Node, зависимости `frontend/` и `e2e/`, `npx playwright` и Chromium.
- API-контракт, миграции, `internal/*` по смыслу не меняются — это только переезд и упаковка.
- Каждая задача заканчивается рабочим состоянием репозитория и отдельным коммитом. Единственное явное исключение — `make test-e2e` между Task 1 и Task 2 (см. пометку в Task 1, Step 4).

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `backend/go.mod`, `backend/go.sum` | Go-модуль после переезда |
| `backend/cmd/`, `backend/internal/` | Код бэкенда после переезда |
| `backend/Dockerfile` | Стейджи `build`, `runtime`, `test` бэкенда |
| `backend/.dockerignore` | Контекст сборки `./backend` |
| `frontend/Dockerfile` | Стейджи `deps`, `dev`, `build`, `runtime`, `test` |
| `docker-compose.yml` | `backend` с `context: ./backend`; `backend-test`, `frontend-test` под профилем `test` |
| `Makefile` | Обёртки compose; `bin` извлекает бинарь для e2e |
| `AGENTS.md`, `README.md` | Верификация и структура под docker-first |

---

### Task 1: Переезд бэкенда в `backend/`

**Files:**
- Move: `go.mod` → `backend/go.mod`, `go.sum` → `backend/go.sum`, `cmd/` → `backend/cmd/`, `internal/` → `backend/internal/`, `Dockerfile` → `backend/Dockerfile`, `.dockerignore` → `backend/.dockerignore`
- Modify: `docker-compose.yml` (сервис `backend`: `build: .` → `build.context: ./backend`)
- Modify: `Makefile` (`build`, `run`, `dev`)

**Interfaces:**
- Produces: `docker compose build backend` собирает образ из `./backend`; `make build` / `make dev` работают без хостового Go.
- Consumes: ничего из предыдущих задач.

- [ ] **Step 1: Переместить код и артефакты через `git mv`**

```bash
mkdir -p backend
git mv go.mod go.sum cmd internal backend/
git mv Dockerfile backend/Dockerfile
git mv .dockerignore backend/.dockerignore
```

Ожидание: `git status --short` показывает переименования (`R`), а не удаление+добавление по возможности; `backend/` содержит `go.mod`, `cmd/`, `internal/`, `Dockerfile`, `.dockerignore`.

- [ ] **Step 2: Проверить, что `Dockerfile` не требует правок путей**

`backend/Dockerfile` использует `COPY go.mod go.sum ./`, `COPY . .` и `go build ./cmd/firenet` — все пути относительны контекста и после переезда корректны. Ничего не менять.

- [ ] **Step 3: Указать compose на новый контекст**

В `docker-compose.yml` заменить у сервиса `backend`:

```yaml
  backend:
    build: .
```

на:

```yaml
  backend:
    build:
      context: ./backend
```

Остальные поля сервиса `backend` (`restart`, `depends_on`, `environment`, `ports`) не трогать.

- [ ] **Step 4: Обновить `build`/`run`/`dev` в Makefile**

Заменить текущий блок:

```makefile
build:
	go build -o $(BIN_DIR)/$(BINARY) ./cmd/firenet

run:
	go run ./cmd/firenet

dev:
	docker compose up -d --build
```

на:

```makefile
build:
	docker compose build backend

run:
	docker compose up --build

dev:
	docker compose up -d --build
```

> **Известное временное исключение:** `test-e2e` в этом шаге всё ещё зависит
> от старого `build` (`test-e2e: build`), а новый `build` собирает только
> docker-образ и больше **не создаёт `bin/firenet`**. `e2e/global-setup.js`
> спавнит `bin/firenet`, поэтому между Task 1 и Task 2 хостовый e2e может
> использовать устаревший бинарь или упасть на чистом клоне (`bin/` в
> `.gitignore`). Это осознанная переходная дырка: Task 2 (Step 3) меняет
> зависимость на `test-e2e: bin` и добавляет саму цель `bin`. До Task 2
> `make test-e2e` не считается валидным; остальные цели Task 1 рабочие.

- [ ] **Step 5: Собрать образ**

Run: `docker compose build backend`
Expected: сборка успешна, образ `firenet-backend` создан без ошибок COPY.

- [ ] **Step 6: Дымовой прогон всего стека**

```bash
docker compose up -d --build
docker compose ps
```

Expected: сервисы `db`, `backend`, `frontend` в состоянии `running` (после прогрева). Проверить API:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/login
```

Expected: `405` (эндпоинт существует, метод не POST) или иной не-`404`/не connection-refused ответ — главное, сервер отвечает.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(backend): move Go module into backend/ subdir"
```

---

### Task 2: Backend test-стейдж, compose-сервис и цели Makefile

**Files:**
- Modify: `backend/Dockerfile` (добавить стейдж `test` в конец)
- Modify: `docker-compose.yml` (добавить `target: runtime` сервису `backend`; добавить `backend-test`)
- Modify: `Makefile` (добавить `bin`, `test`, `vet`, `fmt`, `tidy`; `test-e2e` зависит от `bin`)

**Interfaces:**
- Consumes: `backend/Dockerfile` с стейджем `build` (Task 1).
- Produces: цель `make bin` кладёт бинарь в `bin/firenet`; `make test`/`make vet`/`make fmt`/`make tidy` работают без хостового Go; сервис `backend-test` под профилем `test`.

- [ ] **Step 1: Добавить стейдж `test` в `backend/Dockerfile`**

Дописать в конец файла (после стейджа `runtime`):

```dockerfile
FROM golang:1.25-alpine AS test
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
CMD ["go", "test", "./..."]
```

> **Важно:** без `--target` docker собирает последний стейдж, поэтому после
> добавления `test` в конец дефолтной сборкой станет он. Чтобы сервис
> `backend` по-прежнему запускал `runtime`, Step 2 явно фиксирует
> `target: runtime` (как у сервиса `frontend`). Без этого `docker compose
> up -d --build` поднимет golang-образ и выполнит `go test`, а не сервер.

- [ ] **Step 2: Добавить `target: runtime` сервису `backend` и сервис `backend-test`**

В `docker-compose.yml` у сервиса `backend` дополнить блок `build`:

```yaml
  backend:
    build:
      context: ./backend
      target: runtime
```

Остальные поля сервиса `backend` не трогать (существующие `restart`,
`depends_on`, `environment`, `ports` остаются как есть).

Затем дописать в блок `services` (например, после сервиса `backend`):

```yaml
  backend-test:
    profiles: ["test"]
    build:
      context: ./backend
      target: test
    depends_on:
      db:
        condition: service_healthy
    environment:
      FIRENET_TEST_DATABASE_URL: postgres://firenet:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/firenet?sslmode=disable
```

`ports` и `restart` не добавлять: сервис одноразовый.

- [ ] **Step 3: Обновить Makefile — цели бэкенда и `bin`**

Заменить блок:

```makefile
test:
	go test ./...

fe-test:
	cd frontend && npm test

fe-build:
	cd frontend && npm run build

test-e2e: build
	cd e2e && npx playwright test

vet:
	go vet ./...

fmt:
	gofmt -l -w .

tidy:
	go mod tidy
```

на:

```makefile
test:
	docker compose --profile test run --rm --build backend-test

fe-test:
	cd frontend && npm test

fe-build:
	cd frontend && npm run build

test-e2e: bin
	cd e2e && npx playwright test

vet:
	docker compose --profile test run --rm --build backend-test go vet ./...

fmt:
	docker compose --profile test run --rm -v ./backend:/src backend-test gofmt -l -w .

tidy:
	docker compose --profile test run --rm -v ./backend:/src backend-test go mod tidy

bin:
	mkdir -p $(BIN_DIR)
	docker build --target build -t $(BINARY)-build-img ./backend
	-docker rm -f $(BINARY)-bin-tmp >/dev/null 2>&1
	docker create --name $(BINARY)-bin-tmp $(BINARY)-build-img
	docker cp $(BINARY)-bin-tmp:/out/$(BINARY) $(BIN_DIR)/$(BINARY)
	docker rm $(BINARY)-bin-tmp
```

`fe-test`/`fe-build` на время этой задачи остаются хостовыми — они обновятся в Task 3. Также дописать `bin` в `.PHONY`:

```makefile
.PHONY: build run dev test fe-test fe-build test-e2e vet fmt tidy bin clean
```

- [ ] **Step 4: Проверить, что Go-тесты идут и Postgres не скипается**

Run: `docker compose --profile test run --rm --build backend-test`
Expected: все пакеты `ok`, среди вывода нет `FIRENET_TEST_DATABASE_URL not set; skipping` — значит `db` поднят и тесты с БД выполнились.

- [ ] **Step 5: Проверить `vet` и извлечение бинаря**

```bash
make vet
make bin
ls -l bin/firenet
```

Expected: `vet` без замечаний; `bin/firenet` существует и непустой.

- [ ] **Step 6: Проверить, что `fmt` и `tidy` пишут на хост**

```bash
make tidy
git status --short backend/go.mod backend/go.sum
make fmt
git status --short
```

Expected: `make tidy` не меняет `go.mod`/`go.sum` (git status по ним пуст) — том `./backend:/src` смонтирован и запись идёт в хостовые файлы; `make fmt` печатает пути только если есть неотформатированные файлы (в норме — ничего) и не оставляет изменений в `git status`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build(backend): docker test stage and make targets"
```

---

### Task 3: Frontend test-стейдж и compose-сервис

**Files:**
- Modify: `frontend/Dockerfile` (добавить стейдж `test` в конец файла, после `runtime`)
- Modify: `docker-compose.yml` (добавить `frontend-test`)
- Modify: `Makefile` (`fe-test` через docker)

**Interfaces:**
- Consumes: `frontend/Dockerfile` со стейджем `deps` (существующий).
- Produces: `make fe-test` гоняет typecheck + Vitest в контейнере без хостового Node.

- [ ] **Step 1: Добавить стейдж `test` в `frontend/Dockerfile`**

Дописать в конец файла:

```dockerfile
FROM deps AS test
COPY . .
CMD ["sh", "-c", "npm run typecheck && npm test"]
```

Стейджи `build` и `runtime` не трогать. Стейдж `test` повторяет `build` по копированию, но гоняет typecheck и тесты — это сохраняет прежнюю проверку `npm run typecheck && npm test`.

> **Важно:** стейдж `test` дописывается именно **в конец** файла, а не сразу
> за `deps`. Если вставить его между `deps` и `build`, он станет последним
> стейджем, и дефолтная сборка начнёт гонять `npm run typecheck && npm test`
> вместо `npm run build` (в том числе через `fe-build` → `docker compose
> build frontend`). Сервис `frontend` спасает явный `target:
> ${FRONTEND_TARGET:-runtime}`, но дефолтным стейджем `test` быть не должен.

- [ ] **Step 2: Добавить сервис `frontend-test` в `docker-compose.yml`**

Дописать в блок `services` (например, после сервиса `frontend`):

```yaml
  frontend-test:
    profiles: ["test"]
    build:
      context: ./frontend
      target: test
```

`ports`, `restart`, `environment` не добавлять.

- [ ] **Step 3: Перевести `fe-test` на docker в Makefile**

Заменить:

```makefile
fe-test:
	cd frontend && npm test

fe-build:
	cd frontend && npm run build
```

на:

```makefile
fe-test:
	docker compose --profile test run --rm --build frontend-test

fe-build:
	docker compose build frontend
```

- [ ] **Step 4: Проверить фронтенд-тесты в контейнере**

Run: `make fe-test`
Expected: `tsc -b` молчит, Vitest отчитывается `Tests  ... passed` и нулём failed.

- [ ] **Step 5: Проверить, что остальные цели всё ещё консистентны**

Run: `docker compose config --quiet`
Expected: без ошибок (все профили и контексты валидны).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build(frontend): docker test stage and make fe-test"
```

---

### Task 4: Документация docker-first

**Files:**
- Modify: `AGENTS.md` (раздел Verification, Gotchas, упоминания `cmd/firenet`)
- Modify: `README.md` (архитектура, раздел «Разработка», структура проекта)

**Interfaces:**
- Consumes: цели Makefile из Task 1–3.
- Produces: документация, где нет хостовых `go`/`npm` команд и отражён переезд.

- [ ] **Step 1: Обновить раздел Verification в `AGENTS.md`**

Заменить блок:

```markdown
## Verification (run in this order after any change)
 1. `go build ./...`
 2. `go vet ./...`
 3. `gofmt -l .` — must print nothing (`make fmt` to fix)
 4. `go test ./...`
 5. `cd frontend && npm run typecheck && npm test` — typecheck (tsc) и
    юнит-тесты React (Vitest + RTL)
 6. `make test-e2e` — E2E-сценарии Playwright (нужны docker и chromium;
    первый запуск: `cd e2e && npm install && npx playwright install chromium`).

No linter beyond `go vet` is configured — don't try golangci-lint.
```

на:

```markdown
## Verification (run in this order after any change)
 1. `make vet` — `go vet` в контейнере `backend-test`
 2. `make fmt` — `gofmt -l -w` в контейнере (пишет в хостовые `backend/`
    через том); не должно остаться изменений, если код уже отформатирован
 3. `make test` — Go-тесты в контейнере `backend-test` (Postgres-тесты
    идут против compose-сервиса `db`, не скипаются)
 4. `make fe-test` — `tsc -b` + Vitest в контейнере `frontend-test`
 5. `make test-e2e` — E2E-сценарии Playwright.

Хостовые Go и Node не предполагаются: всё, кроме `test-e2e`, выполняется
в docker compose. `make test-e2e` — временное гибридное исключение:
Playwright, Node/Vite и `bin/firenet` запускаются на хосте, а PostgreSQL
поднимается в Docker из `e2e/global-setup.js`. Нужны Docker, Node,
зависимости `frontend/` и `e2e/`, `npx playwright` и Chromium. Первый
запуск:

```sh
cd frontend && npm ci
cd ../e2e && npm ci && npx playwright install chromium
cd ..
```

Цель собирает `bin/firenet` через `make bin` (извлечение бинаря из образа).

No linter beyond `go vet` is configured — don't try golangci-lint.
```

- [ ] **Step 2: Обновить Gotchas в `AGENTS.md`**

Заменить строку:

```markdown
  - The binary is a single web server (`cmd/firenet`): loads config from
```

на:

```markdown
  - The binary is a single web server (`backend/cmd/firenet`): loads config from
```

И заменить строку:

```markdown
 - e2e/ has its own package.json (playwright) — the app itself doesn't depend on node; editing e2e helpers doesn't require rebuilding the binary, but make test-e2e rebuilds bin/firenet via its build dependency anyway.
```

на:

```markdown
 - e2e/ has its own package.json (playwright) — the app itself doesn't depend on node; editing e2e helpers doesn't require rebuilding the binary, but make test-e2e rebuilds bin/firenet via its `bin` dependency anyway.
```

- [ ] **Step 3: Обновить README — архитектура и структура**

Заменить в архитектуре:

```markdown
- **backend** (`cmd/firenet`) — Go-сервис, отдающий только JSON API
```

на:

```markdown
- **backend** (`backend/cmd/firenet`) — Go-сервис, отдающий только JSON API
```

Заменить блок структуры:

```
cmd/firenet/       точка входа Go-бэкенда (JSON API)
internal/app/      ядро бизнес-логики
internal/httpapi/  HTTP API (JSON)
frontend/          веб-интерфейс: React + TypeScript + Vite, сборка в nginx
internal/pgstore/  хранение проектов и версий в PostgreSQL
internal/auth/     аутентификация и пользователи
internal/topology/ модель сети: устройства, связи, подсети и зоны
internal/rules/    модель правил фильтрации
internal/graph/    построение графа маршрутизации и поиск путей
internal/compiler/ размещение правил по устройствам
internal/render/   рендер iptables/ipset-скриптов
```

на:

```
backend/           Go-бэкенд: модуль, cmd, internal, Dockerfile
backend/cmd/firenet/  точка входа Go-бэкенда (JSON API)
backend/internal/app/       ядро бизнес-логики
backend/internal/httpapi/   HTTP API (JSON)
backend/internal/pgstore/   хранение проектов и версий в PostgreSQL
backend/internal/auth/      аутентификация и пользователи
backend/internal/topology/  модель сети: устройства, связи, подсети и зоны
backend/internal/rules/     модель правил фильтрации
backend/internal/graph/     построение графа маршрутизации и поиск путей
backend/internal/compiler/  размещение правил по устройствам
backend/internal/render/    рендер iptables/ipset-скриптов
frontend/          веб-интерфейс: React + TypeScript + Vite, сборка в nginx
```

- [ ] **Step 4: Обновить раздел «Разработка» в README**

Заменить:

```markdown
Для проверки изменений исходного кода:

```sh
go build ./...
go vet ./...
gofmt -l .
go test ./...
cd frontend && npm test
make test-e2e
```
```

на:

```markdown
Проверка изменений выполняется в docker compose, хостовые Go и Node не
нужны:

```sh
make vet        # go vet в контейнере
make fmt        # gofmt (пишет в backend/ на хосте)
make test       # Go-тесты в контейнере, с Postgres из compose
make fe-test    # tsc + Vitest в контейнере
make test-e2e   # временное гибридное исключение: Node/Vite/Playwright и bin/firenet на хосте, PostgreSQL в Docker
```

`make test-e2e` требует Docker, Node, зависимости `frontend/` и `e2e/`, а
также установленный Chromium. Полный перенос e2e в контейнеры — отдельная
будущая задача.
```

- [ ] **Step 5: Убедиться, что не осталось хостовых команд**

Run: `grep -rn "go build ./\.\.\.\|go test ./\.\.\.\|go vet ./\.\.\.\|npm test" AGENTS.md README.md`
Expected: пустой вывод (все заменены на make-цели либо описание в прозе). Если что-то нашлось — поправить.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: docker-first workflow and backend/ layout"
```

---

### Task 5: Финальная сквозная проверка

**Files:**
- Нет изменений (только верификация).

**Interfaces:**
- Consumes: всё из Task 1–4.
- Produces: подтверждение, что репозиторий работает без хостового Go/Node (кроме e2e).

- [ ] **Step 1: Полная проверка с нуля**

```bash
docker compose build backend frontend
make test
make fe-test
make vet
make fmt
docker compose up -d --build
docker compose ps
```

Expected: сборка успешна; `make test` — Go-тесты зелёные без skip БД; `make fe-test` — typecheck и Vitest зелёные; `make vet` чистый; `make fmt` не вносит изменений; стек поднят.

- [ ] **Step 2: Проверить e2e (хостовое исключение)**

```bash
make test-e2e
```

Expected: Playwright проходит в временном гибридном режиме (нужны Docker,
Node, зависимости `frontend/` и `e2e/`, а также Chromium; PostgreSQL
запускается в Docker). Если окружение без Chromium — зафиксировать, что это
известное исключение, и не считать провалом переезда.

- [ ] **Step 3: Убедиться, что рабочее дерево чисто**

Run: `git status --short`
Expected: пусто (все изменения закоммичены; `bin/` в `.gitignore`).
