# Link Ends Highlight — декомпозиция на задачи

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подсветка двух концов редактируемой связи цветами A/B (голубой `#0ea5e9` / оранжевый `#f97316`) на канве и в панелях редактирования; закрытие панелей снимает подсветку.

**Architecture:** Ядро (CanvasTheme.endA/endB, topo_scene styled(), topology.js setLinkPanelEnds, LinkPanel.show/attach onChange, колонки sideColumn) уже реализовано и зелёно. Осталось: CSS-переменные и классы полосок, тот же маркер на странице /ui/links, регрессионные тесты (канонический порядок колонок, снятие подсветки при закрытии), разбор флака теста #31, финальная верификация.

**Tech Stack:** Go (встраивание через go:embed), vanilla JS ES-модули, node:test c DOM-стабами (без package.json), Alpine.js для /ui/links, CSS custom properties.

**Spec:** docs/plans/2026-09-02-link-ends-highlight.md

## Global Constraints

- Цвета ровно: A `#0ea5e9`, B `#f97316`; контур канвы lineWidth 2.5 (уже в коде — не менять).
- A = алфавитно первое устройство (канонический порядок `sides()` в link_panel.js:121).
- Стороны a/b данных не переворачиваем — только порядок отображения.
- JS-тесты запускаются только гло́бом: `node --test 'internal/httpapi/web/*.test.js'` (на каталоге падает).
- После правок web/ обязательно `make build` (go:embed) — иначе `serve` покажет старый UI.
- Коммиты: маленькие, по одной задаче; только файлы этой задачи (`git add` с точными путями).
- Навигация по коду при исполнении — через встроенный LSP (typescript-language-server для web/*.js, gopls для Go), а не grep-бродение.

---

### Task 1: style.css — CSS-переменные end-цветов и классы полосок колонок

**Files:**
- Modify: `internal/httpapi/web/style.css` (`:root` ~строка 23, оба dark-блока ~строки 50-52 и 70-72, рядом с `.link-panel-grid` строка 452)

**Interfaces:**
- Consumes: ничего (чистый CSS).
- Produces: CSS-переменные `--link-end-a` / `--link-end-b` и классы `.link-end-col-a` / `.link-end-col-b` — их используют Task 2 (links.html) и уже существующий рендер link_panel.js (`sideColumn` вешает `link-end-col-a`/`link-end-col-b`, link_panel.js:171).

- [ ] **Step 1: Добавить переменные в три темы**

В `:root` (после `--kind-network: #16a34a;`, строка 23) добавить:

```css
  /* link-edit end markers: A/B colors shared by the canvas and panel columns */
  --link-end-a: #0ea5e9;
  --link-end-b: #f97316;
```

Те же две строки добавить в `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` (после `--kind-network: #4ade80;`, строка 52) и в `:root[data-theme="dark"] { … }` (после `--kind-network: #4ade80;`, строка 72). Значения в dark-блоках те же самые (цвета специально контрастны обеим темам).

- [ ] **Step 2: Добавить классы полосок**

Сразу после строки 452 (`.link-panel-grid { … }`) добавить:

```css
.link-end-col-a { border-left: 3px solid var(--link-end-a); padding-left: 8px; }
.link-end-col-b { border-left: 3px solid var(--link-end-b); padding-left: 8px; }
```

- [ ] **Step 3: Проверка**

Запуск: `go build ./...` (CSS встроен, только санити) и `gofmt -l .` — пусто. Визуальной проверки в браузере не требуется (правило AGENTS.md).

- [ ] **Step 4: Commit**

```bash
git add internal/httpapi/web/style.css
git commit -m "style: link-end A/B color variables and panel column stripes"
```

---

### Task 2: Диалог /ui/links — классы полосок на fieldset сторон

**Files:**
- Modify: `internal/httpapi/templates/links.html:57-58` (fieldset внутри `x-for="side in ['a','b']"`)

**Interfaces:**
- Consumes: классы `.link-end-col-a`/`.link-end-col-b` из Task 1; канонический порядок сторон links.js (`normalizeLink()` кладёт алфавитно первое устройство в `a` — сторона `a` шаблона всегда = конец A).
- Produces: визуальная маркировка сторон в модалке /ui/links, консистентная с канвой и canvas-панелью.

- [ ] **Step 1: Добавить :class на fieldset**

В `internal/httpapi/templates/links.html` заменить (строки 57-58):

```html
    <template x-for="side in ['a', 'b']" :key="side">
      <fieldset>
```

на:

```html
    <template x-for="side in ['a', 'b']" :key="side">
      <fieldset :class="side === 'a' ? 'link-end-col-a' : 'link-end-col-b'">
```

- [ ] **Step 2: Прогнать JS-тесты страницы ссылок**

Запуск: `node --test internal/httpapi/web/links_page.test.js`
Expected: все PASS (шаблон не тестируется node-тестами напрямую — правка чисто презентационная; тесты должны остаться зелёными как регрессионный фильтр).

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/templates/links.html
git commit -m "ui: mark /ui/links dialog sides with link-end A/B stripes"
```

---

### Task 3: link_panel.test.js — регрессионный тест канонического порядка колонок

**Files:**
- Modify: `internal/httpapi/web/link_panel.test.js` (добавить тест после «sides render in canonical order…», строка 212)

**Interfaces:**
- Consumes: `LinkPanel.show(link, deps, at)` (link_panel.js:207), `sideColumn(side, endClass)` вешает `endClass` на wrap (link_panel.js:103), хелперы файла `findAll`/`texts`/`showPanel`/`boot`.
- Produces: тест «column end classes follow the canonical order even when the first device is stored in b» — фиксирует контракт: колонка с классом `link-end-col-a` рендерится первой и принадлежит алфавитно первому устройству, даже если оно лежит в `link.b`.

- [ ] **Step 1: Написать тест**

После теста `sides render in canonical order regardless of which end is stored as a` (заканчивается на строке 212) добавить:

```js
  test("column end classes follow the canonical order even when the first device is stored in b", async () => {
    const page = boot();
    const swapped = { a: { device: "r2" }, b: { device: "r1" }, filter: { aExports: ["office"], bExports: [] } };
    showPanel(page, swapped);
    await Promise.resolve();
    const cols = findAll(page.body, (n) => n.attrs.class === "link-end-col-a" || n.attrs.class === "link-end-col-b");
    assert.deepEqual(cols.map((c) => c.attrs.class), ["link-end-col-a", "link-end-col-b"],
      "col-a renders before col-b");
    assert.match(texts(cols[0]).join("|"), /r1 → r2/, "col-a (end A color) belongs to r1, alphabetically first");
    assert.match(texts(cols[1]).join("|"), /r2 → r1/, "col-b (end B color) belongs to r2");
  });
```

- [ ] **Step 2: Запустить и убедиться, что тест проходит**

Запуск: `node --test internal/httpapi/web/link_panel.test.js`
Expected: PASS. Реализация (`sideColumn(first, "link-end-col-a")` в link_panel.js:171) уже канонична — тест фиксирует контракт; RED-этапа здесь нет, потому что поведение уже реализовано в предыдущей задаче. Если тест падает — это реальный баг в порядке колонок: чинить link_panel.js, а не тест.

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/web/link_panel.test.js
git commit -m "test: link panel columns carry end classes in canonical order"
```

---

### Task 4: topology_render.test.js — снятие подсветки при закрытии панели

**Files:**
- Modify: `internal/httpapi/web/topology_render.test.js` (добавить тесты после «link panel uses the shared floating-panel header and close action», строка 1507)

**Interfaces:**
- Consumes: `LinkPanel.attach(canvas, getCamera, onChange)` c `onClose: () => { s = null; onChange(null); }` (link_panel.js:242), `setLinkPanelEnds(null)` → `render()` (topology.js:379), цвета из `CanvasTheme.create` (fallback `theme.kind.router === "#d97706"` — стаб `getComputedStyle` возвращает "", canvas_theme.js:24); пути закрытия: Escape (floating_panel.js:133-135), крестик `#link-panel-close`, кнопка «Применить» → `panel.close()` (link_panel.js:139).
- Produces: тесты, фиксирующие что все пути закрытия возвращают контуры устройств к цвету типа (`#d97706`, оба устройства — роутеры в fixture `responses`).

- [ ] **Step 1: Написать тесты**

После теста `link panel uses the shared floating-panel header and close action` (строка 1507) добавить:

```js
// каждый путь закрытия панели обязан снять end-подсветку: контуры устройств
// возвращаются к цвету типа (router => #d97706), а не остаются end-a/end-b
test("closing the link panel with Escape restores the device kind strokes", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  fire(page.doc, "keydown", { key: "Escape" });
  assert.ok(page.ids["link-panel"].hidden, "panel closed");
  assert.equal(byId(page.get, "device:r1").style.stroke, "#d97706", "end-a outline cleared on Escape");
  assert.equal(byId(page.get, "device:r2").style.stroke, "#d97706", "end-b outline cleared on Escape");
});

test("closing the link panel with the close button restores the device kind strokes", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  fire(page.ids["link-panel-close"], "click", {});
  assert.ok(page.ids["link-panel"].hidden, "panel closed");
  assert.equal(byId(page.get, "device:r1").style.stroke, "#d97706", "end-a outline cleared via close button");
  assert.equal(byId(page.get, "device:r2").style.stroke, "#d97706", "end-b outline cleared via close button");
});

test("applying from the link panel clears the end outlines too", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  fire(findBtn(page.ids["link-panel-body"], (b) => String(b.textContent).trim() === "Применить"), "click", {});
  assert.ok(page.ids["link-panel"].hidden, "panel closed");
  assert.equal(byId(page.get, "device:r1").style.stroke, "#d97706", "end-a outline cleared on apply");
  assert.equal(byId(page.get, "device:r2").style.stroke, "#d97706", "end-b outline cleared on apply");
});
```

- [ ] **Step 2: Запустить и убедиться, что тесты проходят**

Запуск: `node --test internal/httpapi/web/topology_render.test.js`
Expected: PASS. Цепочка `close → onClose → onChange(null) → setLinkPanelEnds(null) → render()` уже реализована (link_panel.js:242, topology.js:379) — тесты фиксируют контракт всех трёх путей. Если падает: сначала проверить, что соответствующий путь реально вызывает `panel.close()` (а не только `hidden = true`), и только потом править тест.

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/web/topology_render.test.js
git commit -m "test: link panel close paths clear the canvas end outlines"
```

---

### Task 5: Флак теста #31 «connect tool previews from a network and cancels on repeated click»

**Files:**
- Modify: `internal/httpapi/web/topology_render.test.js:777-791` (тест) и, при подтверждении регрессии, `internal/httpapi/web/topology.js` (`cancelPending` 1203-1207, `setupPointer` mousemove 1250-1269)
- Create: временно — ничего; диагностика через запуск с `--test-name-pattern`

**Interfaces:**
- Consumes: `previewWire` живёт в topology.js (объявление 278, сброс в mousemove 1254, в `cancelPending` 1205, рисуется в display list 1373); dash `[6,4]` рисуют и превью (topology.js:1262), и фильтрованные связи (topo_scene.js:142) — в fixture `responses` фильтрованных связей нет, поэтому в этом тесте единственный легальный источник dash — превью.
- Produces: стабильно зелёный тест #31; при найденной регрессии — фикс в production-коде.

- [ ] **Step 1: Воспроизвести и локализовать**

Запустить по отдельности и в файле (10 прогонов каждый):

```bash
for i in $(seq 1 10); do node --test --test-name-pattern="cancels on repeated click" internal/httpapi/web/topology_render.test.js 2>&1 | grep -E "^# fail"; done
for i in $(seq 1 10); do node --test internal/httpapi/web/topology_render.test.js 2>&1 | grep -E "^# fail"; done
```

Зафиксировать, в каком режиме флакует. Затем через LSP (typescript-language-server, find references на `previewWire` и `cancelPending` в topology.js) проверить гипотезы по порядку:
1. **Лишний `render()` из `setLinkPanelEnds`/`onChange`** — `LinkPanel.attach` при открытии панели не участвует в этом тесте (панель не открывается), но убедиться через LSP, что третий аргумент `onChange` не вызывается при `attach(null)`-сценарии и не добавляет frames в rAF-очередь.
2. **Не сработал cancel**: `clickNode(page, "net1")` (mousedown+mouseup) должен попасть в ветку «повторный клик по pending-узлу → `cancelPending()`». Если hit-test из-за rAF-твина камеры/pop-анимации сместил узел, cancel не происходит, и последующий `mousemove` рисует новый превью-провод → +1 dash. Проверить: после cancel выполнить `page.pump()` ДО `mousemove` и посмотреть, исчезает ли флак.
3. **Кумулятивный подсчёт по общему `ctx.calls`**: кадры предыдущих тестов/бутов попадают в текущий rafQueue (`global.requestAnimationFrame` перезаписывается каждым `bootTopology`, topology_render.test.js:285).

- [ ] **Step 2: Зафиксировать тест от кумулятивного подсчёта (минимальный фикс)**

Независимо от причины (2 — регрессия, её чинить в production-коде; иначе — изоляция) заменить хвост теста (строки 786-790):

```js
  const before = dashes();
  clickNode(page, "net1"); // повторный клик отменяет pending
  fire(page.canvas, "mousemove", { clientX: 520, clientY: 310 });
  page.pump();
  assert.equal(dashes(), before, "no new preview dash after cancel");
```

на дельту с очисткой буфера вызовов — считаем только то, что нарисовано после cancel:

```js
  page.ctx.calls.length = 0; // isolate: only what is painted after the cancel counts
  clickNode(page, "net1"); // повторный клик отменяет pending
  page.pump();
  fire(page.canvas, "mousemove", { clientX: 520, clientY: 310 });
  page.pump();
  const after = page.ctx.calls.filter((c) => c[0] === "setLineDash" && String(c[1][0]) === "6,4").length;
  assert.equal(after, 0, "no preview dash painted after cancel");
```

Комментарий «isolate» обязателен — он объясняет, почему очистка буфера легитимна (в fixture нет фильтрованных связей, единственный источник `[6,4]` — превью).

- [ ] **Step 3: Если причина — регрессия (гипотеза 2), починить production-код**

Только если Step 1 показал, что `pending` не сбрасывается повторным кликом: в `setupPointer`/обработчике клика по pending-узлу (топология вокруг topology.js:1250-1270) гарантировать, что повторный клик по тому же узлу вызывает `cancelPending()` до любого `mousemove`-рейтрейда. Изменение минимальное, без рефакторинга.

- [ ] **Step 4: Стабильность**

```bash
for i in $(seq 1 20); do node --test internal/httpapi/web/topology_render.test.js 2>&1 | grep -E "^# fail"; done
```

Expected: `0` во всех 20 прогонах.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/topology_render.test.js
# + internal/httpapi/web/topology.js, если чинился production-код
git commit -m "test: isolate connect-preview dash count after cancel"
```

---

### Task 6: Финальная верификация (порядок из AGENTS.md)

**Files:** без изменений кода; фикс-only.

- [ ] **Step 1: Прогнать полную цепочку проверок**

```bash
go build ./...
go vet ./...
gofmt -l .        # должно напечатать ничего
go test ./...
node --test 'internal/httpapi/web/*.test.js'   # гло́б обязателен
```

Expected: всё зелёное, `gofmt -l` пустой.

- [ ] **Step 2: Пересобрать бинарник (go:embed web/)**

```bash
make build
```

Без этого `serve` покажет старый UI (правки style.css/links.html не попадут в бинарь).

- [ ] **Step 3: Итог**

Убедиться `git log --oneline -6` содержит коммиты Tasks 1-5 и `git status` чист по затронутым файлам. E2E Playwright (`make test-e2e`) — не запускать: правки презентационные, правило AGENTS.md (только автоматические тесты кода).

---

## Примечания

- Панель на канве и /ui/links подсвечивают только визуально; реальные стороны a/b данных не трогаются.
- Старые тесты `links_page.test.js` уже обновлены под канонический порядок (предыдущая задача) — их правки в Task 2 не требуются.
- LSP: во всех задачах навигация (def/references) — через встроенный LSP; для web/*.js работает typescript-language-server (v5.3.0), для Go — gopls (v0.23.0).
