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
 - Use built-in OpenCode LSP (gopls, typescript-language-server) for code navigation.
 - Don't use playwright unless explicitly asked to do so.

## Verification (run in this order after any change)
 1. `go build ./...`
 2. `go vet ./...`
 3. `gofmt -l .` — must print nothing (`make fmt` to fix)
 4. `go test ./...`
 5. `cd frontend && npm test` — юнит-тесты React (Vitest + RTL)
 6. `make test-e2e` — E2E-сценарии Playwright (нужны docker и chromium;
    первый запуск: `cd e2e && npm install && npx playwright install chromium`).

No linter beyond `go vet` is configured — don't try golangci-lint.

## Gotchas
 - `frontend/dist/` собирается в контейнер nginx; после правки `frontend/src`
   в prod-режиме нужен `docker compose up -d --build frontend`, в dev
   (`FRONTEND_TARGET=dev`) Vite подхватывает правки сам.
 - topology.yaml / subnets.yaml / rules.yaml at repo root are the live working
   data for `validate`/`compile`/`serve`; examples/ holds pristine samples,
   out/ is generated output.
 - Tests assert directly on structs/strings; there is no golden-file/-update infra.
 - e2e/ has its own package.json (playwright) — the app itself doesn't depend on node; editing e2e helpers doesn't require rebuilding the binary, but make test-e2e rebuilds bin/firenet via its build dependency anyway.

## Общие правила
 - Отвечай в чате и задавай вопросы на русском языке
 - Не проводи полного тестирования в браузере каждый раз при изменении в коде, проводи только автоматические тесты кода.
