## Code style
 - Write compact code.
 - Try to write in a style that allows the code to be reused.
 - Make sure the code is easy to review.
 - The code must be unambiguous. It is implied that the code should do a specific thing; everything else is discarded.

## Tool usage
 - Use MCP Context7 if it is available.
 - Use built-in OpenCode LSP (gopls, typescript-language-server) for code navigation.
 - Don't use playwright unless explicitly asked to do so.

## Project structure
 - cmd/firenet/      entry point (cobra CLI: version, validate, compile, serve)
 - internal/app/     core (business logic, unaware of CLI/HTTP)
 - internal/cli/     CLI adapter (cobra)
 - internal/config/  configuration from env (FIRENET_LOG_LEVEL, FIRENET_LOG_FORMAT)
 - internal/logger/  structured logging (log/slog)
 - internal/topology/ network model: devices, links, subnets, zones
 - internal/rules/    the filtering rules model
 - internal/graph/    building a routing graph, searching for paths
 - internal/compiler/ Placing rules by device, ipset/iptables model
 - internal/render/   Render DeviceRuleset into text iptables/ipset scripts
 - internal/httpapi/  web UI (`serve`): htmx+alpine pages under web/, embedded via go:embed

## Verification (run in this order after any change)
 1. `go build ./...`
 2. `go vet ./...`
 3. `gofmt -l .` — must print nothing (`make fmt` to fix)
 4. `go test ./...`
 5. `make test-e2e` — E2E-сценарии Playwright (нужны docker и chromium;
    первый запуск: `cd e2e && npm install && npx playwright install chromium`).

No linter beyond `go vet` is configured — don't try golangci-lint.

Web UI JS tests run outside a browser on node:test with DOM stubs:
 - `node --test 'internal/httpapi/web/*.test.js'` — glob is required;
   running on the directory fails because plain .js files get loaded as tests.
No package.json / node_modules — only node built-ins.

## Gotchas
 - `internal/httpapi/web/` assets are embedded at build time (`go:embed`):
   rebuild the binary (`make build`) after editing them, or `serve` shows stale UI.
 - topology.yaml / subnets.yaml / rules.yaml at repo root are the live working
   data for `validate`/`compile`/`serve`; examples/ holds pristine samples,
   out/ is generated output.
 - Tests assert directly on structs/strings; there is no golden-file/-update infra.
  - e2e/ has its own package.json (playwright) — the app itself doesn't depend
    on node; editing e2e helpers doesn't require rebuilding the binary, but
    make test-e2e rebuilds bin/firenet via its build dependency anyway.

## Общие правила
 - Отвечай в чате и задавай вопросы на русском языке
 - Не проводи полного тестирования в браузере каждый раз при изменении в коде, проводи только автоматические тесты кода.
