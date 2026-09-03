# Удаление YAML: реализация

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** полностью убрать YAML из firenet — данные только в PostgreSQL, ProjectDoc напрямую конвертируется в доменные модели. CLI удаляется целиком (все функции в Web): бинарь превращается в сервер, адрес — через `FIRENET_ADDR`.

**Architecture:** конвертеры в `projectdoc` (по образцу `ToPolicy`) заменяют YAML-парсеры `topology.Load`/`rules.Load`; сигнатуры `app.*` принимают `ProjectDoc` вместо YAML-байт; `internal/cli` удаляется — `cmd/firenet/main.go` сам подключается к БД, сеет пустой проект на пустой БД и запускает `httpapi.NewServer`; legacy-импорт удаляется.

**Tech Stack:** Go, pgx/pgxpool; без нового — уходят `gopkg.in/yaml.v3` и `github.com/spf13/cobra`.

**Spec:** `docs/superpowers/specs/2026-09-03-remove-yaml-design.md`

## Global Constraints

- Валидация после каждой задачи: `go build ./... && go vet ./... && gofmt -l . && go test ./...` (в конце — плюс `node --test 'internal/httpapi/web/*.test.js'` и `make test-e2e`).
- Коммит после каждой задачи; стиль сообщений — `refactor:`, `feat:`, `test:` как в истории (`git log --oneline`).
- Поведение (дефолты правил, тексты ошибок валидации) не меняется — только источник данных и путь конвертации.
- Комментарии в коде — по-английски, в существующем стиле; UI-строки не трогаем.
- В `internal/` не появляется новых пакетов (кроме удаления старых файлов).

---

### Task 1: Дефолты правил в ToPolicy/ToRules

**Files:**
- Modify: `internal/projectdoc/rules.go` (функции `ToPolicy`, `NewPolicyDoc`)
- Modify: `internal/projectdoc/convert.go` (функция `ToRules`)
- Test: `internal/projectdoc/convert_test.go`

**Interfaces:**
- Consumes: существующие `PolicyDoc.ToPolicy() rules.Policy`, `NewPolicyDoc(pol *rules.Policy) PolicyDoc`, `ProjectDoc.ToRules() *rules.Policy` (уже в convert.go).
- Produces: `ToPolicy`/`NewPolicyDoc` с теми же сигнатурами, но подставляющие дефолты: `DefaultAction` пуст → `deny`; `ChainPosition` пуст → `top` только для первой цепочки; `Name` первой цепочки пуст → `FIRENET-FWD`; `Rule.Proto` пуст → `any`. Позже (Task 3) `rules.Load` удаляется, и это становится единственным путём подстановки дефолтов.

- [x] **Step 1: Write the failing test**

В `internal/projectdoc/convert_test.go` добавить:

