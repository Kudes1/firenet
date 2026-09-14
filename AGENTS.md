## Code style
 - Write compact code.
 - Try to write in a style that allows the code to be reused.
 - Make sure the code is easy to review.
 - The code must be unambiguous. It is implied that the code should do a specific thing; everything else is discarded.

## Serena-first code navigation

Use Serena MCP as the primary tool for exploring and understanding source code.

When locating or analyzing code:

 - Prefer Serena symbolic tools such as find_symbol, find_referencing_symbols, and get_symbols_overview.
 - Prefer Serena search_for_pattern for textual searches inside the codebase.
 - Use grep, glob, or broad file reads only when Serena is not suitable, cannot find the required information, or when working with non-code files such as configs, documentation, templates, logs, or generated files.
 - Do not use repeated grep + read operations to discover relationships between code symbols when Serena can resolve them symbolically.
 - Once the relevant code has been located, normal read, edit, and other client tools may be used for implementation.

### For code navigation, follow this priority:
 - Serena symbolic search
 - Serena pattern search
 - Targeted file read
 - grep / glob as fallback

## Tool usage
 - Use Serena MCP for code navigation (see «Serena-first code navigation» above).
 - Don't use playwright unless explicitly asked to do so.

## Stack

 - Backend: Go 1.25 (`go.mod`), PostgreSQL через `pgx/v5`. HTTP — чистый
   `net/http`, JSON API в `internal/httpapi` (серверного UI больше нет,
   Go отдаёт только `/api/*`).
 - Frontend: React 18 + TypeScript + Vite (`frontend/`), точка входа
   `src/main.tsx`. Канвас топологии — React Flow (`@xyflow/react`),
   данные — `@tanstack/react-query`, роутинг — `react-router-dom`.
 - Frontend-тесты: Vitest + Testing Library (+ MSW), среда jsdom;
   один конфиг `frontend/vite.config.ts` на Vite и Vitest,
   `npm run typecheck` — это `tsc -b`.
 - Деплой: docker compose — `db` (postgres:16-alpine), `backend` (Go,
   порт 8787), `frontend` (стейдж `runtime` — nginx, порт 8080; стейдж
   `dev` — Vite, порт 5173). `nginx/firenet.conf` — пример хостового
   nginx: он проксирует `/api/` → backend и `/` → frontend, наружу
   смотрит только он.
 - e2e: Playwright в `e2e/` (свой package.json), гоняется против
   собранного бинаря и docker-Postgres (`global-setup.js`).

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

## Gotchas
 - `frontend/dist/` собирается в контейнер nginx; после правки `frontend/src`
   в prod-режиме нужен `docker compose up -d --build frontend`, в dev
   (`FRONTEND_TARGET=dev`) Vite подхватывает правки сам.
  - The binary is a single web server (`backend/cmd/firenet`): loads config from
    env (`internal/config`), applies migrations, bootstraps the admin
    user, seeds an empty project on a fresh DB, then serves `/api/*`.
    No CLI subcommands, no yaml input files.
  - Tests assert directly on structs/strings; there is no golden-file/-update infra.
 - e2e/ has its own package.json (playwright) — the app itself doesn't depend on node; editing e2e helpers doesn't require rebuilding the binary, but make test-e2e rebuilds bin/firenet via its `bin` dependency anyway.

## Общие правила
 - Отвечай в чате и задавай вопросы на русском языке
 - Не проводи полного тестирования в браузере каждый раз при изменении в коде, проводи только автоматические тесты кода.
 - При проработке плана (brainstorming/plan) задавай больше уточняющих вопросов простым языком, с примерами ожидаемого поведения («если пользователь сделает X, то произойдёт Y — так?»), прежде чем предлагать решение.
