# firenet

Система управления распределённым firewall на базе `iptables`+`ipset`.
Топология сети (маршрутизаторы, коммутаторы для связности, подсети) и
правила фильтрации описываются декларативно в YAML, а ядро само вычисляет,
на каких маршрутизаторах и какие конкретно правила нужно поставить — с
учётом резервирования маршрутов (defense-in-depth: правило ставится на
каждый транзитный узел, а не только на периметре).

MVP компилирует топологию+правила в текстовые `iptables`/`ipset`-скрипты по
устройствам; реального применения на устройства (SSH/агент) пока нет.

Ядро (`internal/app`) отделено от способа доставки (`internal/cli`), чтобы
позже добавить веб-интерфейс, не переписывая бизнес-логику.

## Сборка и запуск

```sh
make build
./bin/firenet version
```

Или без сборки бинарника:

```sh
make run
```

## Компиляция топологии и правил

```sh
./bin/firenet validate --topology topology.yaml --subnets subnets.yaml --rules rules.yaml   # только проверка
./bin/firenet compile  --topology topology.yaml --subnets subnets.yaml --rules rules.yaml --stdout
./bin/firenet compile  --topology topology.yaml --subnets subnets.yaml --rules rules.yaml --out ./out/
```

Формат `topology.yaml`, `subnets.yaml` и `rules.yaml`, семантика `any` и
алгоритм размещения правил на маршрутизаторах описаны в doc-комментариях
пакетов `internal/topology`, `internal/rules`, `internal/graph`,
`internal/compiler`.

Модель данных: подсети (`subnets.yaml`) — именованные CIDR-блоки; сети
(`topology.yaml`, секция `networks`) — именованные списки подсетей с
привязкой к устройствам (одна сеть = один сегмент, из сети получается один
ipset); правила ссылаются на имена подсетей и сетей.

Веб-интерфейс (`./bin/firenet serve`): отдельные страницы «Топология»,
«Подсети», «Сети», «Правила», «Компиляция».

## Конфигурация

Настройки читаются из переменных окружения:

| Переменная            | По умолчанию | Описание                     |
|-----------------------|--------------|-------------------------------|
| `FIRENET_LOG_LEVEL`   | `info`       | `debug`, `info`, `warn`, `error` |
| `FIRENET_LOG_FORMAT`  | `text`       | `text` или `json`             |
| `FIRENET_DATABASE_URL` | — (обязательна) | строка подключения к Postgres, напр. `postgres://user:pass@host:5432/firenet?sslmode=disable` |
| `FIRENET_ADMIN_USER`   | — | логин первого admin-аккаунта; обязателен при пустой таблице `users` |
| `FIRENET_ADMIN_PASSWORD` | — | пароль первого admin-аккаунта; обязателен при пустой таблице `users` |

## Развёртывание (docker-compose)

```sh
cp .env.example .env   # и поменяйте пароли
docker compose up -d --build
```

Поднимает Postgres и firenet рядом, применяет миграции и создаёт первый
admin-аккаунт из `.env` при первом запуске. UI — на `http://localhost:8787`.

## Разработка

```sh
make test   # тесты
make vet    # go vet
make fmt    # gofmt
make tidy   # go mod tidy
```

## Структура проекта

```
cmd/firenet/      точка входа
internal/app/     ядро (бизнес-логика, не знает о CLI/HTTP)
internal/cli/     CLI-адаптер (cobra)
internal/config/  конфигурация из env
internal/logger/  структурированное логирование (log/slog)
internal/topology/ модель сети: устройства, линки, подсети, зоны
internal/rules/    модель правил фильтрации
internal/graph/    построение графа маршрутизации, поиск путей
internal/compiler/ размещение правил по устройствам, ipset/iptables-модель
internal/render/   рендер DeviceRuleset в текстовые iptables/ipset-скрипты
```