```go
func TestToRules_Defaults(t *testing.T) {
	doc := ProjectDoc{Rules: PolicyDoc{Chains: []ChainDoc{
		{Rules: []RuleDoc{{Name: "r1", Src: []string{"a"}, Dst: []string{"b"}, Action: "allow"}}},
		{Name: "EXTRA", DefaultAction: "allow", Rules: []RuleDoc{}},
	}}}
	pol := doc.ToRules()
	first := pol.Chains[0]
	if first.Name != "FIRENET-FWD" || first.DefaultAction != rules.ActionDeny || first.ChainPosition != rules.ChainTop {
		t.Fatalf("first chain defaults: %+v", first)
	}
	if first.Rules[0].Proto != rules.ProtoAny {
		t.Fatalf("rule proto default: %+v", first.Rules[0])
	}
	second := pol.Chains[1]
	if second.ChainPosition != "" {
		t.Fatalf("chainPosition must default only on the first chain: %+v", second)
	}
	// round-trip: doc -> policy -> doc keeps the resolved defaults
	back := NewPolicyDoc(pol)
	if back.Chains[0].Name != "FIRENET-FWD" || back.Chains[0].DefaultAction != "deny" {
		t.Fatalf("round-trip lost defaults: %+v", back.Chains[0])
	}
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `go test ./internal/projectdoc/ -run TestToRules_Defaults -v`
Expected: FAIL (дефолты не подставляются — поля пустые).

- [x] **Step 3: Write minimal implementation**

В `internal/projectdoc/rules.go` заменить тело `ToPolicy` (добавить дефолты; `i == 0` — первая цепочка):

```go
func (d PolicyDoc) ToPolicy() rules.Policy {
	pol := rules.Policy{}
	for i, c := range d.Chains {
		ch := rules.Chain{
			Name:          c.Name,
			DefaultAction: rules.Action(c.DefaultAction),
			ChainPosition: rules.ChainPosition(c.ChainPosition),
		}
		if ch.DefaultAction == "" {
			ch.DefaultAction = rules.ActionDeny
		}
		if i == 0 {
			if ch.Name == "" {
				ch.Name = rules.DefaultChainName
			}
			if ch.ChainPosition == "" {
				ch.ChainPosition = rules.ChainTop
			}
		}
		for _, r := range c.Rules {
			proto := rules.Proto(r.Proto)
			if proto == "" {
				proto = rules.ProtoAny
			}
			ch.Rules = append(ch.Rules, rules.Rule{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: rules.Action(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		pol.Chains = append(pol.Chains, ch)
	}
	return pol
}
```

В `NewPolicyDoc` после `ch := ChainDoc{...}` добавить тот же дефолт defaultAction/имени/позиции первой цепочки, что и в `ToPolicy` (скопировать три `if`-блока выше, работая со `ch`).

- [x] **Step 4: Run test to verify it passes**

Run: `go test ./internal/projectdoc/ -v`
Expected: PASS (все).

- [x] **Step 5: Commit**

```bash
git add internal/projectdoc/rules.go internal/projectdoc/convert_test.go
git commit -m "feat: policy wire-doc defaults in ToPolicy/ToRules"
```

---

### Task 2: ToTopology/ToSubnets/ToRules уже готовы — регресс-тест на равенство с Load

**Files:**
- Test: `internal/projectdoc/convert_test.go`

**Interfaces:**
- Consumes: `TopologyDoc.ToTopology`, `SubnetsDoc.ToSubnets`, `ProjectDoc.ToRules` (существуют), `topology.Load`/`rules.Load` (пока существуют).
- Produces: тест-фиксатор, доказывающий конвертеры дают тот же результат, что YAML-парсеры. После Task 3 (`Load` удалён) тест упрощается: убрать `yaml`-часть и сравнивать с ожидаемыми структурами напрямую.

**Примечание:** `ToTopology`/`ToSubnets` уже реализованы и зелёные (`internal/projectdoc/convert.go`, `convert_test.go`). Задача только фиксирует эквивалентность, чтобы последующее удаление `Load` было безопасным.

- [x] **Step 1: Write the failing test**

```go
func TestConverters_MatchYAMLLoad(t *testing.T) {
	topoYAML := `
devices:
  - {name: r1, kind: router}
  - {name: s1, kind: switch}
links:
  - a: {device: r1}
    b: {device: s1}
networks:
  - name: office
    subnets: [lan]
    attach: [{device: s1}]
sets:
  - name: hosts
    subnets: [lan]
    addresses: ["10.0.0.5"]
unions:
  - name: hq
    devices: [r1]
`
	subnetsYAML := `
subnets:
  - {name: lan, cidr: 10.0.0.0/24}
`
	var tdoc TopologyDoc
	if err := yaml.Unmarshal([]byte(topoYAML), &tdoc); err != nil {
		t.Fatal(err)
	}
	var sdoc SubnetsDoc
	if err := yaml.Unmarshal([]byte(subnetsYAML), &sdoc); err != nil {
		t.Fatal(err)
	}

	viaYAML, err := topology.Load(strings.NewReader(topoYAML))
	if err != nil {
		t.Fatal(err)
	}
	subViaYAML, err := topology.LoadSubnets(strings.NewReader(subnetsYAML))
	if err != nil {
		t.Fatal(err)
	}
	viaYAML.Subnets = subViaYAML

	viaDoc, err := tdoc.ToTopology()
	if err != nil {
		t.Fatal(err)
	}
	subViaDoc, err := sdoc.ToSubnets()
	if err != nil {
		t.Fatal(err)
	}
	viaDoc.Subnets = subViaDoc

	if !reflect.DeepEqual(viaYAML, viaDoc) {
		t.Fatalf("converter mismatch:\nviaYAML=%+v\nviaDoc=%+v", viaYAML, viaDoc)
	}
}
```

(Импорты добавить: `reflect`, `strings`, `gopkg.in/yaml.v3`, `github.com/kudes1/firenet/internal/topology`.)

- [x] **Step 2: Run test to verify it fails or passes**

Run: `go test ./internal/projectdoc/ -run TestConverters_MatchYAMLLoad -v`
Expected: PASS — конвертеры уже эквивалентны (тест-фиксатор). Если FAIL — чинить конвертер, а не тест.

- [x] **Step 3: Commit**

```bash
git add internal/projectdoc/convert_test.go
git commit -m "test: converters match legacy YAML parsers"
```

---

### Task 3: app-слой на ProjectDoc; удаление YAML-парсеров topology

**Files:**
- Modify: `internal/app/load.go`
- Modify: `internal/app/compile.go` (`CompileOptions`, `Compile`)
- Modify: `internal/app/diagnose.go` (`DiagnoseOptions`, `SpreadOptions`, `Diagnose`, `Spread`)
- Modify: `internal/app/load_test.go`, `compile_test.go`, `diagnose_test.go`, `lint_test.go`, `deps_test.go`
- Delete: `internal/topology/load.go`, `internal/topology/load_test.go`

**Interfaces:**
- Consumes: `TopologyDoc.ToTopology`, `SubnetsDoc.ToSubnets`, `ProjectDoc.ToRules` (Task 1–2), `projectdoc.ProjectDoc`.
- Produces (для Tasks 4–6):
  - `app.LoadProject(doc projectdoc.ProjectDoc) (*topology.Topology, error)`
  - `app.ParseProject(doc projectdoc.ProjectDoc) (*topology.Topology, error)`
  - `app.CompileOptions{Doc projectdoc.ProjectDoc; MaxHops, MaxPaths int}`
  - `app.DiagnoseOptions{Doc projectdoc.ProjectDoc; MaxHops, MaxPaths int; Flow diagnose.Flow}`
  - `app.SpreadOptions{Doc projectdoc.ProjectDoc; MaxHops, MaxPaths int; Input string; Proto rules.Proto; DstPorts []string}`

**Важно про порядок конвертации:** старый `ParseProject` делал `Load` (топология) → `LoadSubnets` → `topo.Subnets = subnets`. Новый:

```go
func ParseProject(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topo, err := doc.Topology.ToTopology()
	if err != nil {
		return nil, fmt.Errorf("load topology: %w", err)
	}
	subnets, err := doc.Subnets.ToSubnets()
	if err != nil {
		return nil, fmt.Errorf("load subnets: %w", err)
	}
	topo.Subnets = subnets
	return topo, nil
}

func LoadProject(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topo, err := ParseProject(doc)
	if err != nil {
		return nil, err
	}
	if err := topo.Validate(); err != nil {
		return nil, fmt.Errorf("invalid project: %w", err)
	}
	if err := graph.ValidateFilterExports(topo); err != nil {
		return nil, fmt.Errorf("invalid project: %w", err)
	}
	return topo, nil
}
```

В `Compile`:

```go
topo, err := LoadProject(opts.Doc)
if err != nil {
	return nil, err
}
pol := opts.Doc.ToRules()
if err := pol.Validate(topo); err != nil {
	return nil, fmt.Errorf("invalid rules: %w", err)
}
```

(Остальное тело `Compile`/`Diagnose`/`Spread` без изменений; `bytes`-импорт убрать, если остался.)

- [x] **Step 1: Write the failing test**

Переписать `internal/app/load_test.go`:

```go
package app

import (
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func filterChainDoc(t *testing.T) projectdoc.ProjectDoc {
	t.Helper()
	var doc projectdoc.ProjectDoc
	doc.Topology.Devices = []projectdoc.DeviceDoc{
		{Name: "m", Kind: "router"}, {Name: "o", Kind: "router"}, {Name: "c", Kind: "router"},
	}
	doc.Topology.Networks = []projectdoc.NetworkDoc{
		{Name: "NA", Subnets: []string{"sa"}, Attach: []projectdoc.EndpointDoc{{Device: "m"}}},
		{Name: "NB", Subnets: []string{"sb"}, Attach: []projectdoc.EndpointDoc{{Device: "o"}}},
		{Name: "NC", Subnets: []string{"sc"}, Attach: []projectdoc.EndpointDoc{{Device: "c"}}},
	}
	doc.Topology.Links = []projectdoc.LinkDoc{
		{A: projectdoc.EndpointDoc{Device: "m"}, B: projectdoc.EndpointDoc{Device: "o"},
			Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NA"}, BExports: []string{"NB"}}},
		{A: projectdoc.EndpointDoc{Device: "o"}, B: projectdoc.EndpointDoc{Device: "c"},
			Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NB"}, BExports: []string{"NC"}}},
	}
	doc.Subnets.Subnets = []projectdoc.SubnetDoc{
		{Name: "sa", CIDR: "10.0.0.0/24"}, {Name: "sb", CIDR: "10.0.1.0/24"}, {Name: "sc", CIDR: "10.0.2.0/24"},
	}
	return doc
}

func TestLoadProject_FilteredLinkReachableExports(t *testing.T) {
	topo, err := LoadProject(filterChainDoc(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Links) != 2 {
		t.Fatalf("unexpected project: %+v", topo)
	}
}

func TestLoadProject_UnreachableFilterExport(t *testing.T) {
	bad := filterChainDoc(t)
	bad.Topology.Links[0].Filter.AExports = []string{"NA", "NC"}
	_, err := LoadProject(bad)
	if err == nil || !strings.Contains(err.Error(), `export "NC" is not reachable`) {
		t.Fatalf("expected unreachable-export error, got: %v", err)
	}
}
```

(Тест считывает смысл старого фикстурного `filteredChainTopology`; имена/подсети как в удалённом YAML-варианте.)

- [x] **Step 2: Run test to verify it fails**

Run: `go build ./internal/app/ 2>&1 | head -5`
Expected: ошибка компиляции — `LoadProject` ещё принимает `[]byte`.

- [x] **Step 3: Implement**

Реализовать `ParseProject`/`LoadProject` как выше; обновить `CompileOptions`/`DiagnoseOptions`/`SpreadOptions` (три YAML-поля → `Doc projectdoc.ProjectDoc`) и три вызова внутри `compile.go`/`diagnose.go`.

- [x] **Step 4: Fix all app tests**

В `internal/app/compile_test.go`, `diagnose_test.go`, `lint_test.go`, `deps_test.go` заменить YAML-константы на конструирование `projectdoc.ProjectDoc` (поле `Doc:` вместо `TopologyYAML:/SubnetsYAML:/RulesYAML:`). Пример хелпера — `filterChainDoc` из Step 1; для фикстур типа `e2eTopology` собрать аналогичные `projectdoc`-структуры. Правила собирать через `PolicyDoc{Chains: ...}` (flat-формы больше нет).

- [x] **Step 5: Delete YAML parsers of topology**

```bash
rm internal/topology/load.go internal/topology/load_test.go
```

Проверить: `grep -rn "topology.Load" internal/ --include="*.go"` — пусто.

- [x] **Step 6: Run tests**

Run: `go build ./... && go test ./internal/app/ ./internal/topology/ -count=1`
Expected: PASS (`internal/app` может падать только из-за `rules.Load`-вызовов в тестах — они чинятся в Step 4; `rules.Load` как пакет остаётся до Task 4).

- [x] **Step 7: Commit**

```bash
git add -A internal/app internal/topology
git commit -m "refactor: app layer takes ProjectDoc; drop topology YAML parser"
```

---

### Task 4: Удаление rules.Load; перенос правил-тестов на PolicyDoc

**Files:**
- Delete: `internal/rules/load.go`
- Modify: `internal/rules/load_test.go` → переименовать в `policy_from_doc_test.go` (содержимое переписать)
- Modify: `internal/rules/validate_test.go` (места с `Load(strings.NewReader(...))`)

**Interfaces:**
- Consumes: `PolicyDoc.ToPolicy()` с дефолтами (Task 1), `NewPolicyDoc`.
- Produces: `internal/rules` без зависимости от YAML; все тесты пакета конструируют политики через `PolicyDoc`/литералы `Policy`.

- [x] **Step 1: Rewrite load_test.go**

Заменить YAML-строки на `PolicyDoc`:

```go
func modernPolicy() projectdoc.PolicyDoc {
	return projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
		Name: "FIRENET-FWD", DefaultAction: "deny", ChainPosition: "top",
		Rules: []projectdoc.RuleDoc{{Name: "r", Src: []string{"any"}, Dst: []string{"any"}, Action: "allow"}},
	}}}
}
```

Каждый тест: `pol := doc.ToPolicy()` вместо `Load(...)`. Тесты на «неизвестные поля», «битый YAML», «legacy flat формат» удалить (эти ошибки больше не могут возникнуть: doc приходит из БD с проверкой JSON-схемой сущностей). Тесты на дефолты уже в `projectdoc` (Task 1).

- [x] **Step 2: Update validate_test.go**

Места вида:

```go
pol, err := Load(strings.NewReader(tc.yaml))
```

заменить на конструирование `PolicyDoc` (в `TestValidateJumpErrors` таблица `yaml string` → таблица `doc projectdoc.PolicyDoc`; смысл кейсов тот же: jump без target, cycle и т.д.).

- [x] **Step 3: Delete rules/load.go**

```bash
rm internal/rules/load.go
grep -rn "rules.Load" internal/ --include="*.go"   # пусто (после Task 5-6; на этом шаге пока остаются вызовы в cli/httpapi — они чинятся следующими задачами)
```

**Порядок важен:** этот шаг не компилируется, пока `internal/cli` и `httpapi/handlers.go` вызывают `rules.Load`. Поэтому Task 4 выполняется вместе с Task 5 и 6 до первого коммита-верификации. Рабочий порядок: сделать Step 1–2, затем сразу Task 5 и Task 6, и только потом билд/тест/коммит всех трёх.

- [x] **Step 4: Verify**

Run: `go build ./... && go test ./internal/rules/ -count=1` (после Tasks 5–6)
Expected: PASS.

- [x] **Step 5: Commit (вместе с Task 5 и 6)**

```bash
git add -A internal/rules
git commit -m "refactor: rules package drops YAML loader"
```

---

### Task 5: httpapi без yaml.Marshal-прослойки

**Files:**
- Modify: `internal/httpapi/handlers.go` (17 мест `yaml.*`)
- Modify: `internal/httpapi/handlers_test.go` (фикстуры + `writeDraftRules`)
- Delete: `internal/httpapi/store.go` (`FileProjectStore`)

**Interfaces:**
- Consumes: `app.LoadProject(doc)`, `app.ParseProject(doc)`, `app.CompileOptions{Doc: ...}` и т.д. (Task 3), `doc.ToRules()` (Task 1).
- Produces: httpapi без импорта `gopkg.in/yaml.v3`.

**Конкретные правки в `handlers.go`:**

1. `deletionErrorsFromDocs` (строки ~100–134) — заменить yaml.Marshal-блоки:

```go
func deletionErrorsFromDocs(prev, next projectdoc.ProjectDoc) []string {
	prevTopo, err := app.LoadProject(prev)
	if err != nil {
		return nil
	}
	nextTopo, err := app.ParseProject(next)
	if err != nil {
		return nil
	}
	pol := next.ToRules()
	return app.DeletionErrors(prevTopo, nextTopo, pol)
}
```

Примечание: старый код допускал «broken rules → nil policy», потому что `rules.Load` мог упасть на битом YAML. `ToRules` не ошибается никогда; ссылочная валидность правил остаётся на `pol.Validate` в `validateDoc` — поведение (пустой список при пустом/битом rules не блокирует diff удалений) сохраняется, т.к. невалидные ссылки ловит `validateDoc` отдельным сообщением.

2. `loadTopologyDoc` (~136–151):

```go
func loadTopologyDoc(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topo, err := app.LoadProject(doc)
	if err != nil {
		return nil, fmt.Errorf("project is invalid: %w", err)
	}
	return topo, nil
}
```

3. `compileDoc` (~608–626): вернуть `app.Compile(ctx, h.log, app.CompileOptions{Doc: doc})`.

4. `diagnoseDoc` (~791–811): `app.Diagnose(ctx, h.log, app.DiagnoseOptions{Doc: doc, Flow: flow})`.

5. `spreadDoc` (~817–844): `app.Spread(ctx, h.log, app.SpreadOptions{Doc: doc, Input: req.Src, Proto: rules.Proto(req.Proto), DstPorts: req.DstPorts})`.

6. Убрать импорт `gopkg.in/yaml.v3` (и `bytes`, если не нужен).

**Конкретные правки в `handlers_test.go`:**

- `mustParseFixtureDoc` (~55–71): собрать `ProjectDoc` литералами:

```go
func mustParseFixtureDoc(t *testing.T) projectdoc.ProjectDoc {
	t.Helper()
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices:  []projectdoc.DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
			Links:    []projectdoc.LinkDoc{{A: projectdoc.EndpointDoc{Device: "r1"}, B: projectdoc.EndpointDoc{Device: "r2"}}},
			Networks: []projectdoc.NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []projectdoc.EndpointDoc{{Device: "r2"}}},
			},
		},
		Subnets: projectdoc.SubnetsDoc{Subnets: []projectdoc.SubnetDoc{
			{Name: "office", CIDR: "10.0.0.0/24"}, {Name: "dmz", CIDR: "10.0.1.0/24"},
		}},
		Rules: policyDocOrPanic(t, fixtureRulesYAML),
	}
}
```

`fixtureTopology`/`fixtureSubnets` удалить; `fixtureRules` можно оставить как YAML-строку только если ей удобнее задавать правила — но тогда нужен мини-парсер. Проще: собрать `PolicyDoc` литералом и удалить `fixtureRules`:

```go
Rules: projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "FIRENET-FWD", DefaultAction: "deny", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{
		Name: "office-to-dmz", Src: []string{"office"}, Dst: []string{"dmz"},
		Proto: "tcp", DstPorts: []string{"443"}, Action: "allow",
	}},
}}},
```

- `writeDraftRules` (~1380): вместо `rawYAML string` принимать `policy projectdoc.PolicyDoc` и присваивать `doc.Rules = policy`. Вызовы (~1418, ~1443) переписать литералами `PolicyDoc` (по смыслу: allow-all + shadowed; bad src `no-such-subnet`).

- Убрать импорт `gopkg.in/yaml.v3` из теста.

**`internal/httpapi/store.go`** — удалить файл целиком (`FileProjectStore` нужен только legacy-импорту, который удаляется в Task 6; оба файла уходят в общем коммите Tasks 4–6).

- [ ] **Step 1: Write the failing test** — существующие тесты httpapi и есть failing-тест: после смены сигнатур `app.*` (Task 3) пакет не компилируется.

- [ ] **Step 2: Implement** правки 1–6 выше, обновить тесты, удалить store.go.

- [ ] **Step 3: Verify (совместно с Task 6, см. ниже)**

- [ ] **Step 4: Commit**

```bash
git add -A internal/httpapi
git commit -m "refactor: httpapi passes ProjectDoc to app layer, drop FileProjectStore"
```

---

### Task 6: Удаление internal/cli; бинарь = сервер (main.go)

**Files:**
- Delete: `internal/cli/` (весь пакет: `root.go`, `serve.go`, `validate.go`, `compile.go`, `version.go`, `legacy.go`, `legacy_test.go`)
- Delete: `internal/httpapi/store.go` (вместе с Task 5)
- Modify: `cmd/firenet/main.go`
- Modify: `internal/config/config.go` (`Addr` + `FIRENET_ADDR`)
- Modify: `Dockerfile` (ENTRYPOINT)
- Modify: `go.mod`, `go.sum` (через `go mod tidy` — уходит cobra)

**Interfaces:**
- Consumes: `config.Load()`, `logger.New(cfg)`, `db.Open`, `db.Migrate`, `auth.NewStore` (`BootstrapAdmin`, `GetUserByUsername`), `pgstore.NewStore` (`SeedInitialVersion`), `httpapi.NewServer` (все существуют в `internal/cli/serve.go` — код переносится).
- Produces: `bin/firenet` без подкоманд — сразу запускает сервер.

**`internal/config/config.go`:** добавить поле и env:

```go
type Config struct {
	LogLevel      string
	LogFormat     string
	DatabaseURL   string
	AdminUsername string
	AdminPassword string
	Addr          string
}

