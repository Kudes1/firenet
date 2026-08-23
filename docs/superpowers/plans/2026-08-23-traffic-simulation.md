# Traffic Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показать, как пойдёт трафик между двумя IP: все пути, которые находит ядро при компиляции, с вердиктом и объяснением по каждому транзитному роутеру — в веб-UI на новой странице с картой топологии.

**Architecture:** Симуляция поверх скомпилированных правил: `app.Simulate` повторяет пайплайн `app.Compile` (load → graph.Build → compiler.Compile), затем новый пакет `internal/simulate` резолвит IP → подсети, перечисляет пути через `graph.AllSimplePaths` и матчит трафик против `CompiledRule` каждого транзитного роутера (`compiler.MatchFlow`, семантика рендера). HTTP: `POST /api/simulate` + страница `/ui/simulate`; из `topology.js` выделяется общий модуль `netmap.js` для read-only карты с подсветкой путей.

**Tech Stack:** Go 1.23 stdlib (`net/netip`, `net/http`), gopkg.in/yaml.v3, htmx+alpine+vanilla JS (node:test с DOM-заглушками).

**Spec:** `docs/superpowers/specs/2026-08-23-traffic-simulation-design.md`

## Global Constraints

- Модуль: `github.com/kudes1/firenet`. Новых зависимостей не добавлять.
- `internal/app` остаётся delivery-agnostic; `internal/simulate` и `internal/compiler` не знают про HTTP/файлы.
- Стиль кода: компактный, без комментариев кроме тех, что объясняют неочевидное (по образцу существующих файлов).
- Проверка после каждой задачи: `go build ./... && go vet ./... && gofmt -l . && go test ./...`
- JS-тесты: `node --test 'internal/httpapi/web/*.test.js'` (glob обязателен).
- `internal/httpapi/web/` встроен через go:embed — после правки ассетов пересобрать бинарник (`make build`) для проверки вживую.
- Вердикты симуляции обязаны совпадать со скомпилированными правилами тех же устройств (спека: подход A).
- Русский язык для UI-текстов и сообщений об ошибках симуляции.

---

### Task 1: `compiler.MatchFlow`

**Files:**
- Create: `internal/compiler/match.go`
- Test: `internal/compiler/match_test.go`

**Interfaces:**
- Consumes: `DeviceRuleset`, `CompiledRule`, `IPSet` из `internal/compiler/model.go`; `rules.Proto/ProtoAny/ProtoTCP/ActionAllow/ActionDeny`.
- Produces: `func MatchFlow(rs DeviceRuleset, src, dst netip.Addr, proto rules.Proto, srcPorts, dstPorts []string) *CompiledRule` — первый матч по порядку `rs.Rules`, `nil` → дефолт.

- [ ] **Step 1: Write the failing test**

```go
package compiler

import (
	"net/netip"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

var (
	officeIP = netip.MustParseAddr("10.0.0.5")
	dmzIP    = netip.MustParseAddr("10.0.1.7")
)

// matchFixture: ipset "fn_office" = 10.0.0.0/24, "fn_dmz" = 10.0.1.0/24,
// правило office-to-dmz tcp/443 allow, затем безусловное deny.
func matchFixture() DeviceRuleset {
	return DeviceRuleset{
		IPSets: []IPSet{
			{Name: "fn_office", DisplayName: "office", CIDRs: []string{"10.0.0.0/24"}},
			{Name: "fn_dmz", DisplayName: "dmz", CIDRs: []string{"10.0.1.0/24"}},
		},
		Rules: []CompiledRule{
			{Comment: "office-to-dmz", SrcSet: "fn_office", DstSet: "fn_dmz", Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
			{Comment: "catch-all-deny", Proto: rules.ProtoAny, Action: rules.ActionDeny},
		},
		DefaultAction: rules.ActionDeny,
	}
}

func TestMatchFlow(t *testing.T) {
	tests := []struct {
		name string
		src  netip.Addr
		dst  netip.Addr
		proto rules.Proto
		srcPorts, dstPorts []string
		want string // Comment или "" (nil)
	}{
		{"exact match", officeIP, dmzIP, rules.ProtoTCP, nil, []string{"443"}, "office-to-dmz"},
		{"wrong port falls through to unconditional", officeIP, dmzIP, rules.ProtoTCP, nil, []string{"80"}, "catch-all-deny"},
		{"proto mismatch falls through", officeIP, dmzIP, rules.ProtoUDP, nil, []string{"443"}, "catch-all-deny"},
		{"empty flow proto matches any rule proto", officeIP, dmzIP, "", nil, nil, "office-to-dmz"},
		{"empty flow ports match port rule", officeIP, dmzIP, rules.ProtoTCP, nil, nil, "office-to-dmz"},
		{"src outside ipset skips set rule", netip.MustParseAddr("192.168.5.5"), dmzIP, rules.ProtoTCP, nil, []string{"443"}, "catch-all-deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MatchFlow(matchFixture(), tt.src, tt.dst, tt.proto, tt.srcPorts, tt.dstPorts)
			if tt.want == "" {
				if got != nil { t.Fatalf("want nil, got %+v", got) }
				return
			}
			if got == nil || got.Comment != tt.want {
				t.Fatalf("want rule %q, got %+v", tt.want, got)
			}
		})
	}
}

func TestMatchFlow_FirstMatchOrder(t *testing.T) {
	rs := matchFixture()
	got := MatchFlow(rs, officeIP, dmzIP, rules.ProtoAny, nil, nil)
	if got == nil || got.Comment != "office-to-dmz" {
		t.Fatalf("first-match order broken: %+v", got)
	}
}

func TestMatchFlow_LiteralAndUnconditional(t *testing.T) {
	rs := DeviceRuleset{
		Rules: []CompiledRule{
			{Comment: "host-block", SrcAddr: "10.0.0.9/32", Proto: rules.ProtoAny, Action: rules.ActionDeny},
			{Comment: "uncond", Action: rules.ActionAllow},
		},
		DefaultAction: rules.ActionDeny,
	}
	if r := MatchFlow(rs, netip.MustParseAddr("10.0.0.9"), dmzIP, "", nil, nil); r == nil || r.Comment != "host-block" {
		t.Fatalf("literal /32 must match contained host: %+v", r)
	}
	if r := MatchFlow(rs, officeIP, dmzIP, "", nil, nil); r == nil || r.Comment != "uncond" {
		t.Fatalf("empty SrcSet/DstSet is unconditional: %+v", r)
	}
}

func TestMatchFlow_PortRanges(t *testing.T) {
	rs := DeviceRuleset{
		Rules: []CompiledRule{{Comment: "range", Proto: rules.ProtoTCP, DstPorts: []string{"1000:2000"}, Action: rules.ActionAllow}},
		DefaultAction: rules.ActionDeny,
	}
	if r := MatchFlow(rs, officeIP, dmzIP, rules.ProtoTCP, nil, []string{"1500"}); r == nil {
		t.Fatal("1500 inside 1000:2000 must match")
	}
	if r := MatchFlow(rs, officeIP, dmzIP, rules.ProtoTCP, nil, []string{"2500"}); r != nil {
		t.Fatalf("2500 outside range must not match: %+v", r)
	}
}

func TestMatchFlow_NoMatchReturnsNil(t *testing.T) {
	rs := DeviceRuleset{
		Rules: []CompiledRule{{Comment: "x", SrcSet: "fn_missing", Action: rules.ActionAllow}},
		DefaultAction: rules.ActionDeny,
	}
	if got := MatchFlow(rs, officeIP, dmzIP, "", nil, nil); got != nil {
		t.Fatalf("unknown ipset name must not match, got %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/compiler/ -run TestMatchFlow -v`
