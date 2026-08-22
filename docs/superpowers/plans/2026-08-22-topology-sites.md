# Локации (sites) в топологии — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить сущность «локация» (Site) в топологию: секция `sites:` в topology.yaml, API round-trip, визуальные рамки и редактирование в веб-UI.

**Architecture:** Site — чисто презентационная сущность (map имён в модели, срез в wire-документе). Рамки в SVG вычисляются как bounding box позиций членов из layout-состояния; членство редактируется через контекстное меню узла и панель локаций; сохранение — существующим документным `PUT /api/topology`.

**Tech Stack:** Go (yaml.v3, net/http), vanilla JS + SVG (node:test с DOM-заглушками).

**Spec:** `docs/superpowers/specs/2026-08-22-topology-sites-design.md`

## Global Constraints

- Проверка после каждой задачи, по порядку: `go build ./...`; `go vet ./...`; `gofmt -l .` (пустой вывод); `go test ./...`.
- JS-тесты: `node --test 'internal/httpapi/web/*.test.js'` (glob обязателен).
- Стиль кода — компактный, комментарии короткие пояснительные, как у соседнего кода.
- Секция `sites:` необязательна: старый topology.yaml без неё должен загружаться.
- Коммит после каждой задачи; стиль коммитов — `feat:`/`test:` как в истории репозитория.

---

### Task 1: Модель Site и загрузка YAML

**Files:**
- Modify: `internal/topology/model.go`
- Modify: `internal/topology/load.go`
- Test: `internal/topology/load_test.go`

**Interfaces:**
- Produces: `type Site struct { Name string; Devices []string; Networks []string; Description string }`, поле `Topology.Sites map[string]Site`. Их используют задачи 2–4.

- [ ] **Step 1: Write the failing test**

Добавить в `internal/topology/load_test.go`:

```go
func TestLoad_Sites(t *testing.T) {
	in := `
devices:
  - {name: r1, kind: router}
links: []
networks:
  - {name: net1, subnets: [a]}
sites:
  - name: office
    description: Главный офис
    devices:  [r1]
    networks: [net1]
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	s, ok := topo.Sites["office"]
	if !ok {
		t.Fatalf("site office missing: %+v", topo.Sites)
	}
	if s.Description != "Главный офис" || !slices.Equal(s.Devices, []string{"r1"}) || !slices.Equal(s.Networks, []string{"net1"}) {
		t.Fatalf("unexpected site: %+v", s)
	}
}

func TestLoad_TopologyWithoutSitesStillLoads(t *testing.T) {
	in := "devices:\n  - {name: r1, kind: router}\nlinks: []\nnetworks: []\nsets: []\n"
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Sites) != 0 {
		t.Fatalf("expected no sites, got %+v", topo.Sites)
	}
}

func TestLoad_DuplicateSiteName(t *testing.T) {
	in := `
devices: []
links: []
networks: []
sites:
  - {name: office}
  - {name: office}
`
	if _, err := Load(strings.NewReader(in)); err == nil || !strings.Contains(err.Error(), "duplicate site") {
		t.Fatalf("want duplicate site error, got %v", err)
	}
}
```

Импорт `"slices"` добавить в тестовый файл.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/topology/ -run TestLoad_S -v`
Expected: FAIL — поле `Sites` не существует (ошибка компиляции).

- [ ] **Step 3: Write minimal implementation**

В `model.go` после типа `Set`:

```go
// Site is a visual grouping of devices and networks: one location.
// Purely presentational — it never affects compilation.
type Site struct {
	Name        string
	Devices     []string // refs to Device
	Networks    []string // refs to Network
	Description string   // optional note
}
```

В `Topology` добавить поле `Sites map[string]Site`.

В `load.go`: тип `yamlSite` (после `yamlSet`):

```go
type yamlSite struct {
	Name        string   `yaml:"name"`
	Devices     []string `yaml:"devices,omitempty"`
	Networks    []string `yaml:"networks,omitempty"`
	Description string   `yaml:"description,omitempty"`
}
```

В `yamlTopology` поле `Sites []yamlSite \`yaml:"sites"\``. В `Load()` инициализация `Sites: make(map[string]Site, len(raw.Sites))` в литерале `topo`, и цикл после цикла по `raw.Sets`:

```go
for _, s := range raw.Sites {
	if _, exists := topo.Sites[s.Name]; exists {
		return nil, fmt.Errorf("duplicate site name %q", s.Name)
	}
	topo.Sites[s.Name] = Site{Name: s.Name, Devices: s.Devices, Networks: s.Networks, Description: s.Description}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/topology/ -v`
Expected: PASS (все тесты пакета).

- [ ] **Step 5: Commit**

```bash
git add internal/topology/
git commit -m "feat(topology): site entity and sites section in topology.yaml"
```

---

### Task 2: Валидация сайтов

**Files:**
- Modify: `internal/topology/validate.go`
- Test: `internal/topology/validate_test.go`

**Interfaces:**
- Consumes: `Topology.Sites` из задачи 1.
- Produces: правила валидации внутри `Validate()` — вызывается `app.LoadProject`, ничего нового наружу.

- [ ] **Step 1: Write the failing test**

Посмотреть существующие тесты `validate_test.go` (как строятся `Topology{...}` в коде) и добавить:

```go
func TestValidate_Sites(t *testing.T) {
	base := func() *Topology {
		return &Topology{
			Devices:  map[string]Device{"r1": {Name: "r1", Kind: DeviceRouter}},
			Subnets:  map[string]Subnet{},
			Networks: map[string]Network{"net1": {Name: "net1"}},
			Sets:     map[string]Set{},
			Sites: map[string]Site{"office": {Name: "office", Devices: []string{"r1"}, Networks: []string{"net1"}}},
		}
	}
	if err := base().Validate(); err != nil {
		t.Fatalf("valid sites rejected: %v", err)
	}

	badRef := base()
	badRef.Sites["office"].Devices = []string{"ghost"}
	if err := badRef.Validate(); err == nil || !strings.Contains(err.Error(), `unknown device "ghost"`) {
		t.Fatalf("want unknown device error, got %v", err)
	}

	double := base()
	double.Sites["zavod"] = Site{Name: "zavod", Devices: []string{"r1"}}
	err := double.Validate()
	if err == nil || !strings.Contains(err.Error(), `both site "office" and "zavod"`) {
		t.Fatalf("want double membership error, got %v", err)
	}

	badNet := base()
	badNet.Sites["office"].Networks = []string{"ghost"}
	if err := badNet.Validate(); err == nil || !strings.Contains(err.Error(), `unknown network "ghost"`) {
		t.Fatalf("want unknown network error, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/topology/ -run TestValidate_Sites -v`
Expected: PASS для первого случая, но двойное членство не ловится → FAIL на `double`.

- [ ] **Step 3: Write minimal implementation**

В `validate.go` — в конце `Validate()` заменить `return t.validateSets()` на:

```go
if err := t.validateSets(); err != nil {
	return err
}
return t.validateSites()
```

Добавить (рядом с другими validate*):

```go
// validateSites checks member references exist and every device/network is
// a member of at most one site.
func (t *Topology) validateSites() error {
	devOwner := make(map[string]string, len(t.Devices))
	netOwner := make(map[string]string, len(t.Networks))
	for _, name := range sortedSiteNames(t.Sites) {
		s := t.Sites[name]
		for _, d := range s.Devices {
			if _, ok := t.Devices[d]; !ok {
				return fmt.Errorf("site %q: unknown device %q", name, d)
			}
			if prev, ok := devOwner[d]; ok {
				return fmt.Errorf("device %q belongs to both site %q and %q", d, prev, name)
			}
			devOwner[d] = name
		}
		for _, n := range s.Networks {
			if _, ok := t.Networks[n]; !ok {
				return fmt.Errorf("site %q: unknown network %q", name, n)
			}
			if prev, ok := netOwner[n]; ok {
				return fmt.Errorf("network %q belongs to both site %q and %q", n, prev, name)
			}
			netOwner[n] = name
		}
	}
	return nil
}

func sortedSiteNames(m map[string]Site) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/topology/ -v && go build ./... && go vet ./... && gofmt -l .`
Expected: PASS, gofmt пустой.

- [ ] **Step 5: Commit**

```bash
git add internal/topology/
git commit -m "feat(topology): validate site references and single membership"
```

---

### Task 3: HTTP API — DTO, сид, защита от удаления