// в Load():
Addr: getEnv("FIRENET_ADDR", "127.0.0.1:8787"),
```

**`cmd/firenet/main.go`:** тело из старого `newServeCmd.RunE` без cobra и legacy-части:

```go
// Command firenet runs the firenet web application.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/config"
	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/httpapi"
	"github.com/kudes1/firenet/internal/logger"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
)

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := logger.New(cfg)

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}

	users := auth.NewStore(pool)
	if err := users.BootstrapAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		return fmt.Errorf("bootstrap admin account: %w", err)
	}

	// actor stays zero-value when cfg.AdminUsername is unset (every
	// run after the first) — SeedInitialVersion only dereferences it
	// when it's actually about to seed, which only happens once.
	var actor auth.User
	if cfg.AdminUsername != "" {
		actor, err = users.GetUserByUsername(ctx, cfg.AdminUsername)
		if err != nil {
			return fmt.Errorf("look up admin user: %w", err)
		}
	}

	projects := pgstore.NewStore(pool)
	if _, err := projects.SeedInitialVersion(ctx, projectdoc.ProjectDoc{}, actor); err != nil {
		return fmt.Errorf("seed initial version: %w", err)
	}

	srv := httpapi.NewServer(projects, users, log)
	log.Info("serving firenet web UI", "addr", cfg.Addr)
	return http.ListenAndServe(cfg.Addr, srv)
}
```

**Проверка `app.Version()`:** после удаления `cli/version.go` запустить
`grep -rn "app.Version" --include="*.go" .` — если вызовов нет (кроме
`internal/app/app.go`), удалить `app.Version` и его тест при наличии.

**Dockerfile:** строка `ENTRYPOINT ["/firenet", "serve", "--addr", "0.0.0.0:8787"]` →
`ENTRYPOINT ["/firenet"]` и `ENV FIRENET_ADDR=0.0.0.0:8787`.

- [ ] **Step 1: Write the failing test**

Failing-тест — компиляция: после Task 4 (удалён `rules.Load`) `internal/cli` не собирается; это и есть сигнал, что Task 6 нужен. Новый код `main.go` юнит-тестами не покрывается (как и старый `serve`) — его путь покрыт e2e.

- [ ] **Step 2: Implement** — `FIRENET_ADDR` в config, новый `main.go`, удалить `internal/cli/` целиком, поправить Dockerfile.

- [ ] **Step 3: go mod tidy**

```bash
go mod tidy
grep -c "spf13/cobra\|yaml.v3" go.mod   # 0 совпадений
```

- [ ] **Step 4: Verify вместе с Task 4 и 5**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./... -count=1`
Expected: PASS. (Postgres-backed тесты пропустятся без `FIRENET_TEST_DATABASE_URL`; при наличии — прогонятся.)

