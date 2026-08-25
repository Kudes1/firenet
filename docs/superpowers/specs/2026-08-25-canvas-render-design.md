# Переход холстов топологии и симуляции на Canvas-рендер

Дата: 2026-08-25
Статус: принят к реализации

## Контекст и цели

Оба канваса — редактор топологии (`topology.js`) и карта симуляции
(`simulate.js`) — рендерятся через `TopoScene` в SVG: полный re-render
дерева DOM (`innerHTML = ""` + пересборка) на каждое изменение, включая
каждый mousemove при drag'е узла. Камера симуляции вынесена в
CSS-трансформу («стейдж»), но это костыль поверх SVG, а не решение.

Цели перехода на Canvas2D (в стиле tldraw):

1. **Производительность** — перерисовка кадра целиком по требованию
   (один раз на rAF) вместо пересборки DOM; масштаб — сотни узлов.
2. **Визуальные эффекты** — плавные переходы состояний (выделение,
   поиск, окраска потока), анимация камеры, полировка стиля.

Не входит: анимация потока трафика по рёбрам (бегущие штрихи) — может
быть добавлена позже без изменения архитектуры; WebGL.

Ограничения проекта: vanilla JS без package.json/node_modules/сборки;
тесты — node:test с DOM-стабами. Библиотеки не вендорим — свой движок.
Переходят обе страницы сразу (общий `TopoScene`).

## Архитектура

Конвейер данных:

```
state (topology/layout/camera/selection/tool/mark-функции страниц)
   │  TopoScene.buildScene(scene, opts)      — чистая функция
   ▼
display list (массив примитивов, порядок = z-порядок)
   │  CanvasView.render(list, camera, theme) ← invalidate() → ≤1 кадра на rAF
   ▼
<canvas> 2D context (dpr-scaled)
```

Интерактив: события указателя на одном `<canvas>` → `hit_test` →
существующие обработчики инструментов страниц. HTML-оверлеи
(контекстное меню, popover создания узла, NetInfo, тултипы) остаются
DOM и позиционируются через `Camera.worldToScreen`, как сейчас.

### Модули (`internal/httpapi/web/`)

| Файл | Статус | Роль |
|---|---|---|
| `netmap.js` | правка | константы геометрии и чистые помощники остаются; `cloudPath` выдаёт точки квадратичных кривых вместо SVG path-строки |
| `topo_scene.js` | перепись | `render(viewportG,…)` → `buildScene(scene, opts)` → display list + bbox-индекс для хит-теста; ensureLayout/unionBox/nameSummary сохраняются |
| `canvas_theme.js` | новый | тема: цвета/толщины/дэши/шрифты по видам элементов и состояниям; базовые цвета читаются из CSS-переменных один раз при старте |
| `canvas_view.js` | новый | рендер display list в Canvas2D: setTransform камеры, culling, dpr, rAF-планировщик `invalidate()` |
| `hit_test.js` | новый | чистые функции «точка → объект» и «прямоугольник → объекты» (marquee) |
| `tween.js` | новый | мини-твин числовых свойств с easing (~40 строк); камера и переходы состояний |
| `camera.js` | правка | остаётся чистой математикой; + `fitView(cam, bounds, viewport)`; `stageTransform` удаляется |
| `camera_input.js` (CameraControls) | правка | подключается к canvas-элементу вместо svg; логика пана/зума не меняется |
| `topology.js` / `simulate.js` | правка | интерактив перепривязывается на hit-test; стейдж/origin/rebase симуляции удаляются |

## Display list

Плоские объекты без вложенности; порядок массива = z-порядок отрисовки:

```js
// каждый элемент: { kind, id, geom, style, text?, meta? }
{ kind: "rect"|"rrect", geom: {x,y,w,h,r}, style, id: "device:fw1" }
{ kind: "path",  geom: [сегменты квадратичных кривых], style, id: "wire:a|b" }
{ kind: "cloud", geom: {x,y,w,h,bumps}, style, id: "net:lan" }
{ kind: "glyph", geom: {d, x, y}, style }            // глиф устройства
{ kind: "text",  geom: {x,y}, text, style }
```

Ключевые решения:

- **style — разрешённые значения** (`stroke`, `lineWidth`, `dash`,
  `alpha`, `glow`), а не CSS-классы. Резолв состояния (selected /
  pending / search-hit / search-dim / sim-flow-ok / sim-flow-deny /
  dim) происходит в `buildScene` через тему. Рендерер только рисует —
  его тестирование тривиально.
- Входные opts текущего `TopoScene.render` сохраняются у `buildScene`
  (`classes/mark/dim/hook→meta`): страницы продолжают передавать свои
  mark-функции состояний.
- `meta` несёт данные для тултипов (состав фильтра связи, запрет на
  роутере) вместо SVG `<title>`.
- Порядок слоёв как сейчас: union-рамки → связи/привязки → узлы →
  подписи. Временные примитивы кадра (preview wire connect-инструмента,
  marquee) дописываются поверх списка на этапе рендера.

