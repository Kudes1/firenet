# Переход `internal/httpapi/web/*.js` на ES-модули

Дата: 2026-08-29
Статус: принят к реализации

## Контекст и цели

Из `TODO.md`: зависимости между файлами топологии/диагностики
(`camera.js`, `canvas_view.js`, `hit_test.js`, `topo_scene.js`,
`minimap.js` и т.д.) сейчас неявные — каждый файл кладёт объект в
глобальную область (`const Camera = (() => {...})();`), а порядок
подключения задаётся вручную списком `<script src="...">` в каждом
HTML и повторяется вручную в каждом тесте. По мере роста числа файлов
это становится источником ошибок (не тот порядок скриптов, забытый
`<script>` при добавлении нового модуля).

Цель — заменить глобальные объекты на явный граф `import`/`export`
между файлами, используя только нативную поддержку ES-модулей
браузером и Node (`import()`), без сборщика, без package.json/node_modules
(жёсткое ограничение проекта, см. `AGENTS.md`).

Не входит:
- разбиение существующих файлов на более мелкие модули — только смена
  механизма подключения 1:1 по текущим границам файлов;
- задача JSDoc + `tsc --checkJs` из того же `TODO.md` — отдельный
  spec/plan после этого перехода;
- конвертация `alpine.min.js` (вендорный UMD-бандл) — остаётся
  классическим `<script defer>`, глобал `Alpine` виден изнутри модулей
  как и раньше.

Ограничения проекта: vanilla JS без package.json/node_modules/сборки;
тесты — `node --test 'internal/httpapi/web/*.test.js'` (glob
обязателен, см. `AGENTS.md`/`README.md`), файлы тестов остаются
`.test.js`/CommonJS.

## Текущее состояние

Два паттерна экспорта в исходниках:

- **Файлы-неймспейсы** — `const X = (() => {...})();`, единственный
  глобал на файл: `camera.js` (`Camera`), `camera_input.js`
  (`CameraControls`), `canvas_theme.js` (`CanvasTheme`),
  `canvas_view.js` (`CanvasView`), `hit_test.js` (`HitTest`),
  `link_panel.js` (`LinkPanel`), `minimap.js` (`Minimap`),
  `net_info.js` (`NetInfo`), `netmap.js` (`NetMap`), `topo_scene.js`
  (`TopoScene`), `topology_sync.js` (`TopologySync`), `tween.js`
  (`Tween`), плюс `DirtyGuard` внутри `common.js`; page-контроллеры
  `diagnose.js`, `topology.js`, `drafts.js`, `history.js` того же вида.
- **Плоские файлы** — россыпь верхнеуровневых `function`/`const` без
  обёртки: `common.js` (`appData`, `showBanner`, `Api`, `apiPath`,
  `currentDraftID`, `assertEditable`, `ReadOnlyError`, ...),
  `columns.js` (`parseColumnWidths`, `applyColumnWidths`, ...).

HTML-страницы подключают зависимости вручную списком `<script
src="...">` в порядке, который потребитель обязан знать заранее
(пример, `diagnose.html`): `alpine.min.js` → `common.js` → `camera.js`
→ `minimap.js` → `camera_input.js` → `netmap.js` → `tween.js` →
`canvas_theme.js` → `hit_test.js` → `canvas_view.js` → `topo_scene.js`
→ `net_info.js` → `diagnose.js`.

Тесты (29 из 31 `*.test.js`) грузят исходники через `vm.runInContext`:
создают sandbox-объект с fake `document`/`window`/`canvas`,
`vm.createContext(sandbox)`, затем `vm.runInContext(fs.readFileSync(...),
sandbox)` для одного или нескольких файлов подряд (потребитель тестов
вручную повторяет порядок зависимостей), и вытаскивают глобалы через
`vm.runInContext("({ X, Y })", sandbox)`. Этот механизм не умеет
парсить `import`/`export`.

## Механика конвертации файлов

- Файлы-неймспейсы: `const X = (() => {...})();` → `export const X =
  (() => {...})();`. Внутренняя структура не меняется.
- Плоские файлы (`common.js`, `columns.js`): у каждой верхнеуровневой
  декларации, используемой хоть одним потребителем, добавляется
  `export`. Потребители импортируют только то, что реально
  используют: `import { Api, showBanner, apiPath } from "./common.js";`.
- Внутренние (непубличные) константы/функции файла export не
  получают.

## HTML

Список `<script src="/a.js"></script>` для каждого модуля-зависимости
сворачивается в один `<script type="module" src="/entry.js"></script>`,
где `entry.js` — текущий page-контроллер (`diagnose.js`, `topology.js`,
`networks.js` и т.п.), сам импортирующий нужные модули. `alpine.min.js`
остаётся первым отдельным `<script defer>` перед ним.