**Files:**
- Modify: `internal/httpapi/dto.go`
- Modify: `internal/httpapi/store.go` (`emptyTopologyYAML`)
- Modify: `internal/app/deps.go` (`DeletionErrors`)
- Test: `internal/httpapi/handlers_test.go`

**Interfaces:**
- Consumes: `Topology.Sites`, `Validate()` (задачи 1–2).
- Produces: `type SiteDoc struct { Name string; Devices []string; Networks []string; Description string }` (json+yaml теги, omitempty на устройствах/сетях/описании), поле `TopologyDoc.Sites []SiteDoc`. Используется задачами 4–5.

- [ ] **Step 1: Write the failing test**

В `handlers_test.go`:

```go
func TestGetPutTopologyWithSites(t *testing.T) {
	h, store := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, "/api/topology", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body)
	}
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Sites) != 0 {
		t.Fatalf("expected empty sites on fixture, got %+v", got.Sites)
	}

	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links:    []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		Networks: []NetworkDoc{{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}}},
		Sets:     []SetDoc{},
		Sites:    []SiteDoc{{Name: "office", Devices: []string{"r1", "r2"}, Networks: []string{"n-office"}, Description: "hq"}},
	}
	rec = doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	raw, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read stored: %v", err)
	}
	var stored TopologyDoc
	if err := yaml.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("parse stored: %v", err)
	}
	if len(stored.Sites) != 1 || stored.Sites[0].Name != "office" || len(stored.Sites[0].Devices) != 2 {
		t.Fatalf("unexpected stored sites: %+v", stored.Sites)
	}

	// битая ссылка отклоняется
	doc.Sites[0].Devices = []string{"ghost"}
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown site member: status = %d, body = %s", rec.Code, rec.Body)
	}

	// двойное членство отклоняется
	doc.Sites[0].Devices = []string{"r1"}
	doc.Sites = append(doc.Sites, SiteDoc{Name: "second", Devices: []string{"r1"}})
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("double membership: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestDeletionGuardBlocksDeviceInSite(t *testing.T) {
	h, _ := newTestServer(t)
	base := func(devices []DeviceDoc, sites []SiteDoc) TopologyDoc {
		return TopologyDoc{
			Devices: devices,
			Links:   []LinkDoc{},
			Networks: []NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
			},
			Sets:  []SetDoc{},
			Sites: sites,
		}
	}
	all := base([]DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}}, []SiteDoc{{Name: "office", Devices: []string{"r1"}}})
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", all); rec.Code != http.StatusOK {
		t.Fatalf("seed status = %d, body = %s", rec.Code, rec.Body)
	}
	shrink := base(all.Devices[:1], []SiteDoc{})
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", shrink); rec.Code != http.StatusConflict {
		t.Fatalf("device in site: status = %d, body = %s", rec.Code, rec.Body)
	}
	if msg := errorBody(t, doJSON(t, h, http.MethodPut, "/api/topology", shrink)); !strings.Contains(msg, `site "office"`) {
		t.Fatalf("want site dependency in error, got %s", msg)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/httpapi/ -run 'TopologyWithSites|DeletionGuard' -v`
Expected: FAIL — компиляция: нет `SiteDoc`/`TopologyDoc.Sites`; после добавления поля — 409-тест падает (guard не знает о сайтах).

- [ ] **Step 3: Write minimal implementation**

`dto.go` — перед `TopologyDoc`:

```go
// SiteDoc is a visual location grouping devices and networks. Purely
// presentational: it never reaches the compiler.
type SiteDoc struct {
	Name        string   `json:"name" yaml:"name"`
	Devices     []string `json:"devices,omitempty" yaml:"devices,omitempty"`
	Networks    []string `json:"networks,omitempty" yaml:"networks,omitempty"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
}
```

В `TopologyDoc`: `Sites []SiteDoc \`json:"sites" yaml:"sites"\``.

`store.go`, `emptyTopologyYAML`: добавить `Sites: []SiteDoc{},`.

`internal/app/deps.go`, `DeletionErrors`: в блоке про удалённые устройства (где собираются `deps` из links и networks attach) добавить:

```go
for _, sn := range sortedKeys(next.Sites) {
	if slices.Contains(next.Sites[sn].Devices, name) {
		deps = append(deps, fmt.Sprintf("site %q", sn))
	}
}
```

