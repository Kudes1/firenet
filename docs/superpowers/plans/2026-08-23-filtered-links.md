# Filtered Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить фильтрованные связи — ограничения на то, какие сети/подсети «анонсируются» через связь (route-filter семантика), влияющие на размещение firewall-правил через граф путей.

**Architecture:** Фильтр — опциональное поле `Filter` у существующей связи (`topology.Link`). Граф помечает рёбра фильтрованных связей ограничениями (множества подсетей с каждой стороны); `AllSimplePaths` отсекает ветки DFS, где src/dst не входят в экспорт соответствующих сторон. Компилятор не меняется. UI: новая страница «Связи» + пунктирная отрисовка на холсте.

**Tech Stack:** Go (std + gopkg.in/yaml.v3), Alpine.js + нативные DOM-тесты node:test с VM-песочницей и DOM-заглушками.

**Spec:** `docs/superpowers/specs/2026-08-23-filtered-links-design.md`

## Global Constraints

- Проверка после каждой задачи, по порядку: `go build ./...` → `go vet ./...` → `gofmt -l .` (должно печатать пусто) → `go test ./...`. Для web-задач дополнительно: `node --test 'internal/httpapi/web/*.test.js'` (glob обязателен).
- Никакого линтера кроме `go vet` — golangci-lint не настраивать.
- YAML-декодер топологии работает с `KnownFields(true)` — новые поля обязательно добавлять в yaml-структуры.
- Списки экспорта сериализуются всегда (без `omitempty` внутри `LinkFilterDoc`); опционален только сам блок `filter`.
- После правок файлов в `internal/httpapi/web/` пересобрать бинарник (`make build`) — ассеты встроены через `go:embed`.
- Код компактный, без комментариев сверх тех, что объясняют инвариант (стиль репозитория — содержательные комментарии-инварианты).
- UI-копирайт — на русском.
- Тесты Go утверждают прямо на структуры/строки, golden-файлов нет.
- Коммитить только файлы своей задачи (`git add <paths>`), не трогать изменённые рабочие файлы из `git status`.

---

### Task 1: Модель LinkFilter и загрузка YAML

**Files:**
- Modify: `internal/topology/model.go`
- Modify: `internal/topology/load.go`
- Test: `internal/topology/load_test.go`

**Interfaces:**
- Consumes: ничего (первая задача).
- Produces: `type LinkFilter struct { AExports []string; BExports []string }`; поле `Link.Filter *LinkFilter` (nil = обычная связь). YAML-ключи `filter.a-exports` / `filter.b-exports`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `internal/topology/load_test.go`:

```go
func TestLoad_FilteredLink(t *testing.T) {
	in := `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
links:
  - a: {device: m}
    b: {device: d}
    filter:
      a-exports: [MARKET, mr-extra]
      b-exports: [MAIN]
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	l := topo.Links[0]
	if l.Filter == nil {
		t.Fatal("expected filter on link")
	}
	if !slices.Equal(l.Filter.AExports, []string{"MARKET", "mr-extra"}) || !slices.Equal(l.Filter.BExports, []string{"MAIN"}) {
		t.Fatalf("unexpected filter: %+v", l.Filter)
	}
}

