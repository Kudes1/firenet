# Разделение топологии: подсети, сети (ipset-списки) и топология

Дата: 2026-08-21
Статус: утверждён

## Проблема

Топология сейчас — одна логическая сущность (`topology.yaml`): хосты, связи,
подсети, зоны. Подсети привязаны к устройствам прямо внутри себя, зоны
(группы подсетей для правил/ipset) живут там же. Наполнять подсети и
составлять из них списки ipset в одном месте неудобно.

## Решение (подход A — минимальный рефакторинг)

Разделить на три сущности с раздельным хранением и отдельными страницами UI.

### Модель данных (`internal/topology/model.go`)

```go
type Subnet struct{ Name string; CIDR netip.Prefix }                    // без AttachedTo
type Network struct{ Name string; Subnets []string; Attach []Endpoint } // вместо Zone, без вложенности
type Topology struct{ Devices map[string]Device; Links []Link;
                      Subnets map[string]Subnet; Networks map[string]Network }
```

- `ResolveZone` → `ResolveNetwork`: имя подсети разворачивается в себя,
  имя сети — в список её подсетей. Вложенности нет — циклы невозможны.
- Подсеть входит **не более чем в одну** сеть (0 — допустимо).
- Одна сеть = один сегмент: все её подсети подключены к одним устройствам.

### Файлы

- `topology.yaml`: `devices`, `links`, `networks` (`name`, `subnets`, `attach`).
- `subnets.yaml` (новый): `subnets` (`name`, `cidr`).

Загрузка раздельная (`topology.Load` / `topology.LoadSubnets`),
объединение и кросс-валидация — в `internal/app`.

### Хранилище и CLI

- `ProjectStore`: + `ReadSubnets/WriteSubnets`; `FileProjectStore`: + `SubnetsPath`.
- CLI: флаг `--subnets subnets.yaml` у `validate`, `compile`, `serve`.
- Сидинг пустого `subnets.yaml` при старте сервера.

### HTTP API

- `GET/PUT /api/subnets` (`{subnets: [{name, cidr}]}`); PUT проверяет CIDR
  и пересечения с уже сохранёнными подсетями.
- `GET/PUT /api/topology` — новая форма документа (`devices/links/networks`).
- `/api/validate`, `/api/compile`, правила: загружают оба файла и объединяют;
  `src/dst` правил ссылаются на подсети и сети.

### UI — отдельные страницы с общей навигацией

| Страница | Содержимое |
|---|---|
| `/ui/topology` | SVG-канвас: устройства + связи + сети как узлы сегментов, привязка сетей к устройствам |
| `/ui/subnets` | таблица CRUD подсетей (name, cidr), бейдж «не входит ни в одну сеть» |
| `/ui/networks` | CRUD сетей: имя + выбор подсетей («списки ipset») |
| `/ui/rules` | как сейчас, селекты src/dst из подсетей и сетей |
| `/ui/compile` | как сейчас |

Каждая страница — server-rendered шаблон + Alpine.js/htmx (как текущие
rules/compile), общая навигация сверху. Канвас переезжает с `/` на
`/ui/topology`.

### Компиляция, граф, рендер

При построении графа каждая подсеть наследует attach своей сети
(`internal/graph/graph.go`). Пути, размещение, генерация ipset, рендер —
без изменений.

### Совместимость

Старые `topology.yaml` (секции `subnets`/`zones`) не читаются — осознанный
разрыв формата YAML (строгий парсинг). Обновляются примеры и README.

## Тестирование

Обновление существующих тестов (topology, graph, compiler, httpapi) и новые:
загрузка `subnets.yaml`, ошибка «подсеть в двух сетях», наследование attach
в графе, API `/api/subnets`.
