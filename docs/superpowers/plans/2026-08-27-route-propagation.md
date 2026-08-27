# Route Propagation Layer Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make filtered-link reachability destination-driven only (like a real route-filter/prefix-list), so routing can be asymmetric across the same pair of filtered links — matching how real routers make independent, destination-based forwarding decisions — while the firewall/rules layer stays the only place that restricts by packet source.

**Architecture:** `graph.AllSimplePaths` currently requires both `src ∈ Allow.From` and `dst ∈ Allow.To` at every filtered hop, using the flow's literal, unchanging src/dst at every hop — this makes reachability provably symmetric (proven and empirically confirmed in the design doc) and cannot express "route arrived via re-export, but no route back was ever announced." Drop the `src ∈ Allow.From` check entirely; keep only `dst ∈ Allow.To`. This is the single production-code change (`internal/graph/pathfind.go`); every other file in this plan is a test or doc update that follows from it. Verified empirically (full `go test ./...` run) to affect exactly two existing tests, both of which encoded the old (now-removed) symmetric-ACL model.

**Tech Stack:** Go 1.23, existing `internal/graph`/`internal/compiler`/`internal/diagnose` packages — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-route-propagation-design.md`

## Global Constraints

- Верификация после каждой задачи, строго в этом порядке: `go build ./...`, `go vet ./...`, `gofmt -l .` (должен печатать пусто), `go test ./...`.
- Никаких комментариев в коде, кроме тех, что уже есть в плане как часть кода.
- Компактный стиль, переиспользование существующих хелперов и фикстур (`m`/`d`/`o` naming — уже принятая в этом пакете конвенция для роутерных цепочек).
- Не трогать `internal/compiler/compiler.go` и `internal/rules/*` — они используют `AllSimplePaths`/`RoutersOnPaths` через тот же интерфейс и автоматически наследуют новое поведение без изменения кода.

---

### Task 1: Убрать проверку src в `AllSimplePaths`, вычистить неиспользуемое поле `edgeAllow.From`

**Files:**
- Modify: `internal/graph/pathfind.go:78-87`
- Modify: `internal/graph/graph.go:52-64,111-124`
- Modify: `internal/graph/graph_test.go:351-357`
- Test: `internal/graph/graph_test.go`, `internal/graph/pathfind_test.go` (если там есть смежные тесты — проверить `grep -rn AllSimplePaths internal/graph/*_test.go`)

**Interfaces:**
- Consumes: ничего нового.
- Produces: `graph.AllSimplePaths(src, dst Node, limits Limits) ([]Path, error)` — та же сигнатура, но пересечение фильтрованной связи теперь проверяет только `dst.Name ∈ e.Allow.To`. `edgeAllow` теряет поле `From` (было нигде не использовано за пределами удаляемой проверки — подтверждено `grep -rn "Allow.From" internal/graph/*.go`, единственное использование было в самой проверке).

- [ ] **Step 1: Переписать тест `TestBuild_FilteredLinkBlocksUnannouncedSrc` на новое ожидаемое поведение**

В `internal/graph/graph_test.go` заменить:

```go
func TestBuild_FilteredLinkBlocksUnannouncedSrc(t *testing.T) {
	g, _ := Build(filteredTopo())
	paths, err := g.AllSimplePaths(SubnetNode("c"), SubnetNode("a"), DefaultLimits())
	if err != nil || len(paths) != 0 {
		t.Fatalf("c→a must be filtered out, got %d paths (%v)", len(paths), err)
	}
}
```

на:

```go
// c→a used to be blocked because 'c' never appeared in the m-d filter's
// own declared lists. Real routers don't work that way: 'd' legitimately
// learned a route to 'a' (via the m-d filter's AExports) and freely shares
// everything it knows with 'o' across their unrestricted link — exactly
// like an ordinary router redistributing its routing table. Restricting
// *who* may ride along a specific link, regardless of destination, is now
// a firewall/rule concern (internal/rules), not a routing one.
func TestBuild_FilteredLinkPropagatesLearnedRouteAcrossPlainLink(t *testing.T) {
	g, _ := Build(filteredTopo())
	paths, err := g.AllSimplePaths(SubnetNode("c"), SubnetNode("a"), DefaultLimits())
	if err != nil || len(paths) == 0 {
		t.Fatalf("c→a expected reachable: d relays its learned route to a across the plain d-o link, got %d paths (%v)", len(paths), err)
	}
}
```

- [ ] **Step 2: Запустить тест, убедиться что он падает по ожидаемой причине**

Run: `go test ./internal/graph/... -run TestBuild_FilteredLinkPropagatesLearnedRouteAcrossPlainLink -v`
Expected: FAIL — `c→a expected reachable ..., got 0 paths` (текущий код всё ещё блокирует по src).

- [ ] **Step 3: Убрать проверку src в `internal/graph/pathfind.go`**

Заменить:

```go
			// Filtered-link edges carry only announced traffic: the whole
			// path must run from an announced source to an announced dest.
			if e.Allow != nil {
				if _, ok := e.Allow.From[src.Name]; !ok {
					continue
				}
				if _, ok := e.Allow.To[dst.Name]; !ok {
					continue
				}
			}
```

на:

```go
			// A filtered link forwards only toward an announced
			// destination — real routing is destination-driven, never by
			// packet source. Restricting who may originate traffic across
			// a specific link is a firewall/rule concern (internal/rules),
			// not a routing one.
			if e.Allow != nil {
				if _, ok := e.Allow.To[dst.Name]; !ok {
					continue
				}
			}
```

- [ ] **Step 4: Убрать неиспользуемое поле `From` из `edgeAllow` в `internal/graph/graph.go`**

Заменить:

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

на:

```go
// Edge is a directed graph edge.
type Edge struct {
	To Node
	// Allow, when non-nil, restricts this edge to an announced destination:
	// crossing it requires dst ∈ To (filtered-link route advertisement).
	Allow *edgeAllow
}

// edgeAllow holds the subnet names announced as reachable across a
// filtered link in this direction, resolved at Build time.
type edgeAllow struct {
	To map[string]struct{}
}
```

И в `Build()` заменить:

```go
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
```

на:

```go
				var ab, ba *edgeAllow
				if l.Filter != nil {
					aExports, err := exportSubnets(topo, l.Filter.AExports)
					if err != nil {
						return nil, fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
					}
					bExports, err := exportSubnets(topo, l.Filter.BExports)
					if err != nil {
						return nil, fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
					}
					ab = &edgeAllow{To: bExports}
					ba = &edgeAllow{To: aExports}
				}
```

- [ ] **Step 5: Прогнать пакет `graph` целиком**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./internal/graph/... -v`
Expected: `TestBuild_FilteredLinkPropagatesLearnedRouteAcrossPlainLink` — PASS. `TestBuild_FilteredLinkBlocksUnannouncedDst`, `TestBuild_FilteredLinkAllowsAnnouncedPairs`, `TestBuild_PlainLinkStillUnrestricted` — PASS без изменений. `TestReachableEntities_ChainsThroughOtherFilteredLinks` — FAIL (ожидаемо, чинится в Task 2, не трогать здесь).

- [ ] **Step 6: Commit**

```bash
git add internal/graph/pathfind.go internal/graph/graph.go internal/graph/graph_test.go
git commit -m "feat(graph): make filtered-link crossing destination-only"
```

---

### Task 2: Исправить `TestReachableEntities_ChainsThroughOtherFilteredLinks` — редактировать декларацию на правильной стороне

**Files:**
- Modify: `internal/graph/reachable_test.go:88-101`

**Interfaces:**
- Consumes: `ReachableEntities(topo *topology.Topology, device string, skip int) ([]string, error)` — без изменений сигнатуры (Task 1 изменил только внутренний `AllSimplePaths`, который `ReachableEntities` уже использует).
- Produces: ничего нового для других задач.

- [ ] **Step 1: Прогнать упавший тест, зафиксировать текущую (неверную для новой модели) причину падения**

Run: `go test ./internal/graph/... -run TestReachableEntities_ChainsThroughOtherFilteredLinks -v`
Expected: FAIL на второй проверке (`want = []string{"NA", "NB", "a", "b"}`) — правка `AExports: []` на связи `d-o` (что `d` анонсирует **в сторону** `o`) больше не влияет на то, что знает `m`: это анонс в другом направлении. `got` теперь включает `NC`/`c`.

- [ ] **Step 2: Исправить, какую сторону редактирует тест**

В `internal/graph/reachable_test.go` заменить:

```go
	// d stops announcing anything toward o: from m, c becomes unreachable.
	filter(&topo.Links[1], []string{}, []string{"NC"})
	got, err = ReachableEntities(topo, "m", -1)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want = []string{"NA", "NB", "a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
```

на:

```go
	// d revokes NC from what it announces toward m (not toward o — that's
	// a different direction and wouldn't affect what m has learned): from
	// m, c becomes unreachable, while b/NB — always reachable in one hop,
	// never needed d's help past this link — stays reachable.
	filter(&topo.Links[0], []string{"NA"}, []string{"NB"})
	got, err = ReachableEntities(topo, "m", -1)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want = []string{"NA", "NB", "a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
```

- [ ] **Step 3: Прогнать тест, убедиться в успехе**

Run: `go test ./internal/graph/... -v`
Expected: все тесты пакета `graph` — PASS.

- [ ] **Step 4: Commit**

```bash
git add internal/graph/reachable_test.go
git commit -m "fix(graph): revoke the m-d link's own announcement, not d-o's, in the chain test"
```

---

### Task 3: Регресс-тест на уровне компилятора — однонаправленная цепочка реэкспорта

**Files:**
- Modify: `internal/app/compile_test.go`

**Interfaces:**
- Consumes: `Compile(ctx, log, CompileOptions{TopologyYAML, SubnetsYAML, RulesYAML}) ([]CompiledDevice, error)`, `names(out []CompiledDevice) []string` — оба уже существуют в файле, без изменений.
- Produces: ничего нового для других задач — это лист регрессии, закрепляющий поведение Task 1 на уровне размещения правил firewall.

- [ ] **Step 1: Добавить фикстуру и failing-тесты**

В `internal/app/compile_test.go`, рядом с `filteredChainTopology`/`filteredChainSubnets`, добавить:

```go
const chainedReExportTopology = `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
  - {name: o, kind: router}
links:
  - a: {device: m}
    b: {device: d}
    filter: {a-exports: [NA], b-exports: [NB]}
  - a: {device: o}
    b: {device: d}
    filter: {a-exports: [NC], b-exports: [NB, NA]}
networks:
  - {name: NA, subnets: [a], attach: [{device: m}]}
  - {name: NB, subnets: [b], attach: [{device: d}]}
  - {name: NC, subnets: [c], attach: [{device: o}]}
`

const chainedReExportSubnets = `
subnets:
  - {name: a, cidr: 10.0.20.0/24}
  - {name: b, cidr: 10.0.21.0/24}
  - {name: c, cidr: 10.0.22.0/24}
`

// d re-exports NA (learned from m) toward o (b-exports includes NA on the
// o-d link) — o can now reach m. Nothing announces NC back toward m on the
// m-d link, so the reverse direction has no route at all: filtered links
// model per-direction route advertisement, not a symmetric ACL pair.
func TestCompile_ChainedReExportPlacesRuleForWorkingDirection(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: office-to-market, src: [NC], dst: [NA], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(chainedReExportTopology),
		SubnetsYAML:  []byte(chainedReExportSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	got := names(out)
	want := []string{"d", "m", "o"}
	if !slices.Equal(got, want) {
		t.Fatalf("chained re-export places on %v, want %v", got, want)
	}
}

func TestCompile_ChainedReExportPlacesNoRuleWithoutSymmetricAnnouncement(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: market-to-office, src: [NA], dst: [NC], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(chainedReExportTopology),
		SubnetsYAML:  []byte(chainedReExportSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("market has no route back to office without a symmetric announcement, got devices: %v", names(out))
	}
}
```

- [ ] **Step 2: Запустить оба теста, убедиться что они уже проходят (Task 1/2 уже внесли фикс)**

Run: `go test ./internal/app/... -run TestCompile_ChainedReExport -v`
Expected: оба PASS — производственный код уже правильный после Task 1; эти тесты фиксируют поведение как регрессию, а не двигают реализацию. Если `TestCompile_ChainedReExportPlacesRuleForWorkingDirection` падает на порядке `want` — заменить на фактический порядок из `names(out)` только если он детерминирован и алфавитен по построению `Compile` (проверить соседний `TestCompile_FilteredLinkKeepsAnnouncedPair`, который уже ожидает алфавитный порядок `{"d","o"}`).

- [ ] **Step 3: Прогнать пакет целиком**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./internal/app/... -v`
Expected: все тесты пакета `app` — PASS.

- [ ] **Step 4: Commit**

```bash
git add internal/app/compile_test.go
git commit -m "test(app): lock in one-way rule placement for a chained filtered re-export"
```

---

### Task 4: Регресс-тест диагностики — путь есть, обратного пути нет из-за отсутствия маршрута

**Files:**
- Modify: `internal/diagnose/diagnose_test.go`

**Interfaces:**
- Consumes: `diagnose.Run(topo, sets, g, limits, flow) (*Report, error)`, `Report.Paths`, `Report.ReturnPathAllowed` — уже существуют (добавлены в текущей сессии, до этого плана).
- Produces: ничего нового — регресс-тест на связку Task 1 + уже реализованный `ReturnPathAllowed`.

- [ ] **Step 1: Добавить фикстуру и failing-тест**

В `internal/diagnose/diagnose_test.go`, рядом с существующими топологиями, добавить:

```go
const chainedReExportDiagTopology = `
devices:
  - {name: market, kind: router}
  - {name: dc, kind: router}
  - {name: office, kind: router}
links:
  - a: {device: market}
    b: {device: dc}
    filter: {a-exports: [MARKET], b-exports: [DC]}
  - a: {device: office}
    b: {device: dc}
    filter: {a-exports: [OFFICE], b-exports: [DC, MARKET]}
networks:
  - {name: MARKET, subnets: [market-net], attach: [{device: market}]}
  - {name: DC, subnets: [dc-net], attach: [{device: dc}]}
  - {name: OFFICE, subnets: [office-net], attach: [{device: office}]}
`

const chainedReExportDiagSubnets = `
subnets:
  - {name: market-net, cidr: 10.9.0.0/24}
  - {name: dc-net, cidr: 10.9.1.0/24}
  - {name: office-net, cidr: 10.9.2.0/24}
`

// office learned a route to MARKET because dc re-exports it (b-exports on
// the office-dc link includes MARKET); market never learned a route back
// to OFFICE (b-exports on the market-dc link only has DC). This mirrors
// the real-world scenario the diagnose UI is meant to surface: the request
// physically arrives, the response has no route home — a routing gap, not
// a firewall verdict, but ReturnPathAllowed reports the same false either
// way (see internal/diagnose/diagnose.go's pathResults/returnPathAllowed).
func TestRun_ChainedReExportRequestArrivesReturnHasNoRoute(t *testing.T) {
	topo, err := topology.Load(strings.NewReader(chainedReExportDiagTopology))
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := topology.LoadSubnets(strings.NewReader(chainedReExportDiagSubnets))
	if err != nil {
		t.Fatalf("load subnets: %v", err)
	}
	topo.Subnets = subs
	if err := topo.Validate(); err != nil {
		t.Fatalf("validate topology: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	rep, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.9.2.5"), Dst: netip.MustParseAddr("10.9.0.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run: %v", err)
	}
	if len(rep.Paths) == 0 {
		t.Fatal("office must have learned a route to market via dc's re-export")
	}
	if rep.ReturnPathAllowed {
		t.Fatal("market never learned a route back to office: no firewall rule can create a route that was never announced")
	}
}
```

- [ ] **Step 2: Запустить тест, убедиться что он уже проходит**

Run: `go test ./internal/diagnose/... -run TestRun_ChainedReExportRequestArrivesReturnHasNoRoute -v`
Expected: PASS — Task 1 уже дал маршрутизации нужную асимметрию, `ReturnPathAllowed` (реализован ранее в этой сессии) уже корректно её видит без изменений собственного кода.

- [ ] **Step 3: Прогнать пакет целиком**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./internal/diagnose/... -v`
Expected: все тесты пакета `diagnose` — PASS.

- [ ] **Step 4: Commit**

```bash
git add internal/diagnose/diagnose_test.go
git commit -m "test(diagnose): lock in ReturnPathAllowed=false when the return route was never announced"
```

---

### Task 5: Обновить дизайн-документ фильтрованных связей

**Files:**
- Modify: `docs/superpowers/specs/2026-08-23-filtered-links-design.md`

**Interfaces:**
- Consumes: ничего (документация).
- Produces: ничего (документация) — этот документ читают будущие сессии как источник истины про семантику фильтрованных связей; после Task 1-4 его текст про `src ∈ Allow.From && dst ∈ Allow.To` устарел и вводит в заблуждение.

- [ ] **Step 1: Переписать раздел «Граф и поиск путей»**

Заменить:

```markdown
## Граф и поиск путей

`internal/graph/graph.go`:

```go
type Edge struct {
    To    Node
    Allow *edgeAllow // nil = неограниченное ребро
}

type edgeAllow struct {
    From, To map[string]struct{} // множества имён подсетей
}
```

При `Build`: для фильтрованной связи роутер–роутер экспорты обеих сторон
резолвятся в множества имён подсетей. Ребро `A→B` получает
`Allow{From: subs(AExports), To: subs(BExports)}`, ребро `B→A` — зеркально.

`internal/graph/pathfind.go`: `AllSimplePaths(src, dst)` во время DFS при
переходе по ребру с `Allow != nil` проверяет
`src.Name ∈ Allow.From && dst.Name ∈ Allow.To`; иначе ветка отсекается.
Обычные рёбра и доменные шины проверок не имеют.

Компилятор **не меняется**: `pairCache`/`RoutersOnPaths` просто получают
меньше путей для отфильтрованных пар.
```

на:

```markdown
## Граф и поиск путей

**Обновлено `2026-08-27`, см. `docs/superpowers/specs/2026-08-27-route-propagation-design.md`.**
Исходная модель ниже (обе стороны проверяются на каждом хопе) заменена на
чисто анонс-ориентированную: маршрутизация асимметрична, как в реальной
сети, а ограничения по источнику — задача отдельного слоя firewall
(`internal/rules`).

`internal/graph/graph.go`:

```go
type Edge struct {
    To    Node
    Allow *edgeAllow // nil = неограниченное ребро
}

type edgeAllow struct {
    To map[string]struct{} // подсети, анонсированные как достижимые в эту сторону
}
```

При `Build`: для фильтрованной связи роутер–роутер экспорты обеих сторон
резолвятся в множества имён подсетей. Ребро `A→B` получает
`Allow{To: subs(BExports)}` (пакет пропускается, если получатель анонсирован
B-стороной), ребро `B→A` — зеркально, `Allow{To: subs(AExports)}`.

`internal/graph/pathfind.go`: `AllSimplePaths(src, dst)` во время DFS при
переходе по ребру с `Allow != nil` проверяет `dst.Name ∈ Allow.To`; источник
пакета не проверяется — реальные роутеры пересылают пакеты по таблице
маршрутизации, не заглядывая в источник. Если нужно ограничить, кто может
воспользоваться конкретной связью транзитом, — это правило firewall
(`deny` по `src` на нужном роутере), не свойство связи.

Компилятор **не меняется**: `pairCache`/`RoutersOnPaths` используют тот же
`AllSimplePaths` и автоматически наследуют новую (асимметричную) модель.
```

- [ ] **Step 2: Дополнить раздел «Поведение отрезанных пар»**

После существующего абзаца этого раздела добавить:

```markdown

Из-за анонс-ориентированной модели (см. выше) путь может существовать в
одном направлении и не существовать в противоположном — это не ошибка и
не частный случай, а нормальное поведение: каждое направление анонсируется
независимо. `diagnose.Report.ReturnPathAllowed` показывает эту асимметрию
на уровне диагностики, не различая, вызвана ли она отсутствием маршрута или
запрещающим правилом firewall — с точки зрения того, дойдёт ли трафик
обратно, эти два случая эквивалентны.
```

- [ ] **Step 3: Проверить, что документ не сломан (валидный markdown, ссылка на новый файл существует)**

Run: `test -f docs/superpowers/specs/2026-08-27-route-propagation-design.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-23-filtered-links-design.md
git commit -m "docs: update filtered-links design for destination-only route propagation"
```

---

## Final verification (after all tasks)

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: `gofmt -l .` prints nothing; `go test ./...` — all green (Postgres-backed `internal/httpapi`/`internal/pgstore`/`internal/db` tests need a disposable test database — see `docs/superpowers/plans/2026-08-26-multiuser-foundation.md`'s setup snippet — otherwise they self-skip and the rest still must be green).
Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: all green (this plan touches no frontend files, included only as a safety net).