В блоке про удалённые сети (`prev.Networks` → `next.Networks`, где есть только ruleDeps):

```go
var deps []string
for _, sn := range sortedKeys(next.Sites) {
	if slices.Contains(next.Sites[sn].Networks, name) {
		deps = append(deps, fmt.Sprintf("site %q", sn))
	}
}
deps = append(deps, ruleDeps(pol, name)...)
```

(сохранив текущий формат сообщения `network %q is still used by %s`). Проверить, что `sortedKeys` в deps.go обобщённая — при необходимости использовать её сигнатуру как у соседей.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./... && go vet ./... && gofmt -l .`
Expected: PASS весь репозиторий, gofmt пустой.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/dto.go internal/httpapi/store.go internal/app/deps.go internal/httpapi/handlers_test.go
git commit -m "feat(httpapi): sites in topology api, seed and deletion guard"
```

---

### Task 4: Отрисовка рамок локаций в SVG

**Files:**
- Modify: `internal/httpapi/web/topology.js`
- Modify: `internal/httpapi/web/style.css` (добавить стили `.site-frame`, `.site-label`)
- Test: `internal/httpapi/web/topology_render.test.js`

**Interfaces:**
- Consumes: `/api/topology` отдаёт `sites: [{name, devices?, networks?, description?}]` (задача 3).
- Produces (для задачи 5): функции `siteIndex(name, key)`, `setSite(name, key, idx)`, константа `SITE_COLORS` — определить в этом же IIFE `Topology`; рендер рамок в `render()` до wires.

- [ ] **Step 1: Write the failing test**

В `topology_render.test.js` расширить `responses["/api/topology"]` полем `sites: []` и добавить тесты:

```js
const sitesResponses = {
  ...responses,
  "/api/topology": {
    ...responses["/api/topology"],
    // сайт с пустыми списками членов рамки не получает
    sites: [{ name: "office", devices: ["r1", "r2"], networks: ["net1"] }],
  },
};

test("site frames render as bounding boxes behind the graph", async () => {
  const { canvas } = bootTopology(sitesResponses);
  await tick();
  const frames = withClass(canvas, "site-frame");
  assert.equal(frames.length, 1, "one frame for the non-empty site");
  const f = frames[0];
  // дефолтная раскладка: r1 (40,40), r2 (240,40), net1 (40,300);
  // bbox 40..380 x 40..360 плюс отступ 30 с каждой стороны
  assert.equal(f.attrs.x, 10);
  assert.equal(f.attrs.y, 10);
  assert.equal(f.attrs.width, 400);
  assert.equal(f.attrs.height, 380);
  const labels = texts(canvas);
  assert.ok(labels.includes("office"), "site name rendered");
});
```

Внимание: сайт с пустыми списками членов не рисует рамку — скорректировать ожидание на `frames.length === 1`, а второй цвет проверить, задав третьему сайту реальных членов:

