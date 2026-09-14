# Вынос бэкенда в `backend/` и docker-first workflow

Дата: 2026-09-14
Статус: утверждён

## Цель

Симметрично фронтенду вынести Go-бэкенд в подкаталог `backend/`, а запуск,
сборку и юнит-тесты перевести на docker compose. Хостовая машина не должна
требовать Go и Node — единственное исключение на переходный период — e2e.

## Текущее состояние

- Бэкенд лежит в корне: `go.mod`, `go.sum`, `cmd/firenet/`, `internal/`,
  корневой `Dockerfile`, корневой `.dockerignore`.
- Сборка/тесты бэкенда — хостовые: `make build/run/test/vet/fmt/tidy`
  вызывают `go` напрямую, `make test-e2e` пересобирает `bin/firenet`.
- Фронтенд уже вынесен в `frontend/` (свой `package.json`, `Dockerfile`,
  dev-стейдж Vite и runtime-стейдж nginx).
- Юнит-тесты бэкенда с Postgres скипаются без `FIRENET_TEST_DATABASE_URL`
  (`internal/db/dbtest`), в остальном не зависят от окружения.
- `docker-compose.yml`: `db`, `backend` (`build: .`), `frontend`.
- e2e: `e2e/global-setup.js` спавнит `bin/firenet` и `npm run dev`,
  Playwright гоняется хостовым `npx`.

## Принятые решения

| Решение | Выбор |
|---|---|
| Объём переноса | Только код: `go.mod`/`go.sum`, `cmd/`, `internal/` |
| `go.mod` | Переезжает в `backend/`; module path `github.com/kudes1/firenet` не меняется |
| `Dockerfile` бэкенда | Переезжает в `backend/`, контекст сборки `./backend` |
| Инфра в корне | `docker-compose.yml`, `Makefile`, `nginx/`, `README.md`, `AGENTS.md` остаются на месте |
| Основной способ запуска | `docker compose up` |
| Юнит-тесты | Отдельные `test`-стейджи в Dockerfile'ах + сервисы под compose-профилем `test` |
| Локальная сборка | Не предполагается: Go/Node на хосте не нужны |
| e2e | Временно остаётся хостовым исключением (нужен Node) |

## Структура репозитория

```
firenet/
├── backend/
│   ├── go.mod
│   ├── go.sum
│   ├── cmd/firenet/main.go
│   ├── internal/
│   ├── Dockerfile          # переезжает из корня
│   └── .dockerignore        # переезжает из корня
├── frontend/               # без изменений структуры
├── e2e/                    # без изменений (хостовое исключение)
├── docker-compose.yml
├── Makefile
├── nginx/firenet.conf
├── AGENTS.md
├── README.md
└── docs/
```

Go-импорты не меняются: все 78 файлов уже используют префикс
`github.com/kudes1/firenet/...`. `//go:embed migrations/*.sql` в
`internal/db` остаётся относительным, поэтому переезд модуля его не ломает.

Корневой `package.json`/`package-lock.json` (единственная зависимость —
`typescript`) не участвуют в сборке и не трогаются этой задачей.

## Docker

### `backend/Dockerfile`

Контекст — `./backend`, поэтому пути внутри образа короткие:

```dockerfile
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/firenet ./cmd/firenet

FROM gcr.io/distroless/static-debian12 AS runtime
COPY --from=build /out/firenet /firenet
ENV FIRENET_ADDR=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/firenet"]

FROM golang:1.25-alpine AS test
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
CMD ["go", "test", "./..."]
```

`backend/.dockerignore` переносится из корня в том же виде (`.git`, `bin/`,
`out/`, `*.md`, `docs/`, `.serena/`, `.superpowers/`). Строки про
`frontend/` не нужны: контекст больше не включает фронтенд.

### `frontend/Dockerfile`

Добавляется `test`-стейдж по образцу `build`, но с `npm test` вместо
`npm run build`:

```dockerfile
FROM deps AS test
COPY . .
CMD ["npm", "test"]
```

### `docker-compose.yml`

- `backend.build.context` меняется с `.` на `./backend`.
- Добавляются сервисы под профилем `test`:
  - `backend-test`: `build: {context: ./backend, target: test}`,
    `depends_on: db (service_healthy)`, `FIRENET_TEST_DATABASE_URL` на `db`,
    без `ports` и `restart`.
  - `frontend-test`: `build: {context: ./frontend, target: test}`,
    без `ports` и `restart`.
- `db`, `backend`, `frontend` в остальном не меняются.

`FIRENET_TEST_DATABASE_URL` указывает на сервис `db`:
`postgres://firenet:${POSTGRES_PASSWORD}@db:5432/firenet?sslmode=disable`.
Тесты используют общий URL и advisory-lock (`internal/db/dbtest`), поэтому
один `backend-test` против compose-`db` корректен; Postgres-тесты больше не
скипаются.

## Makefile

Все цели, кроме e2e, работают без локальных Go/Node:

| Цель | Команда |
|---|---|
| `build` | `docker compose build backend` |
| `run` / `dev` | `docker compose up -d --build` |
| `test` | `docker compose --profile test run --rm backend-test` |
| `fe-test` | `docker compose --profile test run --rm frontend-test` |
| `fe-build` | `docker compose build frontend` |
| `vet` | `docker compose --profile test run --rm backend-test go vet ./...` |
| `fmt` | `docker compose --profile test run --rm -v ./backend:/src backend-test gofmt -l -w .` |
| `tidy` | `docker compose --profile test run --rm -v ./backend:/src backend-test go mod tidy` |
| `bin` | `docker build --target build -t firenet-backend-build ./backend` + `docker create`/`docker cp`/`docker rm`, кладёт `/out/firenet` в `bin/firenet` |
| `clean` | без изменений (удаляет `bin/`) |
| `test-e2e` | `test-e2e: bin` + `cd e2e && npx playwright test` |

Два следствия, которые нужно явно закрыть:

- `fmt` и `tidy` **пишут в исходники**, поэтому монтируют `./backend` в `/src`
  (`-v ./backend:/src`): без тома правки остались бы в контейнере и потерялись.
  `test`/`vet` пишут только в stdout и тома не требуют.
- `build` теперь собирает образ и не создаёт `bin/firenet`. e2e-сетап
  (`e2e/global-setup.js`) по-прежнему спавнит `bin/firenet`, поэтому
  появляется отдельная цель `bin`: бинарь собирается в build-стейдже образа
  и извлекается на хост через `docker create` + `docker cp`. `test-e2e`
  зависит от `bin`, а не от `build`.

Полноценный перенос e2e в контейнер (Playwright-образ, отказ от хостового
Node) — отдельная будущая задача.

## Документация

- `AGENTS.md`: раздел Verification переписывается на docker-команды;
  явно фиксируется, что локальные `go`/`npm` не предполагаются, и что e2e —
  исключение. Строки про `cmd/firenet`, `go build ./...`, `gofmt -l .`
  обновляются на docker-эквиваленты.
- `README.md`: дерево репозитория, упоминание `backend/cmd/firenet`,
  инструкции запуска только через `docker compose`.

## Верификация

```bash
docker compose build backend frontend
docker compose --profile test run --rm backend-test
docker compose --profile test run --rm frontend-test
docker compose up -d --build            # дымовой прогон
make test-e2e                           # хостовое исключение
```

Ожидание: обе test-цели зелёные (Postgres-тесты бэкенда не скипаются),
сборка и запуск проходят, e2e не регрессирует.
