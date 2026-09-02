# План действий (зафиксирован для продолжения)

## Контекст задачи
При редактировании связи подсвечивать её два устройства на канве разными
цветами (A/B) и помечать теми же цветами стороны в панелях редактирования,
чтобы пользователь не путал, какая колонка какому устройству соответствует.
A = алфавитно первое устройство (канонический порядок, согласован с уже
сделанной сортировкой сторон).

Цвета: A — голубой `#0ea5e9`, B — оранжевый `#f97316`.
Стиль подсветки канвы: цветной контур (lineWidth 2.5).

## Что УЖЕ сделано (в рабочем дереве, тесты зелёные кроме одного флака)

1. **`internal/httpapi/web/canvas_theme.js`** — в `create()` добавлены
   `endA: "#0ea5e9"` и `endB: "#f97316"` (после `flowHalf`).

2. **`internal/httpapi/web/topo_scene.js`** — в `styled()` добавлены строки:
   ```js
   if (states.has("end-a")) { st.stroke = theme.endA; st.lineWidth = 2.5; }
   if (states.has("end-b")) { st.stroke = theme.endB; st.lineWidth = 2.5; }
   ```

3. **`internal/httpapi/web/topology.js`**:
   - переменная `let linkPanelEnds = null;` (после `deviceEditPanel`) —
     `{first, second}` (имена устройств) или null;
   - `nodeClasses()`: в ветке `part === "shape"` добавлен класс
     `" end-a"`/`" end-b"`, если `obj.name` совпал с `linkPanelEnds.first/second`;
   - `openLinkPanel()`: в deps добавлено `onChange: setLinkPanelEnds`;
   - новая функция `setLinkPanelEnds(ends)` — пишет состояние и зовёт `render()`;
   - в `boot()`: `LinkPanel.attach(canvas(), () => State.camera, setLinkPanelEnds)`.

4. **`internal/httpapi/web/link_panel.js`**:
   - `show()`: после `panel.open()` — `deps.onChange({first, second})`
     (имена устройств по каноническому порядку через `sides()`);
   - `attach(canvasEl, getCamera, onChange)`: в `onClose` добавлен `onChange(null)`;
   - `sideColumn(side, endClass)`: вешает `endClass` как class на wrap;
   - `render()`: колонкам передаются `"link-end-col-a"`/`"link-end-col-b"`
     в каноническом порядке.

5. **Тест** в `topology_render.test.js` («opening the link panel outlines its
   endpoint devices in the end colors») — написан, зелёный.

## Что ОСТАЛОСЬ сделать (по порядку)

### Шаг 1. style.css — CSS-переменные + классы полосок
В `:root` (light) и в обоих dark-блоках добавить:
```css
--link-end-a: #0ea5e9;
--link-end-b: #f97316;
```
Рядом со стилями `.link-panel-grid`:
```css
.link-end-col-a { border-left: 3px solid var(--link-end-a); padding-left: 8px; }
.link-end-col-b { border-left: 3px solid var(--link-end-b); padding-left: 8px; }
```

### Шаг 2. Диалог /ui/links — templates/links.html
`links.js` после `normalizeLink()` держит стороны канонично (side a = A).
В `internal/httpapi/templates/links.html` на `<fieldset>` (в цикле
`x-for="side in ['a','b']"`) добавить:
```html
:class="side === 'a' ? 'link-end-col-a' : 'link-end-col-b'"
```

### Шаг 3. Недостающие тесты (TDD: RED → GREEN)
- `link_panel.test.js`: показать фильтрованную связь, где алфавитно первое
  устройство лежит в `b` → колонка с классом `link-end-col-a` должна
  рендериться первой и соответствовать ему (классы на wrap-элементах колонок).
- `topology_render.test.js`: закрыть панель каждым способом (Применить,
  Отмена, крестик `link-panel-close`, Escape, клик по фону) → контуры
  устройств возвращаются к цветам типов (не `#0ea5e9`/`#f97316`).
  Достаточно 2–3 путей закрытия.

### Шаг 4. Разобрать флак теста #31
`topology_render.test.js` «connect tool previews from a network and cancels
on repeated click» — падение «no new preview dash after cancel» (`2 !== 1`,
строка ~790): после отмены pending в `ctx.calls` оказался лишний
`setLineDash([6,4])`. На baseline стабилен, с правками задачи стабильно падал;
при выборе отдельных файлов — воспроизведение скачет → похоже на тайминги/
порядок microtask. Подозреваемый: лишний `render()` из цепочки
`setLinkPanelEnds`/`onChange` (панель в тесте не открывается, но
`LinkPanel.attach` теперь принимает третий аргумент — проверить, что ничего
не сломалось при null) либо кумулятивный подсчёт `dashes()` по общему
`ctx.calls`. Действие: локализовать реальную причину; если регрессии нет —
сделать подсчёт в тесте изолированным (дельта после cancel).

### Шаг 5. Верификация (порядок из AGENTS.md)
1. `go build ./...`
2. `go vet ./...`
3. `gofmt -l .` — должно быть пусто
4. `go test ./...`
5. `node --test internal/httpapi/web/*.test.js` — glob обязателен
   (на каталоге падает)
6. `make build` — web/ встроен через go:embed; без пересборки `serve`
   покажет старый UI

## Примечания
- Панель на канве подсвечивает только визуально (реальные стороны a/b не
  трогаем); страница /ui/links нормализует стороны и при сохранении.
- Старые тесты ссылок в `links_page.test.js` уже обновлены под канонический
  порядок (это было в предыдущей задаче).