Expected: FAIL — `undefined: MatchFlow`.

- [ ] **Step 3: Write minimal implementation**

```go
package compiler

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/rules"
)

// MatchFlow returns the first CompiledRule of rs matching a packet from src
// to dst — the same first-match order the rendered iptables script evaluates
// in. nil means no rule matches and traffic falls to rs.DefaultAction.
// Semantics mirror render exactly: empty set/literal side is unconditional;
// an ipset matches when any of its CIDRs contains the address; ProtoAny
// matches every protocol and an empty flow proto matches every rule; a rule
// without ports or without flow ports matches any port, otherwise some rule
// entry must intersect the flow ports ("a:b" ranges overlap numerically).
func MatchFlow(rs DeviceRuleset, src, dst netip.Addr, proto rules.Proto, srcPorts, dstPorts []string) *CompiledRule {
	for i := range rs.Rules {
		r := &rs.Rules[i]
		if !sideMatches(rs, r.SrcSet, r.SrcAddr, src) || !sideMatches(rs, r.DstSet, r.DstAddr, dst) {
			continue
		}
		if proto != "" && r.Proto != rules.ProtoAny && r.Proto != proto {
			continue
		}
		if !portsMatch(r.SrcPorts, srcPorts) || !portsMatch(r.DstPorts, dstPorts) {
			continue
		}
		return r
	}
	return nil
}

func sideMatches(rs DeviceRuleset, set, literal string, addr netip.Addr) bool {
	switch {
	case set != "":
		return setContains(rs, set, addr)
	case literal != "":
		p, err := netip.ParsePrefix(literal)
		return err == nil && p.Contains(addr)
	default:
		return true
	}
}

func setContains(rs DeviceRuleset, name string, addr netip.Addr) bool {
	for _, s := range rs.IPSets {
		if s.Name != name {
			continue
		}
		for _, c := range s.CIDRs {
			if p, err := netip.ParsePrefix(c); err == nil && p.Contains(addr) {
				return true
			}
		}
		return false
	}
	return false
}

func portsMatch(rulePorts, flowPorts []string) bool {
	if len(rulePorts) == 0 || len(flowPorts) == 0 {
		return true
	}
	for _, rp := range rulePorts {
		for _, fp := range flowPorts {
			if portOverlap(rp, fp) {
				return true
			}
		}
	}
	return false
}

func portOverlap(a, b string) bool {
	al, ah, ok := portRange(a)
	if !ok {
		return false
	}
	bl, bh, ok := portRange(b)
	if !ok {
		return false
	}
	return al <= bh && bl <= ah
}

func portRange(s string) (lo, hi int, ok bool) {
	loStr, hiStr, ranged := strings.Cut(s, ":")
	if !ranged {
		hiStr = loStr
	}
	lo, err1 := strconv.Atoi(loStr)
	hi, err2 := strconv.Atoi(hiStr)
	if err1 != nil || err2 != nil || lo > hi {
		return 0, 0, false
	}
	return lo, hi, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/compiler/ -run TestMatchFlow -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/compiler/match.go internal/compiler/match_test.go
git commit -m "feat(compiler): MatchFlow — first-match traffic matching over compiled rules"
```

---

### Task 2: пакет `internal/simulate` (модель, ResolveIP, Run)

**Files:**
- Create: `internal/simulate/simulate.go`
- Test: `internal/simulate/simulate_test.go`

**Interfaces:**
- Consumes: `compiler.DeviceRuleset`, `compiler.MatchFlow`, `graph.Graph/SubnetNode/AllSimplePaths/Limits/DefaultLimits`, `rules.*`, `topology.Topology/Load/LoadSubnets`, `rules.Load`.
- Produces (используют Task 3–4 и JS):
  - `type Flow struct { Src, Dst netip.Addr; Proto rules.Proto; SrcPorts, DstPorts []string }`
  - `type Report struct { SrcSubnet, DstSubnet string; Note string; Paths []PathResult }` (JSON-теги `srcSubnet/dstSubnet/note/paths`)
  - `type PathResult struct { Nodes []graph.Node; Routers []RouterVerdict; Verdict rules.Action; Note string }` (теги `nodes/routers/verdict/note,omitempty`)
  - `type RouterVerdict struct { Router string; Action rules.Action; MatchedRule string; Reason string }` (теги `router/action/matchedRule,omitempty/reason`)
  - `const StatelessNote = "..."`
  - `func ResolveIP(topo *topology.Topology, addr netip.Addr) (string, error)`
  - `func Run(topo *topology.Topology, sets []compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, defaultAction rules.Action, flow Flow) (*Report, error)`

- [ ] **Step 1: Write the failing test**

```go
package simulate_test

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/simulate"
	"github.com/kudes1/firenet/internal/topology"
)

const simTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const simSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
  - {name: isolated, cidr: 10.0.2.0/24}
`

const simRulesAllow = `
defaultAction: deny
chainName: FIRENET-FWD
chainPosition: top
rules:
  - {name: office-to-dmz, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

const simRulesDeny = `
defaultAction: allow
chainName: FIRENET-FWD
chainPosition: top
rules:
  - {name: block-dmz, src: [office], dst: [dmz], action: deny}