func TestLoad_PlainLinkHasNoFilter(t *testing.T) {
	in := `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
links:
  - a: {device: m}
    b: {device: d}
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if topo.Links[0].Filter != nil {
		t.Fatal("plain link must have nil filter")
	}
}
```

(`slices` и `strings` уже импортированы в файле.)

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `go test ./internal/topology/ -run 'TestLoad_(FilteredLink|PlainLinkHasNoFilter)' -v`
Expected: FAIL — поле `Filter` не существует (ошибка компиляции).

- [ ] **Step 3: Минимальная реализация**

В `internal/topology/model.go` после типа `Endpoint` добавить:

```go
// LinkFilter restricts which entities each side exports across the link
// (route-filter semantics): traffic from subnet S to subnet D may cross
// in direction A→B only if S resolves from AExports and D from BExports.
type LinkFilter struct {
	AExports []string // networks/subnets side A announces
	BExports []string // networks/subnets side B announces
}
```

Поле `Link` расширить:

```go
type Link struct {
	A, B   Endpoint
	Filter *LinkFilter // nil = обычная связь полной связности
}
```

В `internal/topology/load.go` заменить `yamlLink` и дополнить `Load`:

```go
type yamlLinkFilter struct {
	AExports []string `yaml:"a-exports"`
	BExports []string `yaml:"b-exports"`
}

type yamlLink struct {
	A      yamlEndpoint    `yaml:"a"`
	B      yamlEndpoint    `yaml:"b"`
	Filter *yamlLinkFilter `yaml:"filter,omitempty"`
}
```

Цикл разбора ссылок:

```go
for _, l := range raw.Links {
	link := Link{A: Endpoint{Device: l.A.Device}, B: Endpoint{Device: l.B.Device}}
	if l.Filter != nil {
		link.Filter = &LinkFilter{AExports: l.Filter.AExports, BExports: l.Filter.BExports}
	}
	topo.Links = append(topo.Links, link)
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `go test ./internal/topology/ -v`
Expected: PASS (все тесты пакета).

- [ ] **Step 5: Коммит**

```bash
git add internal/topology/model.go internal/topology/load.go internal/topology/load_test.go
git commit -m "feat(topology): LinkFilter field with optional filter block in YAML"
```

---

### Task 2: Валидация фильтрованных связей

**Files:**
- Modify: `internal/topology/validate.go`
- Test: `internal/topology/validate_test.go`

**Interfaces:**
- Consumes: `Link.Filter *LinkFilter` из Task 1.
- Produces: три правила валидации (роутер–роутер, оба списка объявлены, имена резолвятся). Ошибки в стиле `link[0]: ...`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `internal/topology/validate_test.go`:

```go
func TestValidate_FilteredLink_OK(t *testing.T) {
	topo := baseTopology(t)
	topo.Links[0] = Link{
		A: Endpoint{"r1"}, B: Endpoint{"r2"},
		Filter: &LinkFilter{AExports: []string{"n1"}, BExports: []string{"n2"}},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_FilteredLink_NeedsTwoRouters(t *testing.T) {
	topo := baseTopology(t)
	topo.Devices["sw"] = Device{Name: "sw", Kind: DeviceSwitch}
	topo.Links[0] = Link{
		A: Endpoint{"r1"}, B: Endpoint{"sw"},
		Filter: &LinkFilter{AExports: []string{"n1"}, BExports: []string{"n2"}},
	}
	err := topo.Validate()
	if err == nil || !strings.Contains(err.Error(), "two routers") {
		t.Fatalf("expected two-routers error, got: %v", err)
	}
}

func TestValidate_FilteredLink_MissingSide(t *testing.T) {
	topo := baseTopology(t)
	topo.Links[0] = Link{A: Endpoint{"r1"}, B: Endpoint{"r2"}, Filter: &LinkFilter{}}
	err := topo.Validate()
	if err == nil || !strings.Contains(err.Error(), "must declare") {
		t.Fatalf("expected missing-side error, got: %v", err)
	}
}

func TestValidate_FilteredLink_UnknownExport(t *testing.T) {
	for _, f := range []LinkFilter{
		{AExports: []string{"ghost"}, BExports: []string{"n2"}},
		{AExports: []string{"n1"}, BExports: []string{"ghost"}},
	} {
		topo := baseTopology(t)
		topo.Links[0] = Link{A: Endpoint{"r1"}, B: Endpoint{"r2"}, Filter: &f}
		err := topo.Validate()
		if err == nil || !strings.Contains(err.Error(), "unknown export entity") {
			t.Fatalf("expected unknown export error, got: %v", err)
		}
	}
}

func TestValidate_FilteredLink_RejectsSetExport(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{"s1": {Name: "s1", Subnets: []string{"a"}}}
	topo.Links[0] = Link{
		A: Endpoint{"r1"}, B: Endpoint{"r2"},
		Filter: &LinkFilter{AExports: []string{"s1"}, BExports: []string{"n2"}},
	}
	err := topo.Validate()
	if err == nil || !strings.Contains(err.Error(), "unknown export entity") {
		t.Fatalf("sets are not valid exports, got: %v", err)
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `go test ./internal/topology/ -run 'TestValidate_FilteredLink' -v`
Expected: FAIL — ошибки валидации не существуют.

- [ ] **Step 3: Реализация**

В `internal/topology/validate.go`, в цикле `validateLinks` сразу после проверки дублей (`seen[pair] = i`) вставить:

```go
		if l.Filter != nil {
			if t.Devices[l.A.Device].Kind != DeviceRouter || t.Devices[l.B.Device].Kind != DeviceRouter {
				return fmt.Errorf("%s: filtered link must connect two routers", where)
			}
			if l.Filter.AExports == nil || l.Filter.BExports == nil {
				return fmt.Errorf("%s: filter must declare both a-exports and b-exports", where)
			}
			for _, name := range l.Filter.AExports {
				if !t.knownExport(name) {
					return fmt.Errorf("%s: unknown export entity %q", where, name)
				}
			}
			for _, name := range l.Filter.BExports {
				if !t.knownExport(name) {
					return fmt.Errorf("%s: unknown export entity %q", where, name)
				}
			}
		}
```

Хелпер рядом (в конце файла):

```go
// knownExport reports whether name may appear in a link filter's export
// list: networks and bare subnets qualify, sets do not.
func (t *Topology) knownExport(name string) bool {
	_, isSubnet := t.Subnets[name]
	_, isNetwork := t.Networks[name]
	return isSubnet || isNetwork
}
```

Примечание: пустой список легален («ничего не отдаю») — проверяется именно `nil`, который YAML даёт при отсутствующем ключе.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `go test ./internal/topology/ -v && go vet ./internal/topology/ && gofmt -l internal/topology/`
Expected: PASS, vet/gofmt чистые.

- [ ] **Step 5: Коммит**

```bash
git add internal/topology/validate.go internal/topology/validate_test.go
git commit -m "feat(topology): validate filtered links (two routers, declared sides, known exports)"
```

---

### Task 3: Граф — ограничения на рёбрах

**Files:**
- Modify: `internal/graph/graph.go`
- Test: `internal/graph/graph_test.go`

**Interfaces:**
- Consumes: `topology.Link.Filter`, `topology.Topology.ResolveNetwork(name) ([]string, error)`.
- Produces: `Edge.Allow *edgeAllow` (nil = неограниченное ребро); `Build` размечает рёбра фильтрованных связей роутер–роутер в обе стороны зеркально. Task 4 полагается на `e.Allow.From[src.Name]` / `e.Allow.To[dst.Name]`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `internal/graph/graph_test.go` (импорты `"net/netip"` и `"github.com/kudes1/firenet/internal/topology"` добавьте при отсутствии):

```go
func filteredTopo() *topology.Topology {
	return &topology.Topology{
		Devices: map[string]topology.Device{
			"m": {Name: "m", Kind: topology.DeviceRouter},
			"d": {Name: "d", Kind: topology.DeviceRouter},
			"o": {Name: "o", Kind: topology.DeviceRouter},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"b": {Name: "b", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
			"c": {Name: "c", CIDR: netip.MustParsePrefix("10.0.2.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": {Name: "NA", Subnets: []string{"a"}, Attach: []topology.Endpoint{{Device: "m"}}},
			"NB": {Name: "NB", Subnets: []string{"b"}, Attach: []topology.Endpoint{{Device: "d"}}},
			"NC": {Name: "NC", Subnets: []string{"c"}, Attach: []topology.Endpoint{{Device: "o"}}},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "m"}, B: topology.Endpoint{Device: "d"},
				Filter: &topology.LinkFilter{AExports: []string{"NA"}, BExports: []string{"NB"}}},
			{A: topology.Endpoint{Device: "d"}, B: topology.Endpoint{Device: "o"}},
		},
	}
}

func TestBuild_FilteredLinkAllowsAnnouncedPairs(t *testing.T) {
	g, err := Build(filteredTopo())
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("b"), DefaultLimits())
	if err != nil || len(paths) == 0 {
		t.Fatalf("a→b expected reachable, got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_FilteredLinkBlocksUnannouncedDst(t *testing.T) {
	g, _ := Build(filteredTopo())
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("c"), DefaultLimits())
	if err != nil || len(paths) != 0 {
		t.Fatalf("a→c must be filtered out, got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_FilteredLinkBlocksUnannouncedSrc(t *testing.T) {
	g, _ := Build(filteredTopo())
	paths, err := g.AllSimplePaths(SubnetNode("c"), SubnetNode("a"), DefaultLimits())
	if err != nil || len(paths) != 0 {
		t.Fatalf("c→a must be filtered out, got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_PlainLinkStillUnrestricted(t *testing.T) {
	topo := filteredTopo()
	topo.Links[0].Filter = nil // та же топология без фильтра
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	for _, pair := range [][2]string{{"a", "b"}, {"a", "c"}, {"c", "a"}} {
		paths, err := g.AllSimplePaths(SubnetNode(pair[0]), SubnetNode(pair[1]), DefaultLimits())
		if err != nil || len(paths) == 0 {
			t.Fatalf("%s→%s expected reachable without filter, got %d paths (%v)", pair[0], pair[1], len(paths), err)
		}
	}
}
```

Импорт `"net/netip"` понадобится для `netip.MustParsePrefix`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `go test ./internal/graph/ -run 'TestBuild_(Filtered|Plain)' -v`
Expected: FAIL — компиляция (`edgeAllow` нет) или a→b недостижима после разметки.

- [ ] **Step 3: Реализация**

В `internal/graph/graph.go`:

1) Тип `Edge` и новый тип:

```go
// Edge is a directed graph edge.
type Edge struct {
	To Node
	// Allow, when non-nil, carries only announced traffic: a path using
	// this edge must have src ∈ From and dst ∈ To (filtered-link rules).
	Allow *edgeAllow
}

// edgeAllow holds the subnet names each side of a filtered link announces
// across it, resolved at Build time.
type edgeAllow struct {
	From, To map[string]struct{}
}
```

2) Разбить `addEdge` на обёртку и вариант с ограничением:

```go
func (g *Graph) addEdge(from, to Node) {
	g.addEdgeAllow(from, to, nil)
}

func (g *Graph) addEdgeAllow(from, to Node, allow *edgeAllow) {
	for _, e := range g.adj[from] {
		if e.To == to {
			return
		}
	}
	g.adj[from] = append(g.adj[from], Edge{To: to, Allow: allow})
}
```

3) В `Build`, ветку `case !aIsSwitch && !bIsSwitch:` заменить на:

```go
		case !aIsSwitch && !bIsSwitch:
			var ab, ba *edgeAllow
			if l.Filter != nil {
				from, err := exportSubnets(topo, l.Filter.AExports)
				if err != nil {
					return nil, fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
				}
				to, err := exportSubnets(topo, l.Filter.BExports)
				if err != nil {
					return nil, fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
				}
				ab = &edgeAllow{From: from, To: to}
				ba = &edgeAllow{From: to, To: from}
			}
			g.addEdgeAllow(RouterNode(l.A.Device), RouterNode(l.B.Device), ab)
			g.addEdgeAllow(RouterNode(l.B.Device), RouterNode(l.A.Device), ba)
```

4) Хелпер внизу файла:

```go
// exportSubnets flattens export entity names (networks or bare subnets)
// into one deduplicated subnet-name set.
func exportSubnets(topo *topology.Topology, names []string) (map[string]struct{}, error) {
	out := make(map[string]struct{}, len(names))
	for _, name := range names {
		subs, err := topo.ResolveNetwork(name)
		if err != nil {
			return nil, err
		}
		for _, s := range subs {
			out[s] = struct{}{}
		}
	}
	return out, nil
}
```

Остальные вызовы `addUndirected` (подсети, доменные шины) не меняются — их рёбра остаются без `Allow`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `go test ./internal/graph/ -v && go vet ./internal/graph/ && gofmt -l internal/graph/`
Expected: PASS (включая все прежние тесты графа).

- [ ] **Step 5: Коммит**

```bash
git add internal/graph/graph.go internal/graph/graph_test.go
git commit -m "feat(graph): mark filtered-link edges with per-side subnet allowances"
```

---

### Task 4: Поиск путей учитывает ограничения + e2e размещения

**Files:**
- Modify: `internal/graph/pathfind.go`
- Test: `internal/graph/graph_test.go` (уже покрыто тестами Task 3)
- Test: `internal/app/compile_test.go`

**Interfaces:**
- Consumes: `Edge.Allow *edgeAllow` из Task 3.
- Produces: `AllSimplePaths` отсекает запрещённые рёбра; компилятор без изменений получает меньше путей (отрезанная пара → правило никуда не ставится).

- [ ] **Step 1: Написать падающий e2e-тест**

Добавить в `internal/app/compile_test.go`:

```go
const filteredChainTopology = `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
  - {name: o, kind: router}
links:
  - a: {device: m}
    b: {device: d}
    filter:
      a-exports: [NA]
      b-exports: [NB]
  - a: {device: d}
    b: {device: o}
networks:
  - {name: NA, subnets: [a], attach: [{device: m}]}
  - {name: NB, subnets: [b], attach: [{device: d}]}
  - {name: NC, subnets: [c], attach: [{device: o}]}
`

// отдельный документ подсетей: e2eSubnets не содержит a/b/c
const filteredChainSubnets = `
subnets:
  - {name: a, cidr: 10.0.10.0/24}
  - {name: b, cidr: 10.0.11.0/24}
  - {name: c, cidr: 10.0.12.0/24}
`

func TestCompile_FilteredLinkBlocksUnannouncedPair(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: blocked, src: [NA], dst: [NC], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(filteredChainTopology),
		SubnetsYAML:  []byte(filteredChainSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("unannounced pair must place no rules, got devices: %v", names(out))
	}
}

func TestCompile_FilteredLinkKeepsAnnouncedPair(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: allowed, src: [NB], dst: [NC], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(filteredChainTopology),
		SubnetsYAML:  []byte(filteredChainSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	got := names(out)
	want := []string{"d", "o"}
	if !slices.Equal(got, want) {
		t.Fatalf("announced pair places on %v, want %v", got, want)
	}
}

func names(out []DeviceRuleset) []string {
	var s []string
	for _, d := range out {
		s = append(s, d.Name)
	}
	return s
}
```

Добавить импорт `"slices"` в файл, если его нет.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `go test ./internal/app/ -run 'TestCompile_Filtered' -v`
Expected: `TestCompile_FilteredLinkBlocksUnannouncedPair` FAIL — сейчас путь находится и правила ставятся (фильтр ещё не влияет на DFS).

- [ ] **Step 3: Реализация**

В `internal/graph/pathfind.go`, в цикле DFS функции `AllSimplePaths`, после проверки `visited[e.To]` добавить:

```go
			if e.Allow != nil && (!e.Allow.From[src.Name] || !e.Allow.To[dst.Name]) {
				continue
			}
```

С комментарием-инвариантом над строкой:

```go
			// A filtered edge carries only announced traffic.
```

- [ ] **Step 4: Убедиться, что всё проходит**

Run: `go test ./... && go vet ./... && gofmt -l .`
Expected: PASS полностью, gofmt пустой.

- [ ] **Step 5: Коммит**

```bash
git add internal/graph/pathfind.go internal/app/compile_test.go
git commit -m "feat(graph): AllSimplePaths respects filtered-link allowances; e2e placement test"
```

---

### Task 5: HTTP API — LinkFilterDoc в топологии

**Files:**
- Modify: `internal/httpapi/dto.go`
- Test: `internal/httpapi/handlers_test.go`

**Interfaces:**
- Consumes: `topology.LinkFilter` (через переиспользование Doc-типов как wire-формата).
- Produces: `LinkDoc.Filter *LinkFilterDoc` c JSON-полями `aExports`/`bExports` и YAML-ключами `a-exports`/`b-exports`. Task 6 (UI) пишет ровно эти JSON-поля.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `internal/httpapi/handlers_test.go` (хелперы `newTestServer`, `doJSON`, `errorBody` уже есть в файле; `json`, `http`, `strings` импортированы — добавьте только `"slices"`):

```go
func TestPutTopology_LinkFilterRoundTrip(t *testing.T) {
	h, store := newTestServer(t)

	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"n-office"}, BExports: []string{"n-dmz"}},
		}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", doc); rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec := doJSON(t, h, http.MethodGet, "/api/topology", nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	if got.Links[0].Filter == nil ||
		!slices.Equal(got.Links[0].Filter.AExports, []string{"n-office"}) ||
		!slices.Equal(got.Links[0].Filter.BExports, []string{"n-dmz"}) {
		t.Fatalf("filter did not survive round-trip: %+v", got.Links[0])
	}

	stored, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read stored topology: %v", err)
	}
	if !strings.Contains(string(stored), "a-exports") {
		t.Fatalf("stored yaml missing a-exports:\n%s", stored)
	}
}

func TestPutTopology_RejectsFilteredLinkWithSwitch(t *testing.T) {
	h, _ := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "sw", Kind: "switch"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "sw"},
			Filter: &LinkFilterDoc{AExports: []string{"n1"}, BExports: []string{"n2"}},
		}},
	}
	res := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "two routers") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestPutTopology_RejectsUnknownExport(t *testing.T) {
	h, _ := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"ghost"}, BExports: []string{"n2"}},
		}},
	}
	res := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "unknown export entity") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}
```


- [ ] **Step 2: Убедиться, что тесты падают**

Run: `go test ./internal/httpapi/ -run 'TestPutTopology_(LinkFilterRoundTrip|RejectsFiltered|RejectsUnknownExport)' -v`
Expected: FAIL — компиляция (`LinkFilterDoc` нет).

- [ ] **Step 3: Реализация**

В `internal/httpapi/dto.go` заменить `LinkDoc` и добавить `LinkFilterDoc`:

```go
// LinkFilterDoc mirrors topology.LinkFilter on the wire. Export lists
// always serialize (no omitempty): an empty list means "announces
// nothing" and must survive round-trips.
type LinkFilterDoc struct {
	AExports []string `json:"aExports" yaml:"a-exports"`
	BExports []string `json:"bExports" yaml:"b-exports"`
}

// LinkDoc is a logical connection between two devices.
type LinkDoc struct {
	A      EndpointDoc    `json:"a" yaml:"a"`
	B      EndpointDoc    `json:"b" yaml:"b"`
	Filter *LinkFilterDoc `json:"filter,omitempty" yaml:"filter,omitempty"`
}
```

Кода маппинга не нужно: `TopologyDoc` сериализуется в YAML напрямую (см. комментарий к Doc-типам в dto.go), а `putTopology` валидирует сохранённый документ через `topology.Load`+`Validate`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `go test ./internal/httpapi/ -v && go vet ./internal/httpapi/ && gofmt -l internal/httpapi/`
Expected: PASS (весь пакет).

- [ ] **Step 5: Коммит**

```bash
git add internal/httpapi/dto.go internal/httpapi/handlers_test.go
git commit -m "feat(httpapi): expose link filters through the topology API"
```

---

### Task 6: Страница «Связи»

**Files:**
- Create: `internal/httpapi/web/links.html`
- Create: `internal/httpapi/web/links.js`
- Create: `internal/httpapi/web/links_page.test.js`
- Modify: `internal/httpapi/server.go` (маршрут страницы, ~строка 39)
- Modify: `internal/httpapi/web/common.js` (NAV_ITEMS, ~строка 196-202)

**Interfaces:**
- Consumes: `GET/PUT /api/topology` с `filter:{aExports,bExports}` из Task 5; общие хелперы common.js: `Api.get/Api.put`, `showBanner(msg, kind)`.
- Produces: страница `/ui/links`; пункт навигации `id: "links"`.

- [ ] **Step 1: Маршрут и навигация**

`internal/httpapi/server.go` — рядом с остальными `servePage` добавить:

```go
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
```

`internal/httpapi/web/common.js` — в NAV_ITEMS между «Объединения» и «Правила» вставить:

```js
  { id: "links", href: "/ui/links", label: "Связи" },
```

- [ ] **Step 2: Написать падающие тесты**

Создать `internal/httpapi/web/links_page.test.js` по образцу `unions_page.test.js` (тот же boot-паттерн: vm-песочница, stub fetch, `alpine:init`):

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  const topoFixture = {
    devices: [{ name: "m", kind: "router" }, { name: "d", kind: "router" }, { name: "o", kind: "router" }],
    links: [
      { a: { device: "m" }, b: { device: "d" } },
      { a: { device: "m" }, b: { device: "o" }, filter: { aExports: ["NA"], bExports: ["NC"] } },
    ],
    networks: [{ name: "NA", subnets: ["a"], attach: [{ device: "m" }] }, { name: "NC", subnets: ["c"], attach: [{ device: "o" }] }],
    sets: [],
    unions: [],
  };
  const sandbox = {
    document: { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) },
    window: { dispatchEvent: notify },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent: notify,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (path_, opts) => {
      calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path_ === "/api/topology") {
        return { ok: true, status: 200, json: async () => calls.find((c) => c.method === "PUT")?.body || topoFixture };
      }
      if (path_ === "/api/subnets") {
        return { ok: true, status: 200, json: async () => ({ subnets: [{ name: "a", cidr: "10.0.0.0/24" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Alpine: { data: (name, factory) => (factories[name] = factory) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "links.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.linksPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }), showModal: () => calls.push({ path: "dialog.showModal" }) } };
  return { page, calls, banners };
}

async function bootLoadedPage() {
  const ctx = bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads links with mode flags", async () => {
  const { page } = await bootLoadedPage();
  assert.equal(page.links.length, 2);
  assert.equal(page.links[0].filter, undefined, "plain link stays plain");
  assert.deepEqual(page.links[1].filter, { aExports: ["NA"], bExports: ["NC"] });
  assert.equal(page.loaded, true);
});

test("entityGroups lists networks then subnets", async () => {
  const { page } = await bootLoadedPage();
  assert.deepEqual(page.entityGroups(), [
    { label: "Сети", names: ["NA", "NC"] },
    { label: "Подсети", names: ["a"] },
  ]);
});

test("openEdit copies current exports into the draft", async () => {
  const { page, calls } = await bootLoadedPage();
  page.openEdit(1);
  assert.deepEqual(page.draft, { index: 1, aExports: ["NA"], bExports: ["NC"] });
  page.openEdit(0);
  assert.deepEqual(page.draft, { index: 0, aExports: [], bExports: [] });
});

test("saveDraft writes edited exports preserving the rest verbatim", async () => {
  const { page, calls } = await bootLoadedPage();
  page.openEdit(0);
  page.draft.aExports = ["NA"];
  page.draft.bExports = [];

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/topology" && c.method === "PUT");
  assert.deepEqual(put.body.links[0], { a: { device: "m" }, b: { device: "d" }, filter: { aExports: ["NA"], bExports: [] } });
  // untouched filtered link preserved as-is
  assert.deepEqual(put.body.links[1], { a: { device: "m" }, b: { device: "o" }, filter: { aExports: ["NA"], bExports: ["NC"] } });
  assert.deepEqual(put.body.networks, topoNetworks());
  function topoNetworks() {
    return [{ name: "NA", subnets: ["a"], attach: [{ device: "m" }] }, { name: "NC", subnets: ["c"], attach: [{ device: "o" }] }];
  }
});

test("makeFiltered adds an empty filter and keeps other sections", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.makeFiltered(0);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.links[0].filter, { aExports: [], bExports: [] });
  assert.ok(calls.some((c) => c.path === "dialog.close") === false, "no dialog involved");
});

test("makePlain removes the filter key entirely", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.makePlain(1);

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(!("filter" in put.body.links[1]), "filter key dropped");
  assert.deepEqual(put.body.devices.length, 3);
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `node --test 'internal/httpapi/web/links_page.test.js'`
Expected: FAIL — `links.js` не существует.

- [ ] **Step 4: Создать links.js**

```js
"use strict";

// Links page: table over topology.yaml links. A regular link can convert
// to a filtered one (per-side export lists of networks/subnets) and back.
// The canvas creates plain links only; conversion lives here. The server
// re-validates authoritatively on save.

document.addEventListener("alpine:init", () => {
  Alpine.data("linksPage", () => ({
    links: [], // {a:{device}, b:{device}, filter?:{aExports:[], bExports:[]}}
    networks: [],
    subnets: [],
    loaded: false,
    saving: false,
    draft: { index: -1, aExports: [], bExports: [] },

    async init() {
      try {
        const [topo, subs] = await Promise.all([Api.get("/api/topology"), Api.get("/api/subnets")]);
        this._topo = topo;
        this.subnets = subs.subnets || [];
        this.networks = topo.networks || [];
        this.links = (topo.links || []).map((l) => ({
          a: { device: l.a.device },
          b: { device: l.b.device },
          ...(l.filter ? { filter: { aExports: [...(l.filter.aExports || [])], bExports: [...(l.filter.bExports || [])] } } : {}),
        }));
        this.loaded = true;
      } catch (e) {
        showBanner("Не удалось загрузить связи: " + e.message);
      }
    },

    entityGroups() {
      return [
        { label: "Сети", names: this.networks.map((n) => n.name) },
        { label: "Подсети", names: this.subnets.map((s) => s.name) },
      ];
    },

    pairLabel(i) {
      const l = this.links[i];
      return l ? `${l.a.device} – ${l.b.device}` : "";
    },

    openEdit(i) {
      const f = this.links[i].filter;
      this.draft = { index: i, aExports: f ? [...f.aExports] : [], bExports: f ? [...f.bExports] : [] };
      this.$refs.dialog.showModal();
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    async saveDraft() {
      if (this.saving || this.draft.index < 0) return;
      const next = this.links.slice();
      next[this.draft.index] = { ...next[this.draft.index], filter: { aExports: [...this.draft.aExports], bExports: [...this.draft.bExports] } };
      this.saving = true;
      try {
        await this.persist(next);
        this.closeModal();
      } finally {
        this.saving = false;
      }
    },

    async makeFiltered(i) {
      const next = this.links.slice();
      next[i] = { ...next[i], filter: { aExports: [], bExports: [] } };
      await this.persist(next);
    },

    async makePlain(i) {
      const next = this.links.map((l, j) => {
        if (j !== i) return l;
        const { filter, ...rest } = l;
        return rest;
      });
      await this.persist(next);
    },

    async persist(next) {
      try {
        const doc = await Api.put("/api/topology", {
          devices: this._topo.devices || [],
          links: next.map((l) => ({
            a: { device: l.a.device },
            b: { device: l.b.device },
            ...(l.filter ? { filter: { aExports: [...l.filter.aExports], bExports: [...l.filter.bExports] } } : {}),
          })),
          networks: this._topo.networks || [],
          sets: this._topo.sets || [],
          unions: this._topo.unions || [],
        });
        this._topo = doc;
        this.links = (doc.links || []).map((l) => ({
          a: { device: l.a.device },
          b: { device: l.b.device },
          ...(l.filter ? { filter: { aExports: [...(l.filter.aExports || [])], bExports: [...(l.filter.bExports || [])] } } : {}),
        }));
        showBanner("Связи сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
  }));
});
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `node --test 'internal/httpapi/web/links_page.test.js'`
Expected: PASS.

- [ ] **Step 6: Создать links.html**

По образцу `unions.html` (шапка, тема, алпайн, скрипты):

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>firenet — связи</title>
<script>
  try {
    var saved = localStorage.getItem("firenet-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="links" x-data="appData()" @notify.window="showBanner($event.detail.message, $event.detail.kind)">
<div id="site-header"></div>

<main x-data="linksPage">
  <div class="table-toolbar">
    <div class="toolbar-text">
      <h3>Связи</h3>
      <p class="hint">Обычная связь даёт полную связность между устройствами. Фильтрованная связь пропускает только трафик между объявленными сетями: каждая сторона перечисляет, что она «анонсирует» через связь. Создание связей — на холсте топологии инструментом «связать».</p>
    </div>
  </div>
  <div class="table-wrap" x-show="loaded" x-cloak>
    <table class="data-table">
      <thead>
        <tr><th>Устройства</th><th>Режим</th><th>Экспорт стороны A</th><th>Экспорт стороны B</th><th></th></tr>
      </thead>
      <tbody>
        <template x-for="(l, i) in links" :key="i">
          <tr>
            <td x-text="pairLabel(i)"></td>
            <td>
              <span class="owner-badge" x-show="l.filter">фильтрованная</span>
              <span class="hint" x-show="!l.filter">обычная</span>
            </td>
            <td>
              <template x-for="e in (l.filter?.aExports || [])" :key="e"><span class="owner-badge" x-text="e"></span></template>
              <span class="hint" x-show="l.filter && !(l.filter.aExports || []).length">ничего</span>
              <span class="hint" x-show="!l.filter">—</span>
            </td>
            <td>
              <template x-for="e in (l.filter?.bExports || [])" :key="e"><span class="owner-badge" x-text="e"></span></template>
              <span class="hint" x-show="l.filter && !(l.filter.bExports || []).length">ничего</span>
              <span class="hint" x-show="!l.filter">—</span>
            </td>
            <td>
              <button type="button" class="icon-btn edit" x-show="l.filter" title="Изменить фильтры" @click="openEdit(i)">✎</button>
              <button type="button" class="secondary btn-sm" x-show="!l.filter" @click="makeFiltered(i)">Сделать фильтрованной</button>
              <button type="button" class="secondary btn-sm" x-show="l.filter" @click="makePlain(i)">Вернуть обычную</button>
            </td>
          </tr>
        </template>
        <tr x-show="loaded && !links.length"><td colspan="5" class="empty-cell">Связей нет — создайте их на холсте топологии</td></tr>
      </tbody>
    </table>
  </div>

  <dialog x-ref="dialog" class="modal">
    <h3>Фильтры связи <span x-text="draft.index >= 0 ? pairLabel(draft.index) : ''"></span></h3>
    <p class="cell-hint">Трафик между сетью X и сетью Y пройдёт через связь, только если X выбран в экспорте стороны, откуда пакет выходит, а Y — в экспорте стороны, куда он входит.</p>
    <fieldset>
      <legend>Сторона A (<span x-text="draft.index >= 0 ? links[draft.index]?.a.device : ''"></span>)</legend>
      <template x-for="g in entityGroups()" :key="'a-' + g.label">
        <div>
          <p class="cell-hint" x-text="g.label"></p>
          <template x-for="name in g.names" :key="'a-' + name">
            <label class="check-row"><input type="checkbox" :value="name" x-model="draft.aExports"> <span x-text="name"></span></label>
          </template>
        </div>
      </template>
    </fieldset>
    <fieldset>
      <legend>Сторона B (<span x-text="draft.index >= 0 ? links[draft.index]?.b.device : ''"></span>)</legend>
      <template x-for="g in entityGroups()" :key="'b-' + g.label">
        <div>
          <p class="cell-hint" x-text="g.label"></p>
          <template x-for="name in g.names" :key="'b-' + name">
            <label class="check-row"><input type="checkbox" :value="name" x-model="draft.bExports"> <span x-text="name"></span></label>
          </template>
        </div>
      </template>
    </fieldset>
    <div class="modal-actions">
      <button type="button" @click="closeModal()">Отмена</button>
      <button type="button" class="primary" :disabled="saving" @click="saveDraft()">Сохранить</button>
    </div>
  </dialog>
</main>

<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
<script src="/links.js"></script>
</body>
</html>
```

Если у `body[data-nav=...]` есть проверка активного пункта меню — убедитесь, что `"links"` совпадает с id в NAV_ITEMS. CSS-класс `.check-row` при отсутствии добавить в style.css:

```css
.check-row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
```

- [ ] **Step 7: Полная проверка web-тестов и сборки**

Run: `node --test 'internal/httpapi/web/*.test.js' && go build ./... && go test ./internal/httpapi/`
Expected: PASS везде.

- [ ] **Step 8: Коммит**

```bash
git add internal/httpapi/web/links.html internal/httpapi/web/links.js internal/httpapi/web/links_page.test.js internal/httpapi/web/common.js internal/httpapi/web/style.css internal/httpapi/server.go
git commit -m "feat(ui): links page with filtered-link conversion and export editors"
```

---

### Task 7: Выделение фильтрованных связей на холсте

**Files:**
- Modify: `internal/httpapi/web/topology.js` (рендер проводов, ~строки 609-625)
- Modify: `internal/httpapi/web/style.css` (~строка 348)
- Test: `internal/httpapi/web/topology_render.test.js`

**Interfaces:**
- Consumes: `link.filter` в состоянии `State.topology.links` (формат Task 5).
- Produces: класс `wire-filtered` у провода фильтрованной связи + `<title>` с экспортами.

- [ ] **Step 1: Написать падающий тест**

Добавить в `internal/httpapi/web/topology_render.test.js`:

```js
test("filtered links render with wire-filtered class and exports tooltip", async () => {
  const topo = {
    devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
    links: [
      { a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["N1"], bExports: ["N2"] } },
    ],
    networks: [],
  };
  const { canvas } = bootTopology({ ...responses, "/api/topology": topo });
  await tick();
  const filtered = withClass(canvas, "wire-filtered");
  assert.equal(filtered.length, 1, "one filtered wire");
  const titles = [];
  (function walk(n) {
    if (n.tag === "title") titles.push(String(n.textContent));
    (n.children || []).forEach(walk);
  })(canvas);
  assert.ok(titles.some((t) => t.includes("N1") && t.includes("N2")), "tooltip lists exports");
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test 'internal/httpapi/web/topology_render.test.js'`
Expected: FAIL — класса нет.

- [ ] **Step 3: Реализация**

`internal/httpapi/web/topology.js` — в блоке рендера device-to-device links (~612) изменить создание провода:

```js
      const wire = el("path", {
        class: "wire" + (l.filter ? " wire-filtered" : "") + (State.selection.has(l) ? " selected" : ""), d, fill: "none",
      });
      viewportG.append(wire);
      if (l.filter) {
        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        const side = (xs) => (xs || []).join(", ") || "ничего";
        t.textContent = `${side(l.filter.aExports)} → ${side(l.filter.bExports)}`;
        wire.append(t);
      }
```

И подпись hit-зоны:

```js
      selectWire(hit, l, (l.filter ? "фильтрованная связь " : "связь ") + l.a.device + "–" + l.b.device);
```

`internal/httpapi/web/style.css` — рядом с `.wire.selected` (:349) добавить:

```css
.wire-filtered { stroke: #d29922; stroke-dasharray: 6 4; }
.wire-filtered.selected { stroke-dasharray: 6 4; }
```

(Пунктир жёлтого оттенка визуально отличим от сплошной серой обычной линии и синего выделения.)

- [ ] **Step 4: Убедиться, что все тесты проходят**

Run: `node --test 'internal/httpapi/web/*.test.js' && go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: PASS везде, gofmt пустой.

- [ ] **Step 5: Пересобрать бинарник (go:embed)**

Run: `make build`
Expected: сборка успешна.

- [ ] **Step 6: Коммит**

```bash
git add internal/httpapi/web/topology.js internal/httpapi/web/style.css internal/httpapi/web/topology_render.test.js
git commit -m "feat(ui): render filtered links dashed with exports tooltip on canvas"
```
