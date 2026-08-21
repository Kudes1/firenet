## Code style
 - Write compact code.
 - Try to write in a style that allows the code to be reused.
 - Make sure the code is easy to review.
 - The code must be unambiguous. It is implied that the code should do a specific thing; everything else is discarded.

## Tool usage
 - Use MCP Context7 if it is available.
 - Use the MCP and LSP server Serena if it is available.
 - Don't use playwright unless explicitly asked to do so.

## Project structure
 - cmd/firenet/      entry point
 - internal/app/     core (business logic, unaware of CLI/HTTP)
 - internal/cli/     CLI adapter (cobra)
 - internal/config/  configuration from env
 - internal/logger/  structured logging (log/slog)
 - internal/topology/ network model: devices, links, subnets, zones
 - internal/rules/    the filtering rules model
 - internal/graph/    building a routing graph, searching for paths
 - internal/compiler/ Placing rules by device, ipset/iptables model
 - internal/render/   Render DeviceRuleset into text iptables/ipset scripts

## Общие правила
 - Отвечай в чате и задавай вопросы на русском языке
 - Не проводи полного тестирования в браузере каждый раз при изменении в коде, проводи только автоматические тесты кода.