`

func loadTopo(t *testing.T) (*topology.Topology, *graph.Graph) {
	t.Helper()
	topo, err := topology.Load(strings.NewReader(simTopology))
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := topology.LoadSubnets(strings.NewReader(simSubnets))
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
	return topo, g
}

func compilePolicy(t *testing.T, topo *topology.Topology, g *graph.Graph, policyYAML string) ([]compiler.DeviceRuleset, rules.Action) {
	t.Helper()
	pol, err := rules.Load(strings.NewReader(policyYAML))
	if err != nil {
		t.Fatalf("load rules: %v", err)
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("validate rules: %v", err)
	}
	sets, err := compiler.Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return sets, pol.DefaultAction
}

func runSim(t *testing.T, policyYAML string, src, dst string, proto rules.Proto, dstPorts ...string) *simulate.Report {
	t.Helper()
	topo, g := loadTopo(t)
	sets, def := compilePolicy(t, topo, g, policyYAML)
	flow := simulate.Flow{
		Src:      netip.MustParseAddr(src),
		Dst:      netip.MustParseAddr(dst),
		Proto:    proto,
		DstPorts: dstPorts,
	}
	rep, err := simulate.Run(topo, sets, g, graph.DefaultLimits(), def, flow)
	if err != nil {
		t.Fatalf("simulate.Run: %v", err)
	}
	return rep
}

func TestResolveIP_SubnetAndError(t *testing.T) {
	topo, _ := loadTopo(t)
	name, err := simulate.ResolveIP(topo, netip.MustParseAddr("10.0.0.5"))
	if err != nil || name != "office" {
		t.Fatalf("want office, got %q, %v", name, err)
	}
	if _, err := simulate.ResolveIP(topo, netip.MustParseAddr("192.168.99.99")); err == nil {
		t.Fatal("unknown IP must fail")
	}
}

func TestRun_AllowedPath(t *testing.T) {
	rep := runSim(t, simRulesAllow, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" {
		t.Fatalf("endpoint resolution wrong: %+v", rep)
	}
	if len(rep.Paths) != 1 {
		t.Fatalf("want 1 path, got %d", len(rep.Paths))
	}
	p := rep.Paths[0]
	if p.Verdict != rules.ActionAllow {
		t.Fatalf("want allow, got %q (routers %+v)", p.Verdict, p.Routers)
	}
	if len(p.Routers) != 2 {
		t.Fatalf("want 2 transit routers, got %+v", p.Routers)
	}
	for _, v := range p.Routers {
		if v.MatchedRule != "office-to-dmz" || v.Action != rules.ActionAllow || v.Reason == "" {
			t.Fatalf("bad verdict on %s: %+v", v.Router, v)
		}
	}
}

func TestRun_DeniedPathOverridesDefault(t *testing.T) {
	rep := runSim(t, simRulesDeny, "10.0.0.5", "10.0.1.7", "")
	if len(rep.Paths) != 1 || rep.Paths[0].Verdict != rules.ActionDeny {
		t.Fatalf("want denied path, got %+v", rep.Paths)
	}
	for _, v := range rep.Paths[0].Routers {
		if v.MatchedRule != "block-dmz" {
			t.Fatalf("router %s: want block-dmz, got %+v", v.Router, v)
		}
	}
}

func TestRun_NoMatchingRuleFallsToDefault(t *testing.T) {
	rep := runSim(t, simRulesAllow, "10.0.0.5", "10.0.1.7", rules.ProtoUDP)
	if len(rep.Paths) != 1 || rep.Paths[0].Verdict != rules.ActionDeny {
		t.Fatalf("udp must fall to default deny, got %+v", rep.Paths)
	}
	v := rep.Paths[0].Routers[0]
	if v.MatchedRule != "" || v.Reason == "" {
		t.Fatalf("want default-action explanation, got %+v", v)
	}
}

func TestRun_UnreachableIsEmptyNotError(t *testing.T) {
	rep := runSim(t, simRulesAllow, "10.0.0.5", "10.0.2.7", "")
	if len(rep.Paths) != 0 {
		t.Fatalf("isolated subnet must yield zero paths, got %+v", rep.Paths)
	}
}

func TestRun_SameSubnetIsL2(t *testing.T) {
	rep := runSim(t, simRulesAllow, "10.0.0.1", "10.0.0.200", "")
	if len(rep.Paths) != 1 {
		t.Fatalf("same-subnet must yield one degenerate path, got %+v", rep.Paths)
	}
	p := rep.Paths[0]
	if len(p.Nodes) != 1 || len(p.Routers) != 0 || p.Note == "" {
		t.Fatalf("degenerate path expected, got %+v", p)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/simulate/ -v`
Expected: FAIL — пакет/символы `simulate` не существуют.

- [ ] **Step 3: Write minimal implementation**

```go
package simulate

import (
	"fmt"
	"sort"

	"net/netip"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// Flow describes the simulated traffic: endpoints as IP addresses plus an
// optional protocol/port filter. Empty proto or empty port lists mean "any".
type Flow struct {
	Src, Dst netip.Addr
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
}

// StatelessNote accompanies every report: the simulation evaluates the first
// packet of a new connection, so the conntrack ESTABLISHED,RELATED accept
// present on every device is deliberately out of scope.
const StatelessNote = "симуляция рассматривает первый пакет нового соединения; conntrack ESTABLISHED,RELATED не учитывается"

type Report struct {
	SrcSubnet string       `json:"srcSubnet"`
	DstSubnet string       `json:"dstSubnet"`
	Note      string       `json:"note"`
	Paths     []PathResult `json:"paths"`
}

type PathResult struct {
	Nodes   []graph.Node    `json:"nodes"`
	Routers []RouterVerdict `json:"routers"`
	Verdict rules.Action    `json:"verdict"`
	Note    string          `json:"note,omitempty"`
}

type RouterVerdict struct {
	Router      string       `json:"router"`
	Action      rules.Action `json:"action"`
	MatchedRule string       `json:"matchedRule,omitempty"`
	Reason      string       `json:"reason"`
}

// ResolveIP maps an address to the declared entity it belongs to: the first
// subnet (sorted-name order) whose CIDR contains it, else the first set with
// a matching host address.
func ResolveIP(topo *topology.Topology, addr netip.Addr) (string, error) {
	names := make([]string, 0, len(topo.Subnets))
	for n := range topo.Subnets {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if topo.Subnets[n].CIDR.Contains(addr) {
			return n, nil
		}
	}
	setNames := make([]string, 0, len(topo.Sets))
	for n := range topo.Sets {
		setNames = append(setNames, n)
	}
	sort.Strings(setNames)
	for _, n := range setNames {
		for _, p := range topo.Sets[n].Addresses {
			if p.Contains(addr) {
				return n, nil
			}
		}
	}
	return "", fmt.Errorf("IP %s не принадлежит ни одной подсети или набору", addr)
}

// Run answers "how would traffic flow": resolve endpoints to subnets, list
// every simple path exactly like the compiler does, and produce a per-router
// verdict over that device's compiled rules. A path is denied at its first
// denying router; otherwise allowed.
func Run(topo *topology.Topology, sets []compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, defaultAction rules.Action, flow Flow) (*Report, error) {
	srcName, err := ResolveIP(topo, flow.Src)
	if err != nil {
		return nil, fmt.Errorf("src: %w", err)
	}
	dstName, err := ResolveIP(topo, flow.Dst)
	if err != nil {
		return nil, fmt.Errorf("dst: %w", err)
	}
	rep := &Report{SrcSubnet: srcName, DstSubnet: dstName, Note: StatelessNote}
	if srcName == dstName {
		rep.Paths = []PathResult{{
			Nodes:   []graph.Node{graph.SubnetNode(srcName)},
			Verdict: rules.ActionAllow,
			Note:    "трафик не пересекает управляемые роутеры (L2-сегмент)",
		}}
		return rep, nil
	}

	byDevice := make(map[string]compiler.DeviceRuleset, len(sets))
	for _, rs := range sets {
		byDevice[rs.Device] = rs
	}
	paths, err := g.AllSimplePaths(graph.SubnetNode(srcName), graph.SubnetNode(dstName), limits)
	if err != nil {
		return nil, err
	}
	for _, p := range paths {
		pr := PathResult{Nodes: p.Nodes}
		denied := false
		for _, r := range p.Routers() {
			v := verdict(byDevice[r], defaultAction, flow, r)
			if v.Action == rules.ActionDeny {
				denied = true
			}
			pr.Routers = append(pr.Routers, v)
		}
		if denied {
			pr.Verdict = rules.ActionDeny
		} else {
			pr.Verdict = rules.ActionAllow
		}
		rep.Paths = append(rep.Paths, pr)
	}
	return rep, nil
}

func verdict(rs compiler.DeviceRuleset, def rules.Action, flow Flow, router string) RouterVerdict {
	matched := compiler.MatchFlow(rs, flow.Src, flow.Dst, flow.Proto, flow.SrcPorts, flow.DstPorts)
	if matched == nil {
		return RouterVerdict{
			Router: router,
			Action: def,
			Reason: fmt.Sprintf("нет подходящих правил — применяется действие по умолчанию %q", def),
		}
	}
	return RouterVerdict{
		Router:      router,
		Action:      matched.Action,
		MatchedRule: matched.Comment,
		Reason: fmt.Sprintf("сработало правило %q (%s): src %s, dst %s, proto %s, порты src %s / dst %s",
			matched.Comment, matched.Action,
			sideDesc(rs, matched.SrcSet, matched.SrcAddr, true),
			sideDesc(rs, matched.DstSet, matched.DstAddr, false),
			matched.Proto, portsDesc(matched.SrcPorts), portsDesc(matched.DstPorts)),
	}
}

func sideDesc(rs compiler.DeviceRuleset, set, literal string, src bool) string {
	side := "dst"
	if src {
		side = "src"
	}
	switch {
	case set != "":
		for _, s := range rs.IPSets {
			if s.Name == set {
				return side + ": ipset " + s.DisplayName
			}
		}
		return side + ": ipset " + set
	case literal != "":
		return side + ": адрес " + literal
	default:
		return side + ": любой"
	}
}

func portsDesc(ports []string) string {
	if len(ports) == 0 {
		return "любые"
	}
	return strings.Join(ports, ",")
}
```