- [ ] **Step 5: Commit (Tasks 4+5+6 суммарно)**

```bash
git add -A
git commit -m "refactor: drop YAML and CLI; binary runs the web server"
```

(Если хочется отдельных коммитов — закоммитить rules/httpapi/main раздельно только когда сборка зелёная на каждом шаге; иначе один.)

---

### Task 7: Удаление YAML-файлов, e2e-сетап, README, go.mod

**Files:**
- Delete: `topology.yaml`, `subnets.yaml`, `rules.yaml`, `examples/`
- Modify: `e2e/global-setup.js`
- Modify: `README.md`
- Modify: `go.mod`, `go.sum` (через `go mod tidy` — уходит yaml.v3)

**Interfaces:**
- Consumes: Task 6 (бинарь без подкоманд, `FIRENET_ADDR`).
- Produces: репозиторий без `gopkg.in/yaml.v3`.

- [ ] **Step 1: e2e/global-setup.js**

Заменить блок spawn (~66–83):

```js
    const appPort = await freePort();
    server = spawn("bin/firenet", [], {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        FIRENET_ADDR: `127.0.0.1:${appPort}`,
        FIRENET_DATABASE_URL: `postgres://${PG.user}:${PG.pass}@127.0.0.1:${pgPort}/${PG.db}?sslmode=disable`,
        FIRENET_ADMIN_USER: ADMIN.username,
        FIRENET_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: "inherit",
    });