Порядок исполнения не меняется: модульные скрипты по умолчанию
откладываются (как `defer`) и выполняются в порядке документа вместе
с обычными `defer`-скриптами — `alpine.min.js` как и сейчас исполнится
первым, поскольку стоит раньше в разметке.

## Тестовая инфраструктура

Главный риск перехода: `vm.runInContext` даёт каждому тесту
изолированный fake-`window`/`document`/`canvas` через отдельный
context; `import()` кэширует модуль один раз на процесс.

Разрешение риска:

1. **Межфайловая изоляция сохраняется без изменений** — `node --test`
   уже запускает каждый `*.test.js` отдельным процессом (проверено:
   при передаче glob'а из нескольких файлов, тестраннер Node
   форкает процесс на файл), поэтому кэш модулей одного теста не
   протекает в другой тестовый файл.
2. **Внутрифайловая изоляция** — в исходниках `document`/`window`
   читаются как bare-идентификаторы **внутри функций**
   (`camera_input.js:75-81`, `canvas_view.js:76,91,109`), а не в
   module-scope в момент импорта. Значит достаточно подменять
   `global.window`/`global.document`/аргумент `canvas` перед каждым
   вызовом функции — повторный импорт модуля не нужен. Это
   распространяется на все файлы; при конвертации каждого конкретного
   файла нужно проверить, что в нём нет обращений к DOM-глобалам на
   верхнем уровне модуля (вне функций) — если найдётся, обернуть в
   ленивую инициализацию как точечную правку.
3. **Формат тестовых файлов не меняется** — остаются `.test.js` на
   CommonJS (`require("node:test")`), не переименовываются в `.mjs`.
   Так как top-level `await` недоступен в CommonJS, загрузка модуля
   оборачивается в async IIFE на верхнем уровне файла:

   ```js
   "use strict";
   const test = require("node:test");
   const assert = require("node:assert/strict");
   const path = require("node:path");

   (async () => {
     const { Camera } = await import(path.join(__dirname, "camera.js"));
     test("zoomAt keeps the anchor point fixed", () => { /* ... */ });
   })();
   ```

   Для тестов, что сейчас грузят несколько файлов сразу в общий
   sandbox (например `topo_scene.test.js`: `netmap.js` + `canvas_theme.js`
   + `topo_scene.js`), после конвертации достаточно `import()`
   верхнего файла (`topo_scene.js`) — он сам подтянет зависимости
   через свои `import`, вручную перечислять цепочку в тесте больше не
   нужно.
4. **`canvas_view.test.js`-паттерн** (`boot()` перезагружает исходник
   на каждый тест ради чистого состояния) — заменяется на
   однократный `import()` вне тестов + создание нового fake-`canvas`/
   `window` объекта на каждый вызов `boot()`, передаваемого как
   аргумент в `CanvasView.create(canvas, ...)` (сигнатура фабрики не
   меняется).

Прогон тестов не меняется: `node --test 'internal/httpapi/web/*.test.js'`.

## Порядок миграции

Снизу вверх по графу зависимостей — к моменту конвертации сложных
файлов их зависимости уже сконвертированы и покрыты тестами:

1. Листовые модули без внутренних зависимостей: `tween.js`,
   `camera.js`, `canvas_theme.js`, `hit_test.js`, `columns.js`,
   `common.js`.
2. Средний слой: `netmap.js`, `canvas_view.js`, `camera_input.js`,
   `minimap.js`, `net_info.js`, `topology_sync.js`.
3. Верхний слой сцены: `topo_scene.js`, `link_panel.js`.
4. Page-контроллеры вместе со своим HTML, по одной законченной
   странице за шаг: `diagnose.js`+`diagnose.html`,
   `topology.js`+`topology.html`, затем CRUD-страницы
   (`networks`, `rules`, `sets`, `subnets`, `unions`, `links`,
   `drafts`, `history`, `compile`, `login`, `users`).

Каждый шаг переводит один файл (или файл+HTML) на `export`/`import` и
чинит все тесты, которые его грузят, прежде чем переходить к
следующему — `common.js` используется всеми страницами, поэтому его
шаг влияет на большинство тестовых файлов сразу.

## Риски и открытые точки, закрываемые по ходу реализации

- Файл с обращением к `document`/`window` в module-scope (вне
  функций) — точечно оборачивается в ленивую инициализацию при
  конвертации именно этого файла.
- MIME-тип `.js`, отдаваемый `http.FileServer(http.FS(...))` из
  go:embed — стандартная библиотека Go отдаёт `text/javascript`,
  валидный для `type="module"`; проверяется на первом
  сконвертированном файле открытием страницы.

## Верификация

После каждого файла/шага: `node --test 'internal/httpapi/web/*.test.js'`.
В конце миграции: `go build ./... && go vet ./... && gofmt -l . && go
test ./...` (embed content не влияет на Go-тесты, но `make build`
нужен для проверки в браузере — по `Общие правила` полное браузерное
тестирование на каждое изменение не требуется, ограничиваемся
автотестами).