(добавить `"strings"` в импорты).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/simulate/ -v`
Expected: PASS. Если `simRules*` фикстуры не проходят `pol.Validate` (например, обязательные поля chain) — поправить фикстуру по образцу `internal/rules/validate_test.go`, но не реализацию.

- [ ] **Step 5: Commit**

```bash
git add internal/simulate/
git commit -m "feat(simulate): traffic simulation core over compiled rulesets"
```

---

### Task 3: оркестрация `app.Simulate`

**Files:**
- Create: `internal/app/simulate.go`
- Test: `internal/app/simulate_test.go`

**Interfaces:**
- Consumes: `LoadProject`, `rules.Load/Validate`, `graph.Build/DefaultLimits`, `compiler.Compile`, `simulate.Flow/Run` (Task 2).
- Produces: `type SimulateOptions struct { TopologyYAML, SubnetsYAML, RulesYAML []byte; MaxHops, MaxPaths int; Flow simulate.Flow }`; `func Simulate(_ context.Context, log *slog.Logger, opts SimulateOptions) (*simulate.Report, error)`.

- [ ] **Step 1: Write the failing test**

```go
package app_test

import (
	"context"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/app"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/simulate"
)

const simAppTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const simAppSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
`

const simAppRules = `
defaultAction: deny
chainName: FIRENET-FWD
chainPosition: top
rules:
  - {name: office-to-dmz, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

func TestSimulate_MatchesCompileVerdicts(t *testing.T) {
	rep, err := app.Simulate(context.Background(), testLogger(), app.SimulateOptions{
		TopologyYAML: []byte(simAppTopology),
		SubnetsYAML:  []byte(simAppSubnets),
		RulesYAML:    []byte(simAppRules),
		Flow: simulate.Flow{
			Src:      netip.MustParseAddr("10.0.0.5"),
			Dst:      netip.MustParseAddr("10.0.1.7"),
			Proto:    rules.ProtoTCP,
			DstPorts: []string{"443"},
		},
	})
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" || len(rep.Paths) != 1 {
		t.Fatalf("unexpected report: %+v", rep)
	}
	p := rep.Paths[0]
	if p.Verdict != rules.ActionAllow || len(p.Routers) != 2 {
		t.Fatalf("want allowed path via 2 routers, got %+v", p)
	}
	if p.Routers[0].MatchedRule != "office-to-dmz" {
		t.Fatalf("want office-to-dmz, got %+v", p.Routers[0])
	}
}