```

(убрать `fs.mkdirSync("./.tmp/")`, хелпер `legacy`, `serve` и четыре флага). Комментарий заменить на: пустая БД → сервер сам сеет пустую версию 1.

- [ ] **Step 2: Delete YAML data files**

```bash
git rm topology.yaml subnets.yaml rules.yaml
git rm -r examples/
```

- [ ] **Step 3: go.mod**

```bash
go mod tidy
grep -c yaml go.mod   # 0 совпадений (cobra уже ушла в Task 6)
```

- [ ] **Step 4: README.md**

Раздел «При первом запуске…» (строки ~29–33) заменить на:

```markdown
При первом запуске приложение применяет миграции и создаёт пустой
проект. Дальше изменения вносятся и сохраняются через веб-интерфейс;
все данные хранятся в PostgreSQL.
```

В разделе «Конфигурация» описать `FIRENET_ADDR`; в «Структуре проекта»
убрать упоминания `internal/cli`, если остались.

- [ ] **Step 5: Full verification**

```bash
go build ./... && go vet ./... && gofmt -l . && go test ./... -count=1
node --test 'internal/httpapi/web/*.test.js'
make test-e2e
```

Expected: всё зелёное. Для e2e нужны docker и chromium (`cd e2e && npm install && npx playwright install chromium` при первом запуске).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove YAML files and dependency; e2e starts with empty project"
```

---

## Самопроверка плана

- **Покрытие спеки:** конвертеры (задачи 1–2), app-слой (3), rules-парсер (4), httpapi (5), удаление CLI + сервер-бинарь (6), файлы/доки/go.mod (7) — все разделы спеки закрыты.
- **Согласованность типов:** `Doc projectdoc.ProjectDoc` во всех опциях; `ToRules`/`ToTopology`/`ToSubnets` используются по именам из Task 1–2; `main.go` повторяет сигнатуры из старого `serve.go` (`pgstore.NewStore`, `SeedInitialVersion(ctx, ProjectDoc{}, actor)`).
- **Порядок выполнения:** Task 4→5→6 связаны (сборка зелёная только после всех трёх: `rules.Load` вызывают `internal/cli` и `httpapi`) — план явно требует их совместимой верификации и общего коммита.
- **Ручная проверка:** после Task 7 — `bin/firenet` с живым Postgres поднимает UI (бывший Task 8 с CLI-командами больше не применим).