## Рендеринг (`canvas_view.js`)

- `resize()` следит за размером контейнера и `devicePixelRatio`;
  буфер = cssSize × dpr, контекст масштабируется через setTransform.
- Кадр: очистка → `ctx.setTransform(z*dpr, 0, 0, z*dpr, cam.x*dpr,
  cam.y*dpr)` → проход по display list с **culling**: bbox примитива
  против видимого мирового прямоугольника (+запас на толщину обводки).
- Текст: `ctx.font` из темы. При `z < 0.5` подписи скрываются (границы
  и связи рисуются всегда).
- rAF-планировщик: `invalidate()` ставит флаг; фактическая отрисовка —
  максимум одна на кадр. Drag узла = invalidate на каждый mousemove,
  перерисовка одна на frame.
- Стейдж-модель симуляции (CSS-transform, origin, rebase) удаляется:
  смена камеры теперь просто invalidate.

## Хит-тест и интерактив

`hit_test.js` — чистые функции по display list:

- узлы — точка в bbox;
- связи/привязки — расстояние до квадратичной кривой (сэмплирование в
  ~16 сегментов) ≤ `14px / z` — эквивалент `.wire-hit`;
- проверка в обратном z-порядку: узлы → связи → union-рамки;
- marquee — пересечение прямоугольника с bbox'ами (логика текущая).

В `topology.js` один набор обработчиков `pointerdown/move/up` + wheel;
кнопка/координаты → `Camera.screenToWorld`. Обработчики инструментов
(select/connect/device/network, drag группы выделением, контекстное
меню, поиск) сохраняются — меняется источник объекта: hit-test вместо
хуков на каждый SVG-элемент. Курсор (grab/pointer) обновляется на
pointermove по результату хит-теста.

В `simulate.js` карта read-only: клик по сети → NetInfo, hover
deny-роутера → тултип. CameraControls подключается тот же.

Тултипы — собственный div по hover из hit-test с задержкой ~300 мс.

## Тема и эффекты

`canvas_theme.js` — единый объект: базовые стили device/network/wire
(включая kind-цвета router/switch), filtered-dash, состояния selected/
pending/dim/searchHit/flowOk/flowDeny (цвет, толщина, glow, alpha),
палитра объединений, шрифты, параметры облака. Базовые цвета берутся из
CSS-переменных через getComputedStyle один раз при старте — рассync со
страницей исключён. Свечение — `ctx.shadowBlur` (замена drop-shadow),
union-заливка 0.07 / stroke 0.5 как сейчас.

Анимация камеры: `flyTo(target, ~250ms, easeOutCubic)` для наведения
поиском и кнопки fit; `Camera.fitView` подбирает z/центр под bbox мира
с паддингом; кнопка fit на обеих страницах. Колесо-зум мгновенный (как
в tldraw), анимируются только программные переходы.

Переходы состояний ~150 мс через твины alpha/glow: выделение,
search-hit, окраска потока симуляции; появление нового узла — короткий
scale-fade; удаление — мгновенно.

Полировка: скругления узлов (rx из KINDS → roundRect), лёгкая тень
узла в hover, пунктир фильтрованных связей сохраняется.

## Тестирование

node:test + стабы, без браузера (`node --test
'internal/httpapi/web/*.test.js'`; glob обязателен):

| Что | Как |
|---|---|
| `TopoScene.buildScene` | чистые тесты display list: состав/порядок примитивов, разрешённые стили по состояниям, unionBox, layout defaults — без DOM |
| `hit_test` | чистая геометрия: попадание в узел, близость к кривой, marquee |
| `CanvasView` | ctx-стаб-рекордер: порядок команд, setTransform камеры, пропуск закулленных примитивов |
| `tween`, `Camera.fitView/flyTo` | чистые математические тесты |
| страницы topology/simulate | vm-boot со стабами как сейчас; `<canvas>` получает `getContext()` → рекордер; ассерты, что drag/select/delete/connect меняют state |

Существующие `topology_render.test.js`, `topology_search.test.js`,
`simulate_page.test.js` адаптируются: ассерты по display list вместо
обхода SVG-дерева.

## Порядок реализации (для плана)

1. Фундамент: `tween`, `canvas_theme`, `canvas_view`, `hit_test` — с
   тестами.
2. `TopoScene.buildScene`: display list строится параллельно с текущим
   SVG-рендером; переключение страниц одним коммитом.
3. Симуляция (read-only, проще) → редактор (инструменты, drag,
   marquee, popover).
4. Удаление SVG-ветвей, стейдж-модели симуляции, мёртвого CSS.

## Верификация

После каждого шага: `go build ./... && go vet ./... && gofmt -l .` +
`go test ./...` + `node --test 'internal/httpapi/web/*.test.js'`.
Ассеты встроены через go:embed — после правок пересборка бинарника
(`make build`), иначе `serve` показывает старый UI.