func TestSimulate_UnknownIPErrors(t *testing.T) {
	_, err := app.Simulate(context.Background(), testLogger(), app.SimulateOptions{
		TopologyYAML: []byte(simAppTopology),
		SubnetsYAML:  []byte(simAppSubnets),
		RulesYAML:    []byte(simAppRules),
		Flow: simulate.Flow{
			Src: netip.MustParseAddr("10.0.0.5"),
			Dst: netip.MustParseAddr("192.168.99.99"),
		},
	})
	if err == nil || !strings.Contains(err.Error(), "не принадлежит") {
		t.Fatalf("want unknown-IP error, got %v", err)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
```

Если в `internal/app` уже есть хелпер-логгер в тестах (см. `compile_test.go`) — использовать его вместо `testLogger`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/app/ -run TestSimulate -v`
Expected: FAIL — `undefined: app.Simulate`.

- [ ] **Step 3: Write minimal implementation**

```go
package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/simulate"
)

type SimulateOptions struct {
	TopologyYAML []byte
	SubnetsYAML  []byte
	RulesYAML    []byte
	MaxHops      int
	MaxPaths     int
	Flow         simulate.Flow
}

// Simulate answers "how would traffic from opts.Flow.Src to opts.Flow.Dst
// flow": it runs the same load -> build -> compile pipeline as Compile, then
// reports every simple path between the resolved endpoint subnets together
// with a per-router verdict over the compiled rules.
func Simulate(_ context.Context, log *slog.Logger, opts SimulateOptions) (*simulate.Report, error) {
	topo, err := LoadProject(opts.TopologyYAML, opts.SubnetsYAML)
	if err != nil {
		return nil, err
	}
	pol, err := rules.Load(bytes.NewReader(opts.RulesYAML))
	if err != nil {
		return nil, fmt.Errorf("load rules: %w", err)
	}
	if err := pol.Validate(topo); err != nil {
		return nil, fmt.Errorf("invalid rules: %w", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		return nil, fmt.Errorf("build graph: %w", err)
	}

	limits := graph.DefaultLimits()
	if opts.MaxHops > 0 {
		limits.MaxHops = opts.MaxHops
	}
	if opts.MaxPaths > 0 {
		limits.MaxPaths = opts.MaxPaths
	}

	devices, err := compiler.Compile(topo, pol, g, limits)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}

	log.Debug("simulated flow", "src", opts.Flow.Src, "dst", opts.Flow.Dst)
	return simulate.Run(topo, devices, g, limits, pol.DefaultAction, opts.Flow)
}
```

- [ ] **Step 4: Run test to verify it passes + полный прогон**

Run: `go test ./internal/app/ -run TestSimulate -v && go build ./... && go vet ./... && gofmt -l .`
Expected: PASS; `gofmt -l` печатает пусто.

- [ ] **Step 5: Commit**

```bash
git add internal/app/simulate.go internal/app/simulate_test.go
git commit -m "feat(app): Simulate orchestration mirroring Compile pipeline"
```

---

### Task 4: HTTP эндпоинт `POST /api/simulate`

**Files:**
- Modify: `internal/httpapi/handlers.go` (новый метод `simulate` рядом с `compile`, импорты `encoding/json` уже есть, добавить `net/netip`, `github.com/kudes1/firenet/internal/rules`, `github.com/kudes1/firenet/internal/simulate`)
- Modify: `internal/httpapi/server.go:29` (регистрация маршрута после `POST /api/compile`)
- Test: `internal/httpapi/handlers_test.go` (новые тесты рядом с существующими)

**Interfaces:**
- Consumes: `app.Simulate`, `ProjectStore.ReadTopology/ReadSubnets/ReadRules`, `writeJSON/writeError`, фикстуры `fixtureTopology/fixtureSubnets/fixtureRules` и хелперы `newTestServer/doJSON/errorBody` из handlers_test.go.
- Produces: маршрут `POST /api/simulate`; тело `{src, dst, proto?, srcPorts?, dstPorts?}` → JSON `simulate.Report`; ошибки → `422 {"error": ...}`.

- [ ] **Step 1: Write the failing test**

В конец `handlers_test.go`:

```go
func TestSimulateHandler(t *testing.T) {
	h, _ := newTestServer(t)

	t.Run("allowed flow reports matched rule", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/simulate",
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"443"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var rep simulate.Report
		if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" || len(rep.Paths) != 1 {
			t.Fatalf("unexpected report: %+v", rep)
		}
		if rep.Paths[0].Verdict != rules.ActionAllow || rep.Paths[0].Routers[0].MatchedRule != "office-to-dmz" {
			t.Fatalf("unexpected verdict: %+v", rep.Paths[0])
		}
	})

	t.Run("invalid IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/simulate", map[string]any{"src": "nonsense", "dst": "10.0.1.7"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "src") {
			t.Fatalf("error should mention src, got %q", msg)
		}
	})

	t.Run("unknown IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/simulate", map[string]any{"src": "10.0.0.5", "dst": "192.168.99.99"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "не принадлежит") {
			t.Fatalf("error should explain unknown IP, got %q", msg)
		}
	})

	t.Run("bad proto is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/simulate", map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "sctp"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
	})
}
```

Проверить сигнатуру `doJSON` по файлу (если она отличается — подстроить вызовы, не хелпер). Добавить в импорты теста `"github.com/kudes1/firenet/internal/rules"` и `"github.com/kudes1/firenet/internal/simulate"` если их ещё нет.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/httpapi/ -run TestSimulateHandler -v`
Expected: FAIL — 404 (маршрут отсутствует).

- [ ] **Step 3: Write minimal implementation**

В `handlers.go` после метода `compile`:

```go
type simulateRequest struct {
	Src      string   `json:"src"`
	Dst      string   `json:"dst"`
	Proto    string   `json:"proto"`
	SrcPorts []string `json:"srcPorts"`
	DstPorts []string `json:"dstPorts"`
}

var simulateProtos = map[string]bool{"": true, "tcp": true, "udp": true, "icmp": true}

func (h *handlers) simulate(w http.ResponseWriter, r *http.Request) {
	var req simulateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid body: %w", err))
		return
	}
	if !simulateProtos[req.Proto] {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid proto %q", req.Proto))
		return
	}
	src, err := netip.ParseAddr(req.Src)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid src IP: %w", err))
		return
	}
	dst, err := netip.ParseAddr(req.Dst)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, fmt.Errorf("invalid dst IP: %w", err))
		return
	}

	topoRaw, err := h.store.ReadTopology()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	subnetsRaw, err := h.readStoredSubnets()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	rulesRaw, err := h.store.ReadRules()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	rep, err := app.Simulate(r.Context(), h.log, app.SimulateOptions{
		TopologyYAML: topoRaw,
		SubnetsYAML:  subnetsRaw,
		RulesYAML:    rulesRaw,
		Flow: simulate.Flow{
			Src:      src,
			Dst:      dst,
			Proto:    rules.Proto(req.Proto),
			SrcPorts: req.SrcPorts,
			DstPorts: req.DstPorts,
		},
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}
```

В `server.go` после строки `mux.HandleFunc("POST /api/compile", h.compile)`:

```go
	mux.HandleFunc("POST /api/simulate", h.simulate)
```

- [ ] **Step 4: Run test to verify it passes + полный прогон**

Run: `go test ./internal/httpapi/ -v && go vet ./... && gofmt -l .`
Expected: PASS; gofmt пусто.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/handlers.go internal/httpapi/server.go internal/httpapi/handlers_test.go
git commit -m "feat(httpapi): POST /api/simulate endpoint"
```

---

### Task 5: выделение `netmap.js` из `topology.js`

Behavior-preserving рефакторинг: чистые помощники отрисовки переезжают в общий модуль `NetMap`; интерактивная логика остаётся в `topology.js`. Регресс проверяется существующими тестами **без правок ассертов** (меняются только списки загружаемых скриптов в песочницах).

**Files:**
- Create: `internal/httpapi/web/netmap.js`
- Modify: `internal/httpapi/web/topology.js` (удалить перенесённые определения, добавить деструктуризацию)
- Modify: `internal/httpapi/web/topology_render.test.js:81`, `internal/httpapi/web/topology_search.test.js` (список скриптов песочницы: добавить `netmap.js` перед `topology.js`)
- Test: существующие `topology_render.test.js` / `camera.test.js` / `topology_search.test.js` (запуск без правок ассертов)

**Interfaces:**
- Produces: глобальный `NetMap` с полями `{ SVG_NS, DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_PAD, UNION_COLORS, KINDS, el, nameSummary, cloudPath, center, linkOffsets, spreadOffset, pointAt }`. Используется `topology.js` (Task 5) и `simulate.js` (Task 6).

- [ ] **Step 1: Create `netmap.js`**

Перенести дословно (тела функций копировать из topology.js без изменений): константы `SVG_NS, DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_PAD, UNION_COLORS, KINDS` (строки 17–33 topology.js) и функции `el` (91–96), `center` (122–126), `linkOffsets` (663–671), `spreadOffset` (673–676), `pointAt` (678–683). Скелет:

```js
"use strict";

// NetMap — общие чистые помощники отрисовки топологии: константы геометрии
// узлов и фабрика SVG-элементов. Используется интерактивной картой
// (topology.js) и статической картой страницы симуляции (simulate.js).
// Состояния страницы здесь нет.
const NetMap = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEVICE_W = 140;
  const DEVICE_H = 60;
  const NET_W = 160;
  const NET_H = 60;
  const UNION_PAD = 30;
  // палитра различимых оттенков; цвет = порядок объединения в документе
  const UNION_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
  const KINDS = {
    router: { rx: 16, glyph: "M2.5 6a3.5 3.5 0 1 1 0 .01M9 3.5h3m0 0-1.4-1.4M12 3.5l-1.4 1.4M9 8.5h3m0 0-1.4-1.4M12 8.5l-1.4 1.4" },
    switch: { rx: 2, glyph: "M1 4h10m0 0-2-2m2 2-2 2M11 8H1m0 0 2-2m-2 2 2 2" },
  };

  function el(tag, attrs, text) { /* тело из topology.js:91 */ }
  function center(map, name, w, h) { /* тело из topology.js:122 */ }
  function linkOffsets(links) { /* тело из topology.js:663 */ }
  function spreadOffset(index) { /* тело из topology.js:673 */ }
  function pointAt(a, b, t, offset) { /* тело из topology.js:678 */ }

  return Object.freeze({ SVG_NS, DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_PAD, UNION_COLORS, KINDS, el, center, linkOffsets, spreadOffset, pointAt });
})();
```

(`cloudPath`/`nameSummary` НЕ переносить — они нужны только интерактивной странице? Нет: проверить grep — если используются только в topology.js, оставить там; решение по факту grep. По коду они используются только в render() topology.js, поэтому остаются.)

Уточнение: переносить только то, что реально нужно обеим страницам: `SVG_NS, DEVICE_W/H, NET_W/H, UNION_COLORS, KINDS, el, center, linkOffsets, spreadOffset, pointAt`. `UNION_PAD/cloudPath/nameSummary` остаются в topology.js, если grep покажет использование только там.

- [ ] **Step 2: Update `topology.js`**

Внутри IIFE `Topology` сразу после `const Topology = (() => {` добавить:

```js
  const { SVG_NS, DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_COLORS, KINDS, el, center, linkOffsets, spreadOffset, pointAt } = NetMap;
```

и удалить перенесённые локальные определения. Определения `deviceCenter/netCenter` оставить как есть — они вызывают теперь общий `center`. Если grep найдёт использования `UNION_PAD/cloudPath/nameSummary` вне topology.js — перенести и их аналогично.

- [ ] **Step 3: Update test harnesses**

В `topology_render.test.js:81` и аналогичном месте `topology_search.test.js`:

```js
  for (const f of ["common.js", "camera.js", "netmap.js", "topology.js"]) {
```

Ассерты не трогать.

- [ ] **Step 4: Run JS tests**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: все тесты PASS без правок ассертов.

- [ ] **Step 5: Go-проверка и commit**

Run: `go build ./... && gofmt -l .` (embed меняет набор файлов).

```bash
git add internal/httpapi/web/netmap.js internal/httpapi/web/topology.js internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js
git commit -m "refactor(web): extract shared NetMap drawing helpers from topology.js"
```

---

### Task 6: страница `/ui/simulate` (форма, отчёт, карта с подсветкой)

**Files:**
- Create: `internal/httpapi/web/simulate.html`
- Create: `internal/httpapi/web/simulate.js`
- Modify: `internal/httpapi/web/common.js:195-216` (`NAV_LINKS` + `NAV_ICONS`)
- Modify: `internal/httpapi/web/style.css` (классы отчёта и подсветки)
- Modify: `internal/httpapi/server.go:46` (маршрут `GET /ui/simulate`)
- Test: `internal/httpapi/web/simulate_page.test.js` (новый)

**Interfaces:**
- Consumes: `POST /api/simulate` (Task 4), `GET /api/topology|/api/subnets|/api/layout`, `Api.get/post` и `showBanner` из common.js, `Camera.create/screenToWorld/transform` из camera.js, `NetMap.el/KINDS/центры/linkOffsets/spreadOffset/pointAt` из netmap.js.
- Produces: страница «Симуляция» в навигации (`id: "simulate"`).

- [ ] **Step 1: Write the failing test**

`internal/httpapi/web/simulate_page.test.js` — по образцу `sets_page.test.js` (VM-sandbox с DOM-заглушками, загрузка `common.js`, `camera.js`, `netmap.js`, `simulate.js`; внутренности доставать через `vm.runInContext`):

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  // взять целиком рабочую реализацию из sets_page.test.js (тот же паттерн
  // DOM-заглушек: classList/attrs/children/listeners) — здесь не дублируется
}
```

Заглушку `makeEl` и каркас песочницы берём из существующих тестов, не изобретая заново. Ниже — только сами тесты:

```js
function bootSimulate(responses) {
  // каркас как в sets_page.test.js/bootTopology: doc.getElementById возвращает
  // заглушки по id ("sim-canvas" -> svg-заглушка), fetch отдаёт responses[path];
  // скрипты: common.js, camera.js, netmap.js, simulate.js
  ...
}