```js
test("palette colors differ between sites and follow document order", async () => {
  const resp = JSON.parse(JSON.stringify(sitesResponses));
  resp["/api/topology"].sites = [
    { name: "a", devices: ["r1"] },
    { name: "b", devices: ["r2"] },
  ];
  const { canvas } = bootTopology(resp);
  await tick();
  const frames = withClass(canvas, "site-frame");
  assert.equal(frames.length, 2);
  assert.notEqual(frames[0].attrs.stroke, frames[1].attrs.stroke);
  assert.equal(frames[0].attrs["data-site"], "a");
});

test("frames sit behind wires and nodes", async () => {
  const { canvas } = bootTopology(sitesResponses);
  await tick();
  const vp = find(canvas, (n) => String(n.attrs.class || "").includes("viewport"));
  const kinds = vp.children.map((c) => String(c.attrs.class || ""));
  const firstFrame = kinds.findIndex((k) => k.includes("site-frame"));
  const firstWire = kinds.findIndex((k) => k.includes("wire"));
  assert.ok(firstFrame !== -1 && firstWire !== -1 && firstFrame < firstWire, "frame precedes wires in child order");
});

test("no site frames when topology has none", async () => {
  const { canvas } = bootTopology(responses);
  await tick();
  assert.equal(withClass(canvas, "site-frame").length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: новые тесты FAIL (класса `site-frame` нет), старые PASS.

- [ ] **Step 3: Write minimal implementation**

В `topology.js`:

1. В `State.topology` дефолт: `{ devices: [], links: [], networks: [], sites: [] }`.
2. Константы рядом с `DEVICE_W`:

```js
const SITE_PAD = 30;
// палитра различимых оттенков; цвет = порядок сайта в документе
const SITE_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
```

3. Хелперы (рядом с `netCenter`):

```js
// siteBox вычисляет bbox членов сайта в мировых координатах или null,
// если ни один член не имеет позиции в layout.
function siteBox(s) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  (s.devices || []).forEach((n) => {
    const p = State.layout.devices[n];
    if (!p) return;
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
    x2 = Math.max(x2, p.x + DEVICE_W); y2 = Math.max(y2, p.y + DEVICE_H);
  });
  (s.networks || []).forEach((n) => {
    const p = State.layout.networks[n];
    if (!p) return;
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
    x2 = Math.max(x2, p.x + NET_W); y2 = Math.max(y2, p.y + NET_H);
  });
  if (x1 === Infinity) return null;
  return { x: x1 - SITE_PAD, y: y1 - SITE_PAD, w: x2 - x1 + 2 * SITE_PAD, h: y2 - y1 + 2 * SITE_PAD };
}
```

4. В начале `render()` сразу после создания и аппенда `viewportG`:

```js
(State.topology.sites || []).forEach((s, i) => {
  const box = siteBox(s);
  if (!box) return;
  const color = SITE_COLORS[i % SITE_COLORS.length];
  viewportG.append(el("rect", {
    class: "site-frame", "data-site": s.name,
    x: box.x, y: box.y, width: box.w, height: box.h, rx: 14,
    fill: color, "fill-opacity": 0.07, stroke: color, "stroke-opacity": 0.5,
  }));
  viewportG.append(el("text", { class: "site-label", x: box.x + 12, y: box.y - 8, fill: color }, s.name));
});
```

5. `style.css`:

```css
.site-frame { pointer-events: none; }
.site-label { font-size: 12px; font-weight: 600; pointer-events: none; }
```

(подогнать под переменные темы style.css, если там используются var(--…): цвет приходит инлайновым атрибутом — это осознанно.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: PASS все.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/topology.js internal/httpapi/web/style.css internal/httpapi/web/topology_render.test.js
git commit -m "feat(ui): render site frames as bounding boxes on topology canvas"
```

---

### Task 5: Редактирование локаций в веб-UI

**Files:**
- Modify: `internal/httpapi/web/topology.html` (кнопка тулбара + панель)
- Modify: `internal/httpapi/web/topology.js` (панель, контекстное меню, скраббинг при удалении узлов)
- Modify: `internal/httpapi/web/style.css` (стили панели)
- Test: `internal/httpapi/web/topology_render.test.js` (+ при желании отдельный `sites_page.test.js`)

**Interfaces:**
- Consumes: `State.topology.sites`, `render()`, `showContextMenu`, паттерн `contextMenu` из topology.js; сохранение — существующий `PUT /api/topology` (задача 3).
- Produces: готовый пользовательский сценарий создания/удаления локаций и назначения членов.

- [ ] **Step 1: Write the failing test**

В `topology_render.test.js`:

