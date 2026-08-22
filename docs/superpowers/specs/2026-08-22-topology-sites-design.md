# Дизайн: локации (sites) в топологии

Дата: 2026-08-22
Статус: согласован, к реализации

## Цель

Визуально разделять локации на графе топологии. Для этого вводится новая
сущность топологии — `Site` (локация), в которую можно включать устройства
и сети.

## Принципы

- Локация **чисто визуальная**: она не участвует в компиляции, правилах и
  поиске путей. Никакой семантики для фильтрации.
- Каждый объект (устройство, сеть) входит **не более чем в одну** локацию;
  часть объектов может быть вне любых локаций.
- Единственный источник правды о членстве — `topology.yaml`.

## Модель данных

`internal/topology/model.go`:

```go
// Site is a visual grouping of devices and networks: one location.
// Purely presentational — it never affects compilation.
type Site struct {
    Name        string
    Devices     []string // refs to Device
    Networks    []string // refs to Network
    Description string   // optional note
}

type Topology struct {
    Devices  map[string]Device
    Links    []Link
    Subnets  map[string]Subnet
    Networks map[string]Network
    Sets     map[string]Set
    Sites    map[string]Site
}
```

Структуры `Device`, `Network` и компилятор не меняются.

## Формат YAML

Новая необязательная секция `sites:` в `topology.yaml`:

```yaml
sites:
  - name: office
    description: Главный офис
    devices:  [test1, test2, office1, core]
    networks: [OFFICE-NETWORK, MAIN]
  - name: zavod
    devices:  [zavod, market, core2]
    networks: [MARKET]
```

Членство хранится внутри сайта списками ссылок (а не полем `site` на
объекте), чтобы не размазывать правду по двум структурам.

## Загрузка и валидация

`internal/topology/load.go`:

- В `yamlTopology` добавляется `Sites []yamlSite`
  (`name`, `devices`, `networks`, `description,omitempty`).
- `KnownFields(true)` остаётся: неизвестные поля по-прежнему ошибка.
- Дубликаты имён сайтов отклоняются при декодировании (как для
  devices/networks). Порядок сайтов хранится в срезе wire-документа
  (`TopologyDoc.Sites`) — модель (`map`) порядок не хранит, но UI читает
  JSON-документ, где порядок сохранён; он же определяет
  детерминированные цвета в UI.

`internal/topology/validate.go`:

1. Каждая ссылка в `devices:`/`networks:` сайта указывает на существующий
   объект.
2. Устройство/сеть встречается не более чем в одном сайте (двойное
   членство — ошибка).

## HTTP API

Отдельных эндпоинтов нет: редактирование остаётся документным через
`PUT /api/topology`, чтение — `GET /api/topology`.

`internal/httpapi/dto.go` — по существующему паттерну Doc-структур
(одна wire-форма для YAML и JSON):

```go
type SiteDoc struct {
    Name        string   `json:"name" yaml:"name"`
    Devices     []string `json:"devices,omitempty" yaml:"devices,omitempty"`
    Networks    []string `json:"networks,omitempty" yaml:"networks,omitempty"`
    Description string   `json:"description,omitempty" yaml:"description,omitempty"`
}

type TopologyDoc struct {
    // Devices, Links, Networks, Sets — как сейчас
    Sites []SiteDoc `json:"sites" yaml:"sites"`
}
```

Конвертации Doc↔модель в httpapi нет: как и сейчас, `putTopology`
маршалит документ в YAML и прогоняет через `app.LoadProject` (то есть
`topology.Load` + `Validate`) — битые ссылки, дубликаты и двойное
членство отклоняются с 422 ещё до записи. `deletionErrors` дополняется:
нельзя удалить устройство/сеть, пока на него ссылается сайт (409, как для
остальных перекрёстных ссылок).

## Веб-UI (`/ui/topology`)

### Отрисовка рамок (`topology.js`)

- Для каждого сайта вычисляется bounding box по позициям его устройств и
  сетей в `State.layout` с отступом ~30px.
- Рамка рисуется первым слоем SVG (под узлами и связями): скруглённый
  прямоугольник, полупрозрачная заливка, цветная рамка, имя сайта в левом
  верхнем углу.
- Цвета — фиксированная палитра из 6–8 различимых оттенков, присваиваются
  по порядку сайта в документе (детерминированно).
- Пересчёт при каждой перерисовке, включая drag узлов — рамка следует за
  членами в реальном времени.

### Редактирование

1. Кнопка «Локация» на тулбаре открывает панель: список сайтов (имя,
   число членов, кнопка удаления) и форма создания (имя, описание).
2. Назначение члена — через существующее контекстное меню узла/сети:
   пункт «Локация →» с подменю (список сайтов + «Убрать из локации»).
3. Сохранение — без изменений: кнопка «Сохранить» отправляет весь документ
   через `PUT /api/topology`; dirty-guard работает как для остальных
   сущностей.

## Тесты

Go (`go test ./...`):

- `internal/topology`: загрузка секции sites; ошибки — дубликат имени,
  битая ссылка, двойное членство; валидация проходит на корректных данных.
- `internal/httpapi`: round-trip sites через `GET`/`PUT /api/topology`;
  422 при невалидных сайтах; 409 при удалении объекта, на который
  ссылается сайт.

JS (`node --test 'internal/httpapi/web/*.test.js'`):

- отрисовка рамок (позиции, слои, подписи, цвета по порядку);
- логика панели и контекстного меню (создание, удаление, назначение).

## Что не входит (YAGNI)

- Семантика локаций для правил/компиляции.
- Геометрические координаты рамок в layout-состоянии (рамка всегда
  вычисляется по членам).
- Перетаскивание узла в локацию мышью (назначение только через меню).
- Вложенные локации.