const sampleReport = {
  srcSubnet: "office",
  dstSubnet: "dmz",
  note: "stateless",
  paths: [
    {
      nodes: [{ kind: 1, name: "office" }, { kind: 0, name: "r1" }, { kind: 0, name: "r2" }, { kind: 1, name: "dmz" }],
      routers: [
        { router: "r1", action: "allow", matchedRule: "office-to-dmz", reason: "..." },
        { router: "r2", action: "allow", matchedRule: "office-to-dmz", reason: "..." },
      ],
      verdict: "allow",
    },
  ],
};

test("renderReport builds one card per path with verdict badges", () => {
  const { get, ids } = bootSimulate({});
  get(`Simulate.renderReport(${JSON.stringify(sampleReport)})`);
  const cards = ids["sim-paths"].children.filter((c) => c.className === "sim-path");
  assert.equal(cards.length, 1);
  const html = JSON.stringify(ids["sim-paths"]);
  assert.match(html, /badge-ok/);
  assert.match(html, /office-to-dmz/);
});

test("unreachable report renders explicit message", () => {
  const { get, ids } = bootSimulate({});
  get(`Simulate.renderReport(${JSON.stringify({ srcSubnet: "office", dstSubnet: "isolated", note: "", paths: [] })})`);
  assert.match(JSON.stringify(ids["sim-paths"]), /недостижим/);
});
```

Имена id/классов (`sim-canvas`, `sim-paths`, `badge-ok`, `sim-path`) — контракт между этим тестом, `simulate.js` и `simulate.html`; менять только согласованно. Каркас `bootSimulate` собрать по образцу `bootTopology` из `topology_render.test.js` (тот же `makeEl`, тот же паттерн `responses[p] ?? null` для fetch, список скриптов `["common.js","camera.js","netmap.js","simulate.js"]`, DOMContentLoaded-диспетч не нужен если `simulate.js` экспортирует `Simulate.renderReport` и не стартует boot автоматически до готовности формы — авто-boot как в topology.js, тест вызывает только renderReport напрямую).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test internal/httpapi/web/simulate_page.test.js`
Expected: FAIL — `Simulate is not defined`.