```js
test("sites panel creates a site and marks page dirty", async () => {
  const { canvas, ids, get } = bootTopology(responses);
  await tick();
  fire(ids["tool-sites"], "click", {});
  assert.ok(!ids["sites-panel"].hidden, "panel opens");
  ids["site-name-input"].value = "office";
  ids["site-desc-input"].value = "hq";
  fire(ids["site-form"], "submit", {});
  assert.equal(get("State.topology.sites.length"), 1, "site appended to the document");
  assert.equal(get("DirtyGuard.isDirty()"), true, "unsaved site makes the page dirty");
  fire(ids["tool-sites"], "click", {});
  assert.ok(ids["sites-panel"].hidden, "panel toggles closed");
});

test("duplicate site name is rejected", async () => {
  const { ids, get } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], sites: [{ name: "office" }] },
  });
  await tick();
  fire(ids["tool-sites"], "click", {});
  ids["site-name-input"].value = "office";
  fire(ids["site-form"], "submit", {});
  assert.equal(get("State.topology.sites.length"), 1, "no duplicate appended");
});

test("context menu assigns a node to a site and removes it back", async () => {
  const { canvas, doc, get } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], sites: [{ name: "office", devices: [] }] },
  });
  await tick();
  const rect = deviceRects(canvas)[0]; // r1
  fire(rect, "contextmenu", { clientX: 60, clientY: 60 });
  const menu = get("document.getElementById('topo-context-menu')");
  const assign = menu.children.find((b) => String(b._text || "").includes("office"));
  assert.ok(assign, "assign item listed");
  assign.onclick({ stopPropagation() {} });
  assert.deepEqual(get("State.topology.sites[0].devices"), ["r1"], "member recorded");

  fire(deviceRects(canvas)[0], "contextmenu", { clientX: 60, clientY: 60 });
  const menu2 = get("document.getElementById('topo-context-menu')");
  const unassign = menu2.children.find((b) => String(b._text || "").includes("Убрать"));
  unassign.onclick({ stopPropagation() {} });
  assert.deepEqual(get("State.topology.sites[0].devices"), [], "membership cleared");
});

test("deleting a node scrubs it from site membership", async () => {
  const { canvas, doc, sandbox } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], sites: [{ name: "office", devices: ["r1"] }] },
  });
  sandbox.confirm = () => true;
  await tick();
  selectNode(doc, deviceRects(canvas)[0]);
  fire(doc, "keydown", { key: "Delete" });
  const sites = vm.runInContext("State.topology.sites", sandbox);
  assert.deepEqual(sites[0].devices, [], "r1 dropped from site");
});

test("deleting a site keeps its nodes", async () => {
  const { canvas, ids } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], sites: [{ name: "office", devices: ["r1"] }] },
  });
  await tick();
  fire(ids["tool-sites"], "click", {});
  const row = ids["sites-list"].children[0];
  const del = row.children.find((b) => b.tag === "button");
  del.onclick({ stopPropagation() {} });
  assert.ok(texts(canvas).includes("r1 (router)"), "node kept");
});
```

Примечание: доступ к контекстному меню в тестах — через `get("document.getElementById('topo-context-menu')")` либо через `ids` (registry уже возвращает элементы по id — использовать `ids["topo-context-menu"]`, как в существующем тесте «context menu deletes a node»).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: новые FAIL (`tool-sites` не существует → `fire` упадёт на undefined listeners; пунктов меню нет).

- [ ] **Step 3: Write minimal implementation**

`topology.html` — кнопка в тулбаре перед разделителем сохранения:

```html
<button id="tool-sites" class="tool" title="Локации (L)" aria-label="Локации">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
  </svg>
</button>
```

Панель внутрь `.canvas-wrap` (после `#node-popover`):

```html
<div id="sites-panel" class="sites-panel" hidden>
  <h3>Локации</h3>
  <div id="sites-list"></div>
  <form id="site-form">
    <input id="site-name-input" placeholder="имя" autocomplete="off">
    <input id="site-desc-input" placeholder="описание" autocomplete="off">
    <button type="submit">Добавить</button>
  </form>
</div>
```

`topology.js`:

1. Хелперы членства (рядом с `deleteSelection`):

```js
const memberKey = (kind) => (kind === "device" ? "devices" : "networks");

function siteIndex(name, key) {
  return (State.topology.sites || []).findIndex((s) => (s[key] || []).includes(name));
}

// setSite перемещает объект в сайт idx (или из всех сайтов при idx<0).
function setSite(name, key, idx) {
  State.topology.sites.forEach((s) => { s[key] = (s[key] || []).filter((n) => n !== name); });
  if (idx >= 0) {
    const s = State.topology.sites[idx];
    s[key] = [...(s[key] || []), name];
  }
  render();
}

function dropMember(name, key) {
  (State.topology.sites || []).forEach((s) => { s[key] = (s[key] || []).filter((n) => n !== name); });
}
```

2. `contextDelete` принимает вид объекта и добавляет пункты локаций (существующие вызовы дополнить аргументом `"device"`/`"network"`):

