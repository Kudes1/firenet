# Рефакторинг канвы топологии: id рёбер, геометрия, валидация имён (дизайн)

Дата: 2026-09-22

## Проблема

Разбор канвы `/ui/topology` выявил три критичных дефекта и одно
вытекающее из них ограничение:

1. **Хрупкий парсинг id рёбер.** Формат `link:a|b#offset` /
   `attach:net|device` задокументирован в комментариях, но сборка и
   разбор размазаны по трём файлам (`scene.ts`, `TopologyPage.tsx`,
   `useTopologyEditor.ts`) и делаются вручную (`split("|")`,
   `lastIndexOf("#")`). Имя устройства с `|` или `#` ломает обратный
   разбор: `link:sw|core|r1#0` неоднозначен. Тот же разделитель `|`
   используется в `layoutLinkKey` (фронт и бэкенд) и `pgstore.linkKey` —
   неоднозначны и ключи waypoints/сущностей.
2. **Два источника геометрии узлов.** Размеры и центры узлов считаются
   в `buildScene` (`scene.ts`), в `nodeGeometry` и в пересчёте `edges`
   (`TopologyCanvas.tsx`), в `pendingCenter` (`TopologyPage.tsx`).
   Смена размера узла требует синхронных правок в нескольких местах;
   расхождение даёт разъехавшиеся концы рёбер.
3. **Побочный эффект в рендере.** `useTopologyEditor.ts` пишет
   `channel.send = ops.mutateAsync` в теле компонента — мутация
   межрентерного состояния из render-фазы.
4. **Имена без ограничений.** `uniqueNameHint` проверяет только пустоту
   и дубликат, панель создания на канве не проверяет даже это. На
   бэкенде для имён устройств/сетей ограничений по символам нет (жёсткий
   regex есть только у имён цепочек правил).

## Решение

### 1. Id рёбер — единый контракт в `scene.ts`

`scene.ts` уже владеет форматом id (`buildScene` их создаёт) — он же
экспортирует хелперы:

```ts
formatLinkEdgeId(a: string, b: string, offset: number): string  // "link:a|b#offset"
formatAttachEdgeId(network: string, device: string): string     // "attach:net|device"
parseEdgeId(id: string):
  | { kind: "link"; a: string; b: string; offset: number }
  | { kind: "attach"; network: string; device: string }
  | null
```

- `buildScene` собирает id только через `format*`.
- `TopologyPage` (`handleEdgeContextMenu`, `onWaypointsChange`, `markOf`)
  и `useTopologyEditor.removeSelected` разбирают только через
  `parseEdgeId`; ручные `split`/`lastIndexOf`/`slice` по id удаляются.
- `parseEdgeId` возвращает `null` на любом мусоре (неизвестный тип,
  неверное число сегментов, `offset` не integer) — вызывающий игнорирует
  такой id. Имена с `|`/`#` после п. 4 не появляются, но `null`-семантика
  остаётся защитой от чужих/устаревших данных.
- Узлы (`device:`, `network:`, `union:`) не трогаем: их имена уже
  парсятся безопасно (`rest.join(":")` после первого сепаратора).

### 2. Геометрия — один источник в `scene.ts`

```ts
nodeSize(type: "device" | "network"): { w: number; h: number }
nodeCenter(type: "device" | "network", position: LayoutPoint): LayoutPoint
nodeGeometry(type: SceneNode["type"]): { width; height; handles }  // перенос из TopologyCanvas
```

- Константы `DEVICE_W/H`, `NET_W/H` остаются в `icons.ts`, `scene.ts`
  их ре-экспортирует (как сейчас) — существующие импорты страниц не
  ломаются.
- `buildScene` (центры рёбер), `TopologyCanvas` (`nodeGeometry`,
  пересчёт `edges` при drag), `TopologyPage` (`pendingCenter`) считают
  через эти функции. В каждом месте остаётся вызов, не формула.

### 3. `channel.send` — в `useEffect`

В `useTopologyEditor` присвоение `channel.send` переносится из тела
рендера в `useEffect` c deps `[channel, ops.mutateAsync]`. Поведение
очереди (debounce 400 мс, immediate-режим, откат ошибок) не меняется.

### 4. Имена устройств и сетей: запрет `|` и `#`

Разделители формата id. Другие символы (кириллица, пробелы, `.`, `:`,
`_`, `-`) остаются разрешёнными — обратная совместимость с текущими
проектами («Офис LAN», «r.1» валидны).

**Фронтенд** — `lib/validate.ts`:

- `uniqueNameHint` дополнительно возвращает подсказку при `|`/`#`
  вида «Недопустимые символы в имени: | #». Подхватывается существующими
  формами (`DeviceEditForm`, `NetworkEditForm`, `SubnetsPage`,
  `SetsPage`, `UnionsPage`) без правок вызывающего кода.
- Панель создания на канве (`TopologyPage.create`) получает ту же
  `uniqueNameHint` по `existingNames` (заодно чинится отсутствие
  проверки дубликата и пустого имени): подсказка под полем, submit
  заблокирован при `hint`.

**Бэкенд** — `topology.ValidateName(name) string` ("" — ок, иначе текст
ошибки; пусто/`|`/`#` — не ок). Вызывается в `applyTopologyOperation`
только для **нового** имени:

- `create-device` → `op.Device.Name`
- `update-device` → `op.Device.Name` (новое имя; проверяем всегда, а не
  только при переименовании — без ветвления)
- `create-network` / `update-network` — аналогично.

Сознательно **не** вешаем на весь `Topology.Validate()`: проект, где имя
с `|` уже сохранилось, иначе не откроется (`load.go`) и его нельзя будет
переименовать из UI. Проверка только нового имени — старые вычищаются
переименованием. Полный прогон по `Validate()` — возможное ужесточение
отдельным решением (с миграцией данных).

Союз `|` в `update-device`/`update-network` уже покрыт существующей
проверкой «already exists».

## Тесты

- `lib/validate.test.ts`: `uniqueNameHint` отклоняет `|`/`#`, принимает
  «Офис LAN» и «r.1», подсказка про дубликат/пустота не сломана.
- `topology/scene.test.ts`: round-trip `format*` → `parseEdgeId`;
  `parseEdgeId` → `null` на мусоре (`"link:a|b"`, `"link:a|b#x"`,
  `"attach:a"`, `"wat:a|b"`, имена с `|`).
- `topology/editForms.test.tsx` + тест панели создания на канве: submit
  заблокирован при `|`/`#` и при дубликате.
- `httpapi/topology_operations_test.go`: `create-device`/`update-device`/
  `create-network`/`update-network` с `|`/`#` → ошибка; валидные имена
  (включая пробелы и кириллицу) проходят.
- Существующие тесты `useTopologyEditor.test.tsx`, `TopologyCanvas.test.tsx`,
  `TopologyPage.test.tsx`, e2e — правятся только там, где трогали id/вызовы.

## Верификация

`make vet && make fmt && make test && make fe-test && make test-e2e`.

## Вне объёма

- Экранирование спецсимволов в id (решили запрещать, не кодировать).
- Разбиение `TopologyCanvas`/`TopologyPage` на хуки (пункты 6–7 списка
  замечаний).
- Мемоизация `guard`, отдельный дебаунс камеры (пункты 4–5).
- Валидация имён подсетей, наборов, объединений (в id рёбер не входят).
- Миграция существующих имён с `|`/`#`.