- [ ] **Step 3: Implement `simulate.html`, `simulate.js`, nav, route, CSS**

`internal/httpapi/web/simulate.html`:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>firenet — симуляция</title>
<script>
  try {
    var saved = localStorage.getItem("firenet-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="simulate" x-data="appData()" @notify.window="showBanner($event.detail.message, $event.detail.kind)">

<main>
  <div class="sim-layout">
    <section class="sim-form-panel">
      <h1>Симуляция трафика</h1>
      <form id="sim-form">
        <label>Источник (IP)
          <input id="sim-src" placeholder="10.0.0.5" autocomplete="off" spellcheck="false" required>
        </label>
        <label>Назначение (IP)
          <input id="sim-dst" placeholder="10.0.1.7" autocomplete="off" spellcheck="false" required>
        </label>
        <label>Протокол
          <select id="sim-proto">
            <option value="">любой</option>
            <option value="tcp">tcp</option>
            <option value="udp">udp</option>
            <option value="icmp">icmp</option>
          </select>
        </label>
        <label>Порты назначения (через запятую)
          <input id="sim-dstports" placeholder="443, 8080" autocomplete="off" spellcheck="false">
        </label>
        <button type="submit" class="primary">Симулировать</button>
      </form>
      <section id="sim-summary" hidden></section>
      <section id="sim-paths"></section>
    </section>
    <div class="canvas-wrap">
      <svg id="sim-canvas"></svg>
    </div>
  </div>
</main>

<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
<script src="/camera.js"></script>
<script src="/netmap.js"></script>
<script src="/simulate.js"></script>
</body>
</html>
```

`internal/httpapi/web/simulate.js`:

```js
"use strict";

const Simulate = (() => {
  const state = { topology: null, subnets: [], layout: null, camera: Camera.create(), result: null };

  const svgEl = () => document.getElementById("sim-canvas");

  function ensureLayout() {
    state.topology.devices.forEach((d, i) => {
      if (!state.layout.devices[d.name]) state.layout.devices[d.name] = { x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 160 };
    });
    state.topology.networks.forEach((n, i) => {
      if (!state.layout.networks[n.name]) state.layout.networks[n.name] = { x: 40 + (i % 5) * 200, y: 300 + Math.floor(i / 5) * 160 };
    });
  }

  function highlightSet(report) {
    if (!report || !report.paths.length) return null;
    const names = new Set();
    report.paths.forEach((p) => p.nodes.forEach((n) => names.add(n.name)));
    return names;
  }

  function renderMap() {
    ensureLayout();
    const svg = svgEl();
    svg.innerHTML = "";
    const viewport = NetMap.el("g", { class: "viewport", transform: Camera.transform(state.camera) });
    svg.append(viewport);
    const hl = highlightSet(state.result);
    const dim = (name) => (hl ? (hl.has(name) ? "" : " sim-dim") : "");
    const devC = (name) => NetMap.center(state.layout.devices, name, NetMap.DEVICE_W, NetMap.DEVICE_H);
    const netC = (name) => NetMap.center(state.layout.networks, name, NetMap.NET_W, NetMap.NET_H);

    const offsets = NetMap.linkOffsets(state.topology.links);
    state.topology.links.forEach((l, i) => {
      const pa = devC(l.a.device), pb = devC(l.b.device);
      if (!pa || !pb) return;
      const mid = NetMap.pointAt(pa, pb, 0.5, NetMap.spreadOffset(offsets[i]));
      const d = `M ${pa.x} ${pa.y} Q ${mid.x} ${mid.y} ${pb.x} ${pb.y}`;
      viewport.append(NetMap.el("path", {
        class: "wire" + (l.filter ? " wire-filtered" : "") + ((hl && !(hl.has(l.a.device) && hl.has(l.b.device))) ? " sim-dim" : ""),
        d, fill: "none",
      }));
    });

    state.topology.networks.forEach((n) => {
      (n.attach || []).forEach((a) => {
        const pa = devC(a.device), c = netC(n.name);
        if (!pa || !c) return;
        viewport.append(NetMap.el("line", {
          class: "wire" + ((hl && !(hl.has(n.name) && hl.has(a.device))) ? " sim-dim" : ""),
          x1: pa.x, y1: pa.y, x2: c.x, y2: c.y,
        }));
      });
    });

    state.topology.devices.forEach((d) => {
      const pos = state.layout.devices[d.name];
      const kind = NetMap.KINDS[d.kind] || { rx: 6 };
      viewport.append(NetMap.el("rect", { class: "node-rect " + d.kind + dim(d.name), x: pos.x, y: pos.y, width: NetMap.DEVICE_W, height: NetMap.DEVICE_H, rx: kind.rx }));
      if (kind.glyph) {
        viewport.append(NetMap.el("path", { class: "node-glyph " + d.kind + dim(d.name), d: kind.glyph, transform: `translate(${pos.x + 8} ${pos.y + 8})` }));
        viewport.append(NetMap.el("text", { class: "node-label" + dim(d.name), x: pos.x + 24, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      } else {
        viewport.append(NetMap.el("text", { class: "node-label" + dim(d.name), x: pos.x + 8, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      }
    });

    state.topology.networks.forEach((n) => {
      const pos = state.layout.networks[n.name];
      viewport.append(NetMap.el("path", { class: "subnet-rect" + dim(n.name), d: cloudPathFor(pos) }));
      viewport.append(NetMap.el("text", { class: "subnet-label" + dim(n.name), x: pos.x + 8, y: pos.y + 18 }, n.name));
      const members = (n.subnets || []).map((s) => state.subnets.find((x) => x.name === s)).filter(Boolean);
      const subtitle = members.length ? members.map((s) => s.cidr).join(", ") : "(нет подсетей)";
      viewport.append(NetMap.el("text", { class: "link-label-text" + dim(n.name), x: pos.x + 8, y: pos.y + 36 }, subtitle));
    });
  }

  // локальная копия облачного контура L2-сегмента (визуальный элемент карты)
  function cloudPathFor(pos) { /* тело cloudPath из topology.js:49 с x=pos.x,y=pos.y,w=NET_W,h=NET_H */ }

  const BADGE = { allow: "badge-ok", deny: "badge-drop" };
  const badgeClass = (action) => BADGE[action] || "badge-default";

  function chip(node) {
    const span = document.createElement("span");
    span.className = node.kind === 0 ? "sim-chip sim-chip-router" : "sim-chip";
    span.textContent = node.name;
    return span;
  }

  function renderReport(report) {
    const host = document.getElementById("sim-paths");
    host.innerHTML = "";
    state.result = report;
    const summary = document.getElementById("sim-summary");
    summary.hidden = false;
    summary.textContent = `${report.srcSubnet} → ${report.dstSubnet}: путей ${report.paths.length}. ${report.note}`;
    renderMap();
    if (!report.paths.length) {
      const p = document.createElement("p");
      p.className = "sim-unreachable";
      p.textContent = "Недостижимо: путей между подсетями нет.";
      host.append(p);
      return;
    }
    report.paths.forEach((path, i) => {
      const card = document.createElement("article");
      card.className = "sim-path";
      const head = document.createElement("header");
      const verdict = document.createElement("span");
      verdict.className = "badge " + badgeClass(path.verdict);
      verdict.textContent = path.verdict === "deny" ? "запрещено" : "разрешено";
      head.append(verdict);
      const title = document.createElement("strong");
      title.textContent = `Путь ${i + 1}`;
      head.append(title);
      card.append(head);
      if (path.note) {
        const note = document.createElement("p");
        note.className = "sim-note";
        note.textContent = path.note;
        card.append(note);
      }
      const chain = document.createElement("p");
      chain.className = "sim-chain";
      path.nodes.forEach((n, j) => {
        if (j) chain.append(Object.assign(document.createElement("span"), { className: "sim-arrow", textContent: "→" }));
        chain.append(chip(n));
      });
      card.append(chain);
      path.routers.forEach((rv) => {
        const row = document.createElement("details");
        const sum = document.createElement("summary");
        const b = document.createElement("span");
        b.className = "badge " + badgeClass(rv.action);
        b.textContent = rv.action === "deny" ? "drop" : rv.action === "allow" ? "accept" : rv.action;
        sum.append(b, Object.assign(document.createElement("span"), { textContent: ` ${rv.router}` }));
        row.append(sum);
        const body = document.createElement("p");
        body.textContent = rv.reason + (rv.matchedRule ? ` (правило: ${rv.matchedRule})` : "");
        row.append(body);
        card.append(row);
      });
      host.append(card);
    });
  }

  async function run(ev) {
    ev.preventDefault();
    const ports = document.getElementById("sim-dstports").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const report = await Api.post("/api/simulate", {
        src: document.getElementById("sim-src").value.trim(),
        dst: document.getElementById("sim-dst").value.trim(),
        proto: document.getElementById("sim-proto").value,
        dstPorts: ports,
      });
      renderReport(report);
    } catch (e) {
      showBanner("Ошибка симуляции: " + e.message);
    }
  }

  async function boot() {
    try {
      const [topo, subnetsDoc, layout] = await Promise.all([
        Api.get("/api/topology"), Api.get("/api/subnets"), Api.get("/api/layout"),
      ]);
      state.topology = topo;
      state.subnets = subnetsDoc.subnets || [];
      state.layout = { devices: layout.devices || {}, networks: layout.networks || layout.subnets || {} };
      if (!(layout.camera && layout.camera.z > 0)) state.camera = Camera.create();
      else state.camera = { ...Camera.create(), ...layout.camera };
      renderMap();
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    document.getElementById("sim-form").addEventListener("submit", run);
  }

  const Simulate = { boot, renderReport, run, state };
  return Simulate;
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", Simulate.boot);
} else {
  Simulate.boot();
}
```

Примечания к коду выше:
- `Api.post(url, body)` — проверить точное имя метода в common.js (`Api.put` существует; если post нет — добавить `post` рядом по образцу `put`);
- `chip()` использует числовые `NodeKind` (0=router, 1=subnet, 2=domain) из `graph.NodeKind`;
- `cloudPathFor` — единственная локальная копия отрисовки облака; допустимо (чистая функция от bbox), чтобы не тащить зависимость от internals topology.js.

`common.js`: в `NAV_LINKS` после строки про compile добавить:

```js
  { id: "simulate", href: "/ui/simulate", label: "Симуляция" },
```

в `NAV_ICONS`:

```js
  simulate: svgOpen + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
```

`server.go` после `GET /ui/compile`:

```go
	mux.HandleFunc("GET /ui/simulate", servePage("simulate.html"))
```

`style.css` — добавить блок:

```css
/* — симуляция трафика — */
.sim-layout { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: var(--space-3); align-items: start; }
.sim-form-panel form { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.sim-path { border: 1px solid var(--border); border-radius: 8px; padding: var(--space-2); margin-bottom: var(--space-2); }
.sim-chain { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; }
.sim-chip { border: 1px solid var(--border); border-radius: 999px; padding: 0 var(--space-2); font-size: 0.85em; }
.sim-chip-router { background: color-mix(in srgb, var(--accent) 15%, transparent); }
.sim-arrow { opacity: 0.5; }
.badge { display: inline-block; border-radius: 4px; padding: 0 6px; font-size: 0.8em; }
.badge-ok { background: rgba(16, 185, 129, 0.18); color: #10b981; }
.badge-drop { background: rgba(239, 68, 68, 0.18); color: #ef4444; }
.badge-default { background: rgba(148, 163, 184, 0.2); color: inherit; }
.sim-dim { opacity: 0.25; }
.sim-unreachable { color: #ef4444; }
.sim-note { opacity: 0.75; font-size: 0.85em; }
```

(имена CSS-переменных сверить со style.css; если `--accent/--border` называются иначе — использовать существующие.)

- [ ] **Step 4: Run tests + rebuild**

Run: `node --test 'internal/httpapi/web/*.test.js' && go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: всё PASS (sidebar.test.js должен пройти без изменений; если он перечисляет ссылки явно — дополнить ожидаемый список записью `simulate`).
Для живой проверки UI: `make build && ./bin/firenet serve` (или как называется бинарь) — открыть `/ui/simulate`. Полный браузерный прогон по AGENTS.md не требуется.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/simulate.html internal/httpapi/web/simulate.js internal/httpapi/web/simulate_page.test.js internal/httpapi/web/common.js internal/httpapi/web/style.css internal/httpapi/server.go
git commit -m "feat(web): traffic simulation page with topology map highlighting"
```

---

### Task 7: финальная верификация

- [ ] **Step 1: Полная проверка по AGENTS.md**

```bash
go build ./...
go vet ./...
gofmt -l .
go test ./...
node --test 'internal/httpapi/web/*.test.js'
```

Expected: всё зелёное, gofmt печатает пусто.

- [ ] **Step 2: Пересборка бинарника (embed)**

```bash
make build
```

- [ ] **Step 3: Commit (если остались незакоммиченные изменения)**

```bash
git status --porcelain
```

Expected: пусто (все задачи закоммичены ранее).

## Self-Review

- Spec coverage: ядро (Task 1–3), HTTP (Task 4), карта/refactor netmap (Task 5), UI+подсветка (Task 6), ошибки 422/недостижимость/L2/stateless — Tasks 2, 4, 6; conntrack-замечание — `StatelessNote` в Task 2. CLI сознательно нет (спека). ✓
- Placeholders: тела `cloudPath/el/center/...` в Task 5/6 даны ссылками на дословный источник строк — это перемещение кода, не «TBD». Заготовка makeEl в Task 6 Step 1 помечена «взять целиком из sets_page.test.js». ✓
- Type consistency: `simulate.Flow/Report/PathResult/RouterVerdict` согласованы между Task 2 (определение), Task 3 (оркестрация), Task 4 (хендлер), Task 6 (JS-контракт: `srcSubnet/dstSubnet/note/paths/routers/action/matchedRule/reason/verdict`). `NetMap`-поля согласованы между Task 5 и 6. ✓