```js
function contextDelete(elem, obj, label, kind) {
  elem.addEventListener("contextmenu", (e) => {
    if (State.tool !== "select") return;
    e.preventDefault();
    e.stopPropagation();
    const key = kind && memberKey(kind);
    const items = (State.topology.sites || [])
      .map((s, i) => [s, i])
      .filter(([s]) => !(s[key] || []).includes(obj.name))
      .map(([s, i]) => ["В локацию «" + s.name + "»", () => setSite(obj.name, key, i)]);
    if (siteIndex(obj.name, key) >= 0) items.push(["Убрать из локации", () => setSite(obj.name, key, -1)]);
    showContextMenu(screenPoint(e), [
      ["Удалить " + label, () => {
        State.selection.clear();
        State.selection.add(obj);
        deleteSelection();
        scheduleLayoutSave();
      }],
      ...items,
    ]);
  });
}
```

Вызовы: `contextDelete(rect, d, "устройство " + d.name, "device")`, `contextDelete(shape, n, "сеть " + n.name, "network")` (wire-вызовы — `kind` не передаётся, пунктов локаций у связей нет).

3. `deleteSelection`: в ветках удаления устройства/сети добавить `dropMember(d.name, "devices")` / `dropMember(n.name, "networks")`.

4. Панель:

```js
function renderSitesPanel() {
  const list = document.getElementById("sites-list");
  list.innerHTML = "";
  (State.topology.sites || []).forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "site-row";
    const label = document.createElement("span");
    const n = (s.devices || []).length + (s.networks || []).length;
    label.textContent = s.name + (s.description ? " — " + s.description : "") + ` (${n})`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.onclick = () => {
      State.topology.sites.splice(i, 1);
      renderSitesPanel();
      render();
    };
    row.append(label, del);
    list.append(row);
  });
}

function setupSitesPanel() {
  const panel = document.getElementById("sites-panel");
  document.getElementById("tool-sites").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    renderSitesPanel();
  });
  document.getElementById("site-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("site-name-input").value.trim();
    if (!name) return;
    if ((State.topology.sites || []).some((s) => s.name === name)) return showBanner(`Локация ${name} уже существует`);
    State.topology.sites = [...(State.topology.sites || []), {
      name,
      description: document.getElementById("site-desc-input").value.trim(),
      devices: [],
      networks: [],
    }];
    e.target.reset();
    renderSitesPanel();
    render();
  });
}
```

В `boot()` вызвать `setupSitesPanel()` рядом с остальными setup*. Горячая клавиша `l` — опционально в словарь shortcuts (не мешает существующим).

5. `style.css` (подгонеть цвета под тему — взять переменные соседних оверлеев, напр. как у `.node-popover`):

```css
.sites-panel {
  position: absolute;
  top: 56px;
  right: 12px;
  min-width: 240px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.site-row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
```

- [ ] **Step 4: Run tests and full verification**

Run: `node --test 'internal/httpapi/web/*.test.js' && go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: всё PASS, gofmt пустой.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/
git commit -m "feat(ui): edit sites from topology page (panel, context menu)"
```

---

### Task 6: Данные и финальная сверка со спекой

**Files:**
- Modify: `examples/topology.yaml` (если существует — посмотреть `ls examples/`; добавить секцию sites с примером, согласованную с его devices/networks; если файла нет — пропустить)
- Read-only сверка: `docs/superpowers/specs/2026-08-22-topology-sites-design.md`

**Interfaces:** — финальный аккорд, наружу ничего не даёт.

- [ ] **Step 1: Прогнать полный чек-лист верификации**

```bash
go build ./... && go vet ./... && gofmt -l . && go test ./... && node --test 'internal/httpapi/web/*.test.js'
```

Expected: всё зелёное, gofmt пустой.

- [ ] **Step 2: Сверить со спекой пункт за пунктом**

Пройти по разделам спеки: модель ✓ (Task 1), YAML ✓ (1), загрузка/валидация ✓ (1–2), API ✓ (3), отрисовка ✓ (4), редактирование ✓ (5), тесты ✓ (все). Раздел «Что не входит» — убедиться, что ничего лишнего не реализовано (нет координат рамок в layout, нет drag-to-assign, нет вложенности, компилятор не тронут).

- [ ] **Step 3: Commit (если были правки examples)**

```bash
git add examples/
git commit -m "docs(examples): sites section sample in example topology"
```
