# Additional Chains (jump) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разрешить в политике несколько iptables-цепочек и действие `jump` для перехода между ними.

**Architecture:** `rules.Policy` становится списком цепочек (`Chains []Chain`); компилятор прогоняет правила всех цепочек через существующий placement и гарантирует существование целевых цепочек прыжков на устройстве; рендер создаёт все цепочки, jump в FORWARD — только у главной; симулятор ходит по цепочкам с возвратом по `return`.

**Tech Stack:** Go 1.23, gopkg.in/yaml.v3, node:test + DOM-стабы (фронтенд-тесты).

**Spec:** `docs/superpowers/specs/2026-08-23-additional-chains-design.md`

## Global Constraints

- Верификация после каждой задачи, строго в этом порядке: `go build ./...`, `go vet ./...`, `gofmt -l .` (должен печатать пусто), `go test ./...`.
- Фронтенд-тесты: `node --test 'internal/httpapi/web/*.test.js'` (glob обязателен).
- Никаких комментариев в коде, кроме тех, что уже есть в плане как часть кода.
- Компактный стиль, переиспользование существующих хелперов.
- Обратная совместимость: старый плоский формат `rules.yaml` (top-level `defaultAction/chainName/chainPosition/rules`) читается всегда; пишется только новый формат (`chains:`).
- Семантика: `jump` → iptables `-j` (возврат возможен), дефолт/правило `return` доп. цепочки возвращает трафик в вызывающую цепочку; `ChainPosition` допустим только у первой цепочки.
- Имена цепочек: тот же regex, что сейчас (`^[A-Za-z0-9_-]{1,28}$`, `rules.chainNameRE`).

---

### Task 1: Модель правил — Chains + JumpTo (+ механическая адаптация потребителей)

Единственная задача, где модель меняется атомарно. `DeviceRuleset` пока не трогаем (остаётся плоским) — компилятор/рендер/симулятор работают с первой (главной) цепочкой, как раньше. Мультицепочность появляется в Task 2–3.

**Files:**
- Modify: `internal/rules/model.go`
- Modify: `internal/rules/load.go`
- Modify: `internal/rules/validate.go`
- Modify: `internal/rules/load_test.go`, `internal/rules/validate_test.go`
- Modify (механически): `internal/compiler/compiler.go:177,295-297`, `internal/app/deps.go:88`

**Interfaces:**
- Produces: `rules.ActionJump Action = "jump"`; `rules.Chain{Name string, DefaultAction Action, ChainPosition ChainPosition, Rules []Rule}`; `Rule.JumpTo string`; `Policy.Chains []Chain`; `(*Policy).Primary() *Chain`. Все потребители дальше используют только эти имена.

- [ ] **Step 1: model.go — новые типы**

Заменить `Policy` и добавить константу/тип:

```go
const (
	ActionAllow  Action = "allow"
	ActionDeny   Action = "deny"
	ActionReturn Action = "return"
	ActionJump   Action = "jump"
)
```

```go
// Rule matches traffic between named subnets/zones (or Any). Src/Dst are
// OR-lists: any name in Src combined with any name in Dst matches.
type Rule struct {
	Name     string
	Comment  string // free-form description rendered into iptables --comment; falls back to Name
	Src      []string
	Dst      []string
	Proto    Proto
	SrcPorts []string // "80" or "1000-2000"; only meaningful for tcp/udp
	DstPorts []string // "80" or "1000-2000"; only meaningful for tcp/udp
	Action   Action
	JumpTo   string // target chain name; required iff Action == ActionJump
	Mirror   bool   // at compile time, also match traffic in the reverse direction (Dst->Src)
}

// Chain is one named iptables chain with its own ordered rules and default.
type Chain struct {
	Name          string
	DefaultAction Action
	ChainPosition ChainPosition // meaningful only for the first policy chain
	Rules         []Rule        // priority order: first match wins, like iptables
}

// Policy is the full rule set as an ordered list of chains. The first chain
// is the primary one: its jump is wired into FORWARD.
type Policy struct {
	Chains []Chain
}

// Primary returns the first chain, the only one jumped into from FORWARD.
func (p *Policy) Primary() *Chain {
	if len(p.Chains) == 0 {
		return nil
	}
	return &p.Chains[0]
}
```

Убрать старые поля `Policy{DefaultAction, ChainName, ChainPosition, Rules}` и `Rule.Action`-комментарий про три действия поправить при случае.

- [ ] **Step 2: load.go — два формата**

```go
package rules

import (
	"bytes"
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

type yamlRule struct {
	Name     string   `yaml:"name"`
	Comment  string   `yaml:"comment,omitempty"`
	Src      []string `yaml:"src"`
	Dst      []string `yaml:"dst"`
	Proto    string   `yaml:"proto"`
	SrcPorts []string `yaml:"srcPorts,omitempty"`
	DstPorts []string `yaml:"dstPorts,omitempty"`
	Action   string   `yaml:"action"`
	JumpTo   string   `yaml:"jumpTo,omitempty"`
	Mirror   bool     `yaml:"mirror,omitempty"`
}

type yamlChain struct {
	Name          string     `yaml:"name"`
	DefaultAction string     `yaml:"defaultAction"`
	ChainPosition string     `yaml:"chainPosition,omitempty"`
	Rules         []yamlRule `yaml:"rules"`
}

type yamlPolicyModern struct {
	Chains []yamlChain `yaml:"chains"`
}

// yamlPolicyLegacy is the pre-chains flat document shape.
type yamlPolicyLegacy struct {
	DefaultAction string     `yaml:"defaultAction"`
	ChainName     string     `yaml:"chainName,omitempty"`
	ChainPosition string     `yaml:"chainPosition,omitempty"`
	Rules         []yamlRule `yaml:"rules"`
}

// Load decodes a rules.yaml document in either the chains format or the
// legacy flat format (read as a single primary chain). It does not call Validate.
func Load(r io.Reader) (*Policy, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read rules yaml: %w", err)
	}
	if pol, ok := decodeModern(raw); ok {
		return pol, nil
	}
	return decodeLegacy(raw)
}

func decodeModern(raw []byte) (*Policy, bool) {
	var ym yamlPolicyModern
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&ym); err != nil || len(ym.Chains) == 0 {
		return nil, false
	}
	pol := &Policy{}
	for i, c := range ym.Chains {
		ch := Chain{
			Name:          c.Name,
			DefaultAction: Action(c.DefaultAction),
			ChainPosition: ChainPosition(c.ChainPosition),
		}
		if ch.DefaultAction == "" {
			ch.DefaultAction = ActionDeny
		}
		if i == 0 {
			if ch.Name == "" {
				ch.Name = DefaultChainName
			}
			if ch.ChainPosition == "" {
				ch.ChainPosition = ChainTop
			}
		}
		ch.Rules = decodeRules(c.Rules)
		pol.Chains = append(pol.Chains, ch)
	}
	return pol, true
}

func decodeLegacy(raw []byte) (*Policy, error) {
	var yl yamlPolicyLegacy
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&yl); err != nil {
		return nil, fmt.Errorf("decode rules yaml: %w", err)
	}
	def := Action(yl.DefaultAction)
	if def == "" {
		def = ActionDeny
	}
	pos := ChainPosition(yl.ChainPosition)
	if pos == "" {
		pos = ChainTop
	}
	name := yl.ChainName
	if name == "" {
		name = DefaultChainName
	}
	return &Policy{Chains: []Chain{{
		Name:          name,
		DefaultAction: def,
		ChainPosition: pos,
		Rules:         decodeRules(yl.Rules),
	}}}, nil
}

func decodeRules(in []yamlRule) []Rule {
	var out []Rule
	for _, r := range in {
		proto := Proto(r.Proto)
		if proto == "" {
			proto = ProtoAny
		}
		out = append(out, Rule{
			Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
			Proto: proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
			Action: Action(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
		})
	}
	return out
}
```

- [ ] **Step 3: validate.go — пер-цепочечная валидация + прыжки**

Переписать `Validate` (хелперы `validEndpoint`, `validatePortList`, `validatePortSpec`, `chainNameRE` остаются):

```go
// Validate checks every chain's rules and the jump graph between chains.
func (p *Policy) Validate(topo *topology.Topology) error {
	if len(p.Chains) == 0 {
		return fmt.Errorf("policy must declare at least one chain")
	}
	chainNames := make(map[string]struct{}, len(p.Chains))
	ruleNames := make(map[string]struct{})
	for i := range p.Chains {
		c := &p.Chains[i]
		where := fmt.Sprintf("chain[%d]", i)
		if !chainNameRE.MatchString(c.Name) {
			return fmt.Errorf("%s: invalid name %q", where, c.Name)
		}
		if _, dup := chainNames[c.Name]; dup {
			return fmt.Errorf("%s: duplicate chain name %q", where, c.Name)
		}
		chainNames[c.Name] = struct{}{}
		switch c.DefaultAction {
		case ActionAllow, ActionDeny, ActionReturn:
		default:
			return fmt.Errorf("%s %q: invalid defaultAction %q", where, c.Name, c.DefaultAction)
		}
		if i > 0 && c.ChainPosition != "" {
			return fmt.Errorf("%s %q: chainPosition is only valid on the first chain", where, c.Name)
		}
		for j, r := range c.Rules {
			if err := validateRule(topo, ruleNames, c.Name, r); err != nil {
				return fmt.Errorf("%s rule[%d]: %w", where, j, err)
			}
		}
	}
	return validateJumps(p, chainNames)
}

func validateRule(topo *topology.Topology, ruleNames map[string]struct{}, chain string, r Rule) error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if _, dup := ruleNames[r.Name]; dup {
		return fmt.Errorf("duplicate name %q", r.Name)
	}
	ruleNames[r.Name] = struct{}{}
	if len(r.Src) == 0 || len(r.Dst) == 0 {
		return fmt.Errorf("rule %q: src and dst must not be empty", r.Name)
	}
	for _, s := range r.Src {
		if !validEndpoint(topo, s) {
			return fmt.Errorf("rule %q: unknown src %q", r.Name, s)
		}
	}
	for _, d := range r.Dst {
		if !validEndpoint(topo, d) {
			return fmt.Errorf("rule %q: unknown dst %q", r.Name, d)
		}
	}
	switch r.Proto {
	case ProtoAny, ProtoTCP, ProtoUDP, ProtoICMP:
	default:
		return fmt.Errorf("rule %q: invalid proto %q", r.Name, r.Proto)
	}
	if (len(r.SrcPorts) > 0 || len(r.DstPorts) > 0) && r.Proto != ProtoTCP && r.Proto != ProtoUDP {
		return fmt.Errorf("rule %q: ports only valid for tcp/udp", r.Name)
	}
	if err := validatePortList(r.SrcPorts); err != nil {
		return fmt.Errorf("rule %q: %w", r.Name, err)
	}
	if err := validatePortList(r.DstPorts); err != nil {
		return fmt.Errorf("rule %q: %w", r.Name, err)
	}
	switch r.Action {
	case ActionAllow, ActionDeny, ActionReturn:
		if r.JumpTo != "" {
			return fmt.Errorf("rule %q: jumpTo is only valid with action jump", r.Name)
		}
	case ActionJump:
		if r.JumpTo == "" {
			return fmt.Errorf("rule %q: action jump requires jumpTo", r.Name)
		}
		if r.JumpTo == chain {
			return fmt.Errorf("rule %q: jump target must differ from the owning chain", r.Name)
		}
	default:
		return fmt.Errorf("rule %q: invalid action %q", r.Name, r.Action)
	}
	return nil
}

// validateJumps rejects jumps into unknown chains and cycles among them.
func validateJumps(p *Policy, chainNames map[string]struct{}) error {
	color := make(map[string]int) // 1 = in progress, 2 = done
	var visit func(name string, path []string) error
	visit = func(name string, path []string) error {
		switch color[name] {
		case 1:
			return fmt.Errorf("jump cycle: %s -> %s", strings.Join(path, " -> "), name)
		case 2:
			return nil
		}
		color[name] = 1
		for _, c := range p.Chains {
			if c.Name != name {
				continue
			}
			for _, r := range c.Rules {
				if r.Action != ActionJump {
					continue
				}
				if _, ok := chainNames[r.JumpTo]; !ok {
					return fmt.Errorf("rule %q: unknown jump target %q", r.Name, r.JumpTo)
				}
				if err := visit(r.JumpTo, append(path, name)); err != nil {
					return err
				}
			}
		}
		color[name] = 2
		return nil
	}
	for _, c := range p.Chains {
		if err := visit(c.Name, nil); err != nil {
			return err
		}
	}
	return nil
}
```

Добавить `"strings"` к импортам validate.go.

- [ ] **Step 4: механическая адаптация потребителей (build green)**

`internal/compiler/compiler.go`: в начале `Compile`:

```go
primary := pol.Primary()
```

цикл `for _, rule := range pol.Rules` → `for _, rule := range primary.Rules`; сборка `DeviceRuleset`:

```go
result = append(result, DeviceRuleset{
	Device:        name,
	IPSets:        a.ipsetList(topo),
	Rules:         a.rules,
	DefaultAction: primary.DefaultAction,
	ChainName:     primary.Name,
	ChainPosition: primary.ChainPosition,
})
```

`internal/app/deps.go` (`ruleDeps`): внешний цикл по цепочкам:

```go
for _, c := range pol.Chains {
	for _, r := range c.Rules {
		if slices.Contains(r.Src, name) || slices.Contains(r.Dst, name) {
			out = append(out, fmt.Sprintf("rule %q", r.Name))
		}
	}
}
```

- [ ] **Step 5: тесты internal/rules**

В `load_test.go` добавить:

```go
func TestLoadChainsFormat(t *testing.T) {
	in := `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - name: to-restricted
        src: [dangerous]
        dst: [any]
        action: jump
        jumpTo: FIRENET-RESTRICTED
  - name: FIRENET-RESTRICTED
    defaultAction: return
    rules:
      - name: restricted-dns
        src: [dangerous]
        dst: [dns]
        proto: udp
        dstPorts: ["53"]
        action: allow
`
	pol, err := Load(strings.NewReader(in))
	if err != nil { t.Fatal(err) }
	if len(pol.Chains) != 2 { t.Fatalf("chains = %d, want 2", len(pol.Chains)) }
	sub := pol.Primary().Rules[0]
	if sub.Action != ActionJump || sub.JumpTo != "FIRENET-RESTRICTED" {
		t.Fatalf("bad primary rule: %+v", sub)
	}
	if pol.Chains[1].DefaultAction != ActionReturn {
		t.Fatalf("second chain default = %q", pol.Chains[1].DefaultAction)
	}
}

func TestLoadLegacyFlatFormat(t *testing.T) {
	in := `
defaultAction: allow
chainName: MYCHAIN
chainPosition: bottom
rules:
  - name: web
    src: [office]
    dst: [web-srv]
    action: allow
`
	pol, err := Load(strings.NewReader(in))
	if err != nil { t.Fatal(err) }
	c := pol.Primary()
	if len(pol.Chains) != 1 || c.Name != "MYCHAIN" || c.DefaultAction != ActionAllow || c.ChainPosition != ChainBottom || len(c.Rules) != 1 {
		t.Fatalf("legacy load mismatch: %+v", pol)
	}
}
```

В `validate_test.go` добавить (topo-фикстура — как в соседних тестах файла):

```go
func TestValidateJumpErrors(t *testing.T) {
	topo := testTopology(t) // существующий хелпер файла; если его нет — минимальная topo с подсетями dangerous/dns
	cases := []struct {
		name, yaml string
	}{
		{"jump without target", "chains:\n  - name: A\n    rules:\n      - name: r\n        src: [dangerous]\n        dst: [dns]\n        action: jump\n"},
		{"jumpTo without jump", "chains:\n  - name: A\n    rules:\n      - name: r\n        src: [dangerous]\n        dst: [dns]\n        action: allow\n        jumpTo: B\n"},
		{"unknown target", "chains:\n  - name: A\n    rules:\n      - name: r\n        src: [dangerous]\n        dst: [dns]\n        action: jump\n        jumpTo: NOPE\n"},
		{"self jump", "chains:\n  - name: A\n    rules:\n      - name: r\n        src: [dangerous]\n        dst: [dns]\n        action: jump\n        jumpTo: A\n"},
		{"cycle", "chains:\n  - name: A\n    rules:\n      - name: r\n        src: [dangerous]\n        dst: [dns]\n        action: jump\n        jumpTo: B\n  - name: B\n    rules:\n      - name: q\n        src: [dangerous]\n        dst: [dns]\n        action: jump\n        jumpTo: A\n"},
		{"position on secondary", "chains:\n  - name: A\n    rules: []\n  - name: B\n    chainPosition: top\n    rules: []\n"},
		{"dup chain names", "chains:\n  - name: A\n    rules: []\n  - name: A\n    rules: []\n"},
		{"no chains", "defaultAction: deny\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pol, err := Load(strings.NewReader(tc.yaml))
			if err != nil { t.Fatal(err) }
			if err := pol.Validate(topo); err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
		})
	}
}

func TestValidateValidJumpChain(t *testing.T) {
	in := "chains:\n  - name: A\n    rules:\n      - name: r\n        src: [dangerous]\n        dst: [dns]\n        action: jump\n        jumpTo: B\n  - name: B\n    defaultAction: deny\n    rules:\n      - name: dns-ok\n        src: [dangerous]\n        dst: [dns]\n        proto: udp\n        dstPorts: [\"53\"]\n        action: allow\n"
	pol, err := Load(strings.NewReader(in))
	if err != nil { t.Fatal(err) }
	if err := pol.Validate(testTopology(t)); err != nil { t.Fatal(err) }
}
```

Существующие тесты, читающие `pol.DefaultAction/ChainName/ChainPosition/Rules`, портировать на `pol.Primary()` (те же утверждения, индекс `[0]`).

- [ ] **Step 6: запуск**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./internal/rules/... ./internal/compiler/... ./internal/app/... ./internal/render/... ./internal/simulate/... ./internal/httpapi/...`
Expected: всё зелёное, `gofmt -l .` пустой.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(rules): multi-chain policy model with jump action"
```

---

### Task 2: Компилятор и рендер — мультицепочечные DeviceRuleset

**Files:**
- Modify: `internal/compiler/model.go`
- Modify: `internal/compiler/compiler.go`
- Modify: `internal/compiler/compiler_test.go`
- Modify: `internal/render/iptables.go`
- Modify: `internal/render/iptables_test.go`

**Interfaces:**
- Consumes: `rules.Policy.Chains`, `Rule.JumpTo`, `ActionJump` (Task 1).
- Produces: `compiler.CompiledChain{Name string, Primary bool, Default rules.Action}`; `CompiledRule.Chain, JumpTo string` (новые поля); `DeviceRuleset{Device, IPSets, Chains []CompiledChain, Rules []CompiledRule}` (плоские поля удалены). Рендер и симулятор используют ровно это.

- [ ] **Step 1: failing tests компилятора**

В `compiler_test.go` (использовать существующие фикстуры topo/graph из файла) добавить:

```go
func TestCompileMultiChainPlacementAndTargetGuarantee(t *testing.T) {
	fix := compileFixture(t) // существующий хелпер: topo+graph; если называется иначе — взять как в файле
	pol := &rules.Policy{Chains: []rules.Chain{
		{
			Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop,
			Rules: []rules.Rule{{
				Name: "restrict", Src: []string{"src-sub"}, Dst: []string{"dst-sub"},
				Action: rules.ActionJump, JumpTo: "FIRENET-RESTRICTED",
			}},
		},
		{Name: "FIRENET-RESTRICTED", DefaultAction: rules.ActionDeny,
			Rules: []rules.Rule{{
				Name: "restricted-dns", Src: []string{"src-sub"}, Dst: []string{"dst-sub"},
				Proto: rules.ProtoUDP, DstPorts: []string{"53"}, Action: rules.ActionAllow,
			}},
		},
	}}
	devices, err := Compile(fix.topo, pol, fix.g, fix.limits)
	if err != nil { t.Fatal(err) }
	found := false
	for _, d := range devices {
		for _, r := range d.Rules {
			if r.JumpTo == "FIRENET-RESTRICTED" {
				found = true
				// guarantee: the target chain exists on every device that has a jump into it
				ok := false
				for _, ch := range d.Chains {
					if ch.Name == "FIRENET-RESTRICTED" { ok = true }
				}
				if !ok { t.Fatalf("device %s jumps to missing chain", d.Device) }
				if r.Chain != "FIRENET-FWD" { t.Fatalf("jump rule owner = %q", r.Chain) }
			}
		}
	}
	if !found { t.Fatal("no compiled jump rule") }
}

func TestCompileDedupKeepsDifferentChains(t *testing.T) {
	// одно и то же содержимое в двух цепочках не склеивается
	fix := compileFixture(t)
	same := rules.Rule{Name: "r", Src: []string{"src-sub"}, Dst: []string{"dst-sub"}, Action: rules.ActionAllow}
	pol := &rules.Policy{Chains: []rules.Chain{
		{Name: "A", DefaultAction: rules.ActionDeny, Rules: []rules.Rule{same}},
		{Name: "B", DefaultAction: rules.ActionReturn, Rules: []rules.Rule{same}},
	}}
	devices, err := Compile(fix.topo, pol, fix.g, fix.limits)
	if err != nil { t.Fatal(err) }
	for _, d := range devices {
		aCount, bCount := 0, 0
		for _, r := range d.Rules {
			switch r.Chain {
			case "A": aCount++
			case "B": bCount++
			}
		}
		if aCount != 1 || bCount != 1 {
			t.Fatalf("device %s: A=%d B=%d, want 1/1", d.Device, aCount, bCount)
		}
	}
}
```

Имена подсетей `src-sub`/`dst-sub` подставить реальные из фикстуры файла (см. соседние тесты).

Failing render test в `iptables_test.go`:

```go
func TestRenderRulesMultiChain(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FIRENET-FWD", Primary: true, Default: rules.ActionDeny},
			{Name: "FIRENET-RESTRICTED", Default: rules.ActionDeny},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FIRENET-FWD", Comment: "restrict", Action: rules.ActionJump, JumpTo: "FIRENET-RESTRICTED"},
			{Chain: "FIRENET-RESTRICTED", Comment: "dns", Action: rules.ActionAllow},
		},
	}
	out := string(RenderRules(ds))
	for _, want := range []string{
		"iptables -N FIRENET-FWD",
		"iptables -N FIRENET-RESTRICTED",
		"iptables -I FORWARD -j FIRENET-FWD",
		"iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
		"iptables -A FIRENET-FWD -j FIRENET-RESTRICTED",
		"iptables -A FIRENET-RESTRICTED -j ACCEPT",
		"iptables -A FIRENET-RESTRICTED -j DROP",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	// secondary chains are never jumped into from FORWARD
	if strings.Contains(out, "iptables -I FORWARD -j FIRENET-RESTRICTED") {
		t.Fatal("secondary chain must not be wired into FORWARD")
	}
}
```

- [ ] **Step 2: прогон — убедиться в падении**

Run: `go test ./internal/compiler/... ./internal/render/...`
Expected: FAIL (нет `CompiledChain`, `Chain`/`JumpTo` полей).

- [ ] **Step 3: compiler/model.go**

```go
// CompiledRule is one iptables rule, matching by ipset membership rather
// than by interface, so it holds regardless of which physical link a packet
// actually took.
type CompiledRule struct {
	Comment  string // source rule name, for traceability
	SrcSet   string // ipset name; "" = unconditional (any)
	DstSet   string
	SrcAddr  string // literal address/CIDR match (-s), when no ipset is used
	DstAddr  string // literal address/CIDR match (-d), when no ipset is used
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
	Action   rules.Action
	JumpTo   string // target chain when Action == ActionJump
	Chain    string // owning chain name on this device
}

// CompiledChain is metadata of one chain present on a device.
type CompiledChain struct {
	Name    string
	Primary bool                // the chain jumped into from FORWARD
	Position rules.ChainPosition // meaningful only when Primary
	Default rules.Action
}

// DeviceRuleset is everything one managed device needs: its ipsets, the
// chains it hosts (primary first), and its ordered rules grouped by chain.
type DeviceRuleset struct {
	Device string
	IPSets []IPSet
	Chains []CompiledChain
	Rules  []CompiledRule
}
```

- [ ] **Step 4: compiler/compiler.go**

Изменения относительно текущего кода:

1. `atomicRule` получает поля `Chain string; JumpTo string`; `expandAtomic(r rules.Rule)` копирует их из `rules.Rule` (переименование параметра не требуется — просто добавить в структуру оба вызова конструктора).
2. `deviceAccum`:

```go
type deviceAccum struct {
	rules    []CompiledRule
	ips      []IPSet
	ipsets   map[string]int
	chainIdx map[string]int // chain name -> index into chains
	chains   []CompiledChain
}

func (a *deviceAccum) ensureChain(name string, cc CompiledChain) {
	if _, ok := a.chainIdx[name]; ok {
		return
	}
	if a.chainIdx == nil {
		a.chainIdx = make(map[string]int)
	}
	a.chainIdx[name] = len(a.chains)
	a.chains = append(a.chains, cc)
}

func (a *deviceAccum) addRule(r CompiledRule) {
	key := ruleKey(r)
	for _, existing := range a.rules {
		if ruleKey(existing) == key {
			return
		}
	}
	a.rules = append(a.rules, r)
}

func ruleKey(r CompiledRule) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%s|%v|%v|%s|%s", r.Chain, r.SrcSet, r.DstSet, r.SrcAddr, r.DstAddr, r.Proto, r.SrcPorts, r.DstPorts, r.Action, r.JumpTo)
}
```

3. В `Compile`: убрать `primary := pol.Primary()`-упрощение из Task 1; внешний цикл:

```go
for ci := range pol.Chains {
	c := &pol.Chains[ci]
	for _, rule := range c.Rules {
		for _, ar := range expandAtomic(rule) {
			// ...тело без изменений, но:
			compiled := CompiledRule{
				Comment: ar.Comment, Proto: ar.Proto,
				SrcPorts: ar.SrcPorts, DstPorts: ar.DstPorts,
				Action: ar.Action, JumpTo: ar.JumpTo, Chain: c.Name,
			}
			// ...ipset-часть без изменений...
		}
	}
}
```

4. Гарантия цепочек перед сборкой результата (после основного цикла, до `for _, name := range allRouters`). На каждом устройстве с правилами должны существовать: первичная цепочка (на неё ссылается jump из FORWARD) и все цели прыжков его правил:

```go
defaults := make(map[string]CompiledChain, len(pol.Chains))
for ci := range pol.Chains {
	c := &pol.Chains[ci]
	defaults[c.Name] = CompiledChain{Name: c.Name, Primary: ci == 0, Position: c.ChainPosition, Default: c.DefaultAction}
}
for _, name := range allRouters {
	a := accum[name]
	if len(a.rules) == 0 {
		continue
	}
	a.ensureChain(defaults[pol.Chains[0].Name].Name, defaults[pol.Chains[0].Name])
	for _, r := range a.rules {
		if r.JumpTo != "" {
			a.ensureChain(r.JumpTo, defaults[r.JumpTo]) // existence guaranteed by rules.Validate
		}
	}
}
```

5. Сборка результата:

```go
if len(a.rules) == 0 {
	continue
}
sort.SliceStable(a.chains, func(i, j int) bool {
	if a.chains[i].Primary != a.chains[j].Primary {
		return a.chains[i].Primary
	}
	return a.chains[i].Name < a.chains[j].Name
})
result = append(result, DeviceRuleset{
	Device: name,
	IPSets: a.ipsetList(topo),
	Chains: a.chains,
	Rules:  a.rules,
})
```

- [ ] **Step 5: render/iptables.go**

```go
// RenderRules renders an idempotent shell script that creates (if absent),
// flushes and repopulates every chain of ds, wiring only the primary chain's
// jump into FORWARD at its position. Secondary chains are reachable only via
// jump rules inside other firenet chains.
func RenderRules(ds compiler.DeviceRuleset) []byte {
	var b strings.Builder
	fmt.Fprint(&b, "#!/bin/sh\nset -e\n")
	for _, ch := range ds.Chains {
		fmt.Fprintf(&b, "iptables -N %s 2>/dev/null || true\n", ch.Name)
	}
	primary := ds.Chains[0]
	fmt.Fprintf(&b, "while iptables -C FORWARD -j %s 2>/dev/null; do iptables -D FORWARD -j %s; done\n", primary.Name, primary.Name)
	if primary.Position == rules.ChainBottom {
		fmt.Fprintf(&b, "iptables -A FORWARD -j %s\n", primary.Name)
	} else {
		fmt.Fprintf(&b, "iptables -I FORWARD -j %s\n", primary.Name)
	}
	for _, ch := range ds.Chains {
		fmt.Fprintf(&b, "iptables -F %s\n", ch.Name)
		fmt.Fprintf(&b, "iptables -A %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n", ch.Name)
		for _, r := range ds.Rules {
			if r.Chain != ch.Name {
				continue
			}
			fmt.Fprintf(&b, "iptables -A %s %s-j %s\n", ch.Name, matchArgs(r), actionTarget(r))
		}
		fmt.Fprintf(&b, "iptables -A %s -j %s\n", ch.Name, actionTarget(compiler.CompiledRule{Action: ch.Default}))
	}
	return []byte(b.String())
}
```

`actionTarget` меняет сигнатуру:

```go
func actionTarget(r compiler.CompiledRule) string {
	switch r.Action {
	case rules.ActionAllow:
		return "ACCEPT"
	case rules.ActionReturn:
		return "RETURN"
	case rules.ActionJump:
		return r.JumpTo
	default:
		return "DROP"
	}
}
```

Вызов дефолта: `actionTarget(compiler.CompiledRule{Action: ch.Default})`.

Обновить существующие тесты рендера: `ds.ChainName/DefaultAction/Rules` → новая форма (`Chains: [{Name: ..., Primary: true, Position: ...}]`, правила с `Chain:`).

- [ ] **Step 6: запуск**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./internal/compiler/... ./internal/render/... ./internal/simulate/... ./internal/httpapi/...`
Expected: зелёно (simulate/httpapi падают? Если да — они чинятся в Task 3/4, поэтому здесь допустимо временно адаптировать их вызовы механически: см. Step 7).

- [ ] **Step 7: механические фиксы потребителей (если ломаются)**

`internal/simulate/simulate.go` и `internal/httpapi/*` ссылаются на `rs.ChainName/DefaultAction` и `MatchFlow(rs,...)`. Минимальная адаптация до Task 3:

- simulate: заменить `rs.ChainName` → `rs.Chains[0].Name`, `def`-логику → `rs.Chains[0].Default`, матчинг ограничить `r.Chain == rs.Chains[0].Name` (временно инлайн-фильтром или сразу сделать Task 3 — предпочтительно выполнить Task 3 сразу после этого шага, не откладывая).
- httpapi: если есть обращения к удалённым полям — поправить аналогично (обычно нет: httpapi работает через YAML/DTO).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(compiler,render): place and render multiple chains per device"
```

---

### Task 3: Матчинг и симулятор — проход по цепочкам

**Files:**
- Modify: `internal/compiler/match.go`
- Modify: `internal/simulate/simulate.go`
- Modify: `internal/simulate/simulate_test.go`
- Modify: `internal/app/simulate.go`

**Interfaces:**
- Consumes: `DeviceRuleset.Chains/Rules[].Chain/JumpTo` (Task 2).
- Produces: `compiler.MatchFlowInChain(rs DeviceRuleset, chain string, src, dst netip.Addr, proto rules.Proto, srcPorts, dstPorts []string) *CompiledRule` (замещает `MatchFlow`); `simulate.Run(topo, sets, g, limits, flow)` — параметр `defaultAction` удалён.

- [ ] **Step 1: failing tests симулятора**

В `simulate_test.go` (фикстуры наборов `DeviceRuleset` построить в новой форме; существующий хелпер `makeSets` обновить):

```go
func TestVerdictJumpTerminalSubchain(t *testing.T) {
	rs := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionAllow},
			{Name: "SUB", Default: rules.ActionDeny},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FWD", Comment: "to-sub", Action: rules.ActionJump, JumpTo: "SUB"},
		},
	}
	v := verdict(rs, Flow{Src: srcIP, Dst: dstIP}, "r1")
	if v.Action != rules.ActionDeny || v.MatchedRule != "to-sub" {
		t.Fatalf("verdict = %+v", v)
	}
	if !strings.Contains(v.Reason, "SUB") {
		t.Fatalf("reason must name the subchain: %q", v.Reason)
	}
}

func TestVerdictJumpReturnsBack(t *testing.T) {
	rs := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionAllow},
			{Name: "SUB", Default: rules.ActionReturn},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FWD", Comment: "to-sub", Action: rules.ActionJump, JumpTo: "SUB"},
			{Chain: "FWD", Comment: "final-allow", Action: rules.ActionAllow},
		},
	}
	v := verdict(rs, Flow{Src: srcIP, Dst: dstIP}, "r1")
	if v.Action != rules.ActionAllow || v.MatchedRule != "final-allow" {
		t.Fatalf("verdict = %+v", v)
	}
	if !strings.Contains(v.Reason, "возвращает") {
		t.Fatalf("reason must mention return: %q", v.Reason)
	}
}
```

`srcIP/dstIP` — адреса из подсетей, покрываемых ipset'ами фикстуры (как в соседних тестах файла).

Также обновить существующий тест агрегации путей: сценарий «return из primary» продолжает работать (первичная цепочка возвращает → вердикт пути `return`).

- [ ] **Step 2: match.go — матчинг внутри цепочки**

Заменить `MatchFlow` на:

```go
// MatchFlowInChain returns the first CompiledRule of rs belonging to chain
// and matching a packet from src to dst — the same first-match order the
// rendered iptables script evaluates in. nil means no rule of that chain
// matches and traffic falls to that chain's default action.
func MatchFlowInChain(rs DeviceRuleset, chain string, src, dst netip.Addr, proto rules.Proto, srcPorts, dstPorts []string) *CompiledRule {
	for i := range rs.Rules {
		r := &rs.Rules[i]
		if r.Chain != chain {
			continue
		}
		if !sideMatches(rs, r.SrcSet, r.SrcAddr, src) || !sideMatches(rs, r.DstSet, r.DstAddr, dst) {
			continue
		}
		if r.Proto != rules.ProtoAny && r.Proto != proto {
			continue
		}
		if !portsMatch(r.SrcPorts, srcPorts) || !portsMatch(r.DstPorts, dstPorts) {
			continue
		}
		return r
	}
	return nil
}
```

Хелперы `sideMatches/setContains/portsMatch/portOverlap` без изменений. Обновить вызов в `match_test.go` (обёртка с именем primary-цепочки или прямые вызовы с `"FWD"`-подобным именем из фикстуры).

- [ ] **Step 3: simulate/simulate.go — walk по цепочкам**

Сигнатура `Run`: убрать параметр `defaultAction rules.Action`; строку вызова `verdict(...)` заменить на новую.

Новая логика вместо `verdict`:

```go
// verdict walks the chain graph starting at the primary chain: jump descends,
// return ascends (or hands the packet back to FORWARD from the primary),
// terminal actions end the walk. The reason trail records every transition.
func verdict(rs compiler.DeviceRuleset, flow Flow, router string) RouterVerdict {
	type frame struct{ name string }
	stack := []frame{{rs.Chains[0].Name}}
	var trail []string
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		m := compiler.MatchFlowInChain(rs, cur.name, flow.Src, flow.Dst, flow.Proto, flow.SrcPorts, flow.DstPorts)
		act := defaultOf(rs, cur.name)
		if m != nil {
			act = m.Action
		}
		switch act {
		case rules.ActionJump:
			detail := ruleDetail(rs, m)
			trail = append(trail, fmt.Sprintf("сработало правило %q (%s) — прыжок в цепочку %s", m.Comment, detail, m.JumpTo))
			stack = append(stack, frame{m.JumpTo})
		case rules.ActionReturn:
			if len(stack) > 1 {
				trail = append(trail, fmt.Sprintf("цепочка %s возвращает трафик в вызывающую цепочку", cur.name))
				stack = stack[:len(stack)-1]
				continue
			}
			reason := strings.Join(trail, "; ")
			if m != nil {
				reason += fmt.Sprintf("; сработало правило %q (%s)", m.Comment, ruleDetail(rs, m))
			} else {
				reason += "; нет подходящих правил"
			}
			return RouterVerdict{Router: router, Action: rules.ActionReturn,
				MatchedRule: matchedComment(m), Reason: reason + " — цепочка " + cur.name + " возвращает трафик в FORWARD"}
		default:
			reason := strings.Join(trail, "; ")
			if m != nil {
				reason += fmt.Sprintf("; сработало правило %q (%s)", m.Comment, ruleDetail(rs, m))
			} else {
				reason += fmt.Sprintf("; нет подходящих правил — применяется действие по умолчанию %q цепочки %s", act, cur.name)
			}
			return RouterVerdict{Router: router, Action: act, MatchedRule: matchedComment(m), Reason: reason}
		}
	}
	// недостижимо: валидация исключает циклы, терминальные действия завершают обход
	return RouterVerdict{Router: router, Action: rules.ActionDeny, Reason: "исчерпан обход цепочек"}
}

func defaultOf(rs compiler.DeviceRuleset, chain string) rules.Action {
	for _, ch := range rs.Chains {
		if ch.Name == chain {
			return ch.Default
		}
	}
	return rules.ActionDeny
}

func matchedComment(m *compiler.CompiledRule) string {
	if m == nil {
		return ""
	}
	return m.Comment
}
```

`ruleDetail(rs, m)` — вынести текущее тело формирования деталей из старого `reason` (sideDesc/portsDesc остаются):

```go
func ruleDetail(rs compiler.DeviceRuleset, m *compiler.CompiledRule) string {
	return fmt.Sprintf("src %s, dst %s, proto %s, порты src %s / dst %s",
		sideDesc(rs, m.SrcSet, m.SrcAddr, true),
		sideDesc(rs, m.DstSet, m.DstAddr, false),
		m.Proto, portsDesc(m.SrcPorts), portsDesc(m.DstPorts))
}
```

Строки `MatchedRule` для прыжков: итоговое правило, давшее финальный вердикт (как раньше — комментарий последнего сработавшего правила).

- [ ] **Step 4: app/simulate.go**

Строку `return simulate.Run(topo, devices, g, limits, pol.DefaultAction, opts.Flow)` заменить:

```go
return simulate.Run(topo, devices, g, limits, opts.Flow)
```

- [ ] **Step 5: запуск**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: зелёное.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(simulate): follow chain jumps with return semantics"
```

---

### Task 4: HTTP API — chains DTO и нормализация

**Files:**
- Modify: `internal/httpapi/dto.go`
- Modify: `internal/httpapi/handlers.go` (`getRules`, `putRules`, `validateAndPersistRules`)
- Modify: `internal/httpapi/store.go` (`emptyPolicyYAML`)
- Modify: `internal/httpapi/handlers_test.go`, `internal/httpapi/server_test.go` (если фиксируют форму)

**Interfaces:**
- Consumes: `rules.Load` (читает оба формата), `rules.Validate` (Task 1).
- Produces: wire-формат браузера: `{chains: [{name, defaultAction, chainPosition?, rules: [...]}]}`; `RuleDoc.jumpTo`. GET `/api/rules` всегда отвечает chains-формой (нормализация legacy-файла на лету); PUT принимает chains-форму и сохраняет её в YAML.

- [ ] **Step 1: dto.go**

```go
// RuleDoc matches traffic between named subnets/zones (or "any").
type RuleDoc struct {
	Name     string   `json:"name" yaml:"name"`
	Comment  string   `json:"comment,omitempty" yaml:"comment,omitempty"`
	Src      []string `json:"src" yaml:"src"`
	Dst      []string `json:"dst" yaml:"dst"`
	Proto    string   `json:"proto,omitempty" yaml:"proto,omitempty"`
	SrcPorts []string `json:"srcPorts,omitempty" yaml:"srcPorts,omitempty"`
	DstPorts []string `json:"dstPorts,omitempty" yaml:"dstPorts,omitempty"`
	Action   string   `json:"action" yaml:"action"`
	JumpTo   string   `json:"jumpTo,omitempty" yaml:"jumpTo,omitempty"`
	Mirror   bool     `json:"mirror,omitempty" yaml:"mirror,omitempty"`
}

// ChainDoc is one named chain of the policy wire format. The first element
// of PolicyDoc.Chains is the primary chain (its jump lands in FORWARD).
type ChainDoc struct {
	Name          string    `json:"name" yaml:"name"`
	DefaultAction string    `json:"defaultAction" yaml:"defaultAction"`
	ChainPosition string    `json:"chainPosition,omitempty" yaml:"chainPosition,omitempty"`
	Rules         []RuleDoc `json:"rules" yaml:"rules"`
}

// PolicyDoc is the full wire shape of rules.yaml (chains format). Legacy
// flat files are read by rules.Load and normalized here, never stored back.
type PolicyDoc struct {
	Chains []ChainDoc `json:"chains" yaml:"chains"`
}

// ToPolicy converts the wire doc to the domain model.
func (d PolicyDoc) ToPolicy() rules.Policy {
	pol := rules.Policy{}
	for _, c := range d.Chains {
		ch := rules.Chain{
			Name:          c.Name,
			DefaultAction: rules.Action(c.DefaultAction),
			ChainPosition: rules.ChainPosition(c.ChainPosition),
		}
		for _, r := range c.Rules {
			ch.Rules = append(ch.Rules, rules.Rule{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: rules.Proto(r.Proto), SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: rules.Action(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		pol.Chains = append(pol.Chains, ch)
	}
	return pol
}

// NewPolicyDoc converts the domain model to the wire doc.
func NewPolicyDoc(pol *rules.Policy) PolicyDoc {
	doc := PolicyDoc{}
	for _, c := range pol.Chains {
		ch := ChainDoc{
			Name:          c.Name,
			DefaultAction: string(c.DefaultAction),
			ChainPosition: string(c.ChainPosition),
			Rules:         []RuleDoc{},
		}
		for _, r := range c.Rules {
			ch.Rules = append(ch.Rules, RuleDoc{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: string(r.Proto), SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: string(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		doc.Chains = append(doc.Chains, ch)
	}
	return doc
}
```

Примечание: `Proto: string(r.Proto)` — при `ProtoAny` получится `"any"`; текущий UI так и работает (select с any/tcp/udp/icmp). Проверить по фактическому поведению существующих страниц; если сейчас proto сериализуется с omitempty и пустым значением — сохранить прежнее поведение, но `Load` сам восстанавливает `any`.

- [ ] **Step 2: handlers.go**

`getRules`: парсить через доменную модель (это даёт нормализацию legacy бесплатно):

```go
raw, err := h.store.ReadRules()
// ...
pol, err := rules.Load(bytes.NewReader(raw))
if err != nil {
	writeError(w, http.StatusInternalServerError, fmt.Errorf("parse stored rules: %w", err))
	return
}
writeJSON(w, http.StatusOK, NewPolicyDoc(pol))
```

`validateAndPersistRules(doc PolicyDoc)`:

```go
topo, err := h.loadTopology()
if err != nil {
	return false, err
}
pol := doc.ToPolicy()
if err := pol.Validate(topo); err != nil {
	return true, err
}
raw, err := yaml.Marshal(doc)
if err != nil {
	return false, err
}
return false, h.store.WriteRules(raw)
```

Двойная проверка через повторный `rules.Load(raw)` не нужна: `doc.ToPolicy()` и маршал doc консистентны по построению; валидируем модель до записи.

`putRules` без изменений по форме (декодирует `PolicyDoc`). Ошибки декода → 400; невалидная политика → 422 через `invalid=true` — как сейчас.

- [ ] **Step 3: store.go — сид новой формы**

```go
func emptyPolicyYAML() []byte {
	b, err := yaml.Marshal(PolicyDoc{Chains: []ChainDoc{{
		Name:          rules.DefaultChainName,
		DefaultAction: "deny",
		ChainPosition: string(rules.ChainTop),
		Rules:         []RuleDoc{},
	}}})
	if err != nil {
		panic(err) // static value, can't fail
	}
	return b
}
```

- [ ] **Step 4: тесты handlers**

Обновить `handlers_test.go`:

- PUT-тест валидной политики: тело запроса — chains-форма; ответ и сохранённый файл — chains-форма (прочитать файл, распарсить `PolicyDoc`, проверить `chains[0].name`).
- PUT-тест невалидной политики (например `jumpTo: NOPE`) ожидает 422 и отсутствие записи.
- GET после записи legacy-YAML в стор вручную: ответ — нормализованная chains-форма с одним элементом.

```go
func TestGetRulesNormalizesLegacyFile(t *testing.T) {
	h, _ := newTestHandlers(t) // существующий хелпер файла
	if err := h.store.WriteRules([]byte("defaultAction: deny\nchainName: OLD\nrules: []\n")); err != nil {
		t.Fatal(err)
	}
	rec := doJSON(t, h, http.MethodGet, "/api/rules", nil)
	var doc PolicyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Chains) != 1 || doc.Chains[0].Name != "OLD" {
		t.Fatalf("normalized doc = %+v", doc)
	}
}

func TestPutRulesRejectsUnknownJumpTarget(t *testing.T) {
	h, _ := newTestHandlers(t)
	doc := PolicyDoc{Chains: []ChainDoc{{
		Name: "FIRENET-FWD", DefaultAction: "deny",
		Rules: []RuleDoc{{Name: "r", Src: []string{"any"}, Dst: []string{"any"}, Action: "jump", JumpTo: "GHOST"}},
	}}}
	rec := doJSON(t, h, http.MethodPut, "/api/rules", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422", rec.Code)
	}
}
```

Имена хелперов (`newTestHandlers`, `doJSON`) сверить с файлом и использовать фактические. `Src/Dst: ["any"]` требуют существования топологии-фикстуры теста — при необходимости подставить реальные имена подсетей из фикстуры.

- [ ] **Step 5: запуск**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: зелёное.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(httpapi): chains-shaped rules API with legacy normalization"
```

---

### Task 5: Web UI — табы цепочек и поле jump_to

**Files:**
- Modify: `internal/httpapi/web/rules.html`
- Modify: `internal/httpapi/web/rules.js`
- Modify: `internal/httpapi/web/style.css`
- Modify: `internal/httpapi/web/rules_page.test.js`, `internal/httpapi/web/rules_columns.test.js` (экспорт `formatChain*` больше не нужен — удалить экспорт и тест, либо оставить `formatIPv4`-зависимости)
- Rebuild binary afterwards (`make build`) — go:embed gotcha.

**Interfaces:**
- Consumes: GET/PUT `/api/rules` chains-форма (Task 4); поле `draft.jumpTo`.
- Produces: клиент шлёт `{chains: [...]}`; активная цепочка выбирается табом; правило с `action === "jump"` обязательно имеет `jumpTo` из списка других цепочек.

- [ ] **Step 1: failing JS-тесты**

В `rules_page.test.js` обновить фикстуру до chains-формы и добавить проверки (структура теста — как в существующих: загрузка компонента, мок `Api`, вызовы методов страницы):

```js
const rulesFixture = {
  chains: [
    {
      name: "FIRENET-FWD", defaultAction: "deny", chainPosition: "top",
      rules: [
        { name: "web", comment: "", src: ["office"], dst: ["web-srv"], proto: "tcp", srcPorts: [], dstPorts: [], action: "allow", mirror: false },
        { name: "to-limited", comment: "", src: ["guests"], dst: ["any"], proto: "any", srcPorts: [], dstPorts: [], action: "jump", jumpTo: "LIMITED", mirror: false },
      ],
    },
    {
      name: "LIMITED", defaultAction: "deny",
      rules: [
        { name: "limited-dns", comment: "", src: ["guests"], dst: ["dns"], proto: "udp", srcPorts: [], dstPorts: ["53"], action: "allow", mirror: false },
      ],
    },
  ],
};
```

Тест-кейсы (по образцу существующих, те же моки Api/topology/subnets):

```js
test("tabs switch the visible chain", async () => {
  const page = await boot();
  assert.equal(page.activeChain().name, "FIRENET-FWD");
  page.active = 1;
  assert.deepEqual(page.filteredRules.map((x) => x.rule.name), ["limited-dns"]);
});

test("addChain appends a secondary chain and activates settings edit", async () => {
  const page = await boot();
  page.addChain();
  assert.equal(page.doc.chains.length, 3);
  assert.equal(page.doc.chains[2].name, "");
  assert.equal(page.active, 2);
  assert.equal(page.editing, true);
});

test("removeChain refuses the primary and jump-referenced chains", async () => {
  const page = await boot();
  await page.removeChain(0); // primary
  assert.equal(page.doc.chains.length, 2);
  const limitedIdx = 1;
  await page.removeChain(limitedIdx); // referenced by jumpTo
  assert.equal(page.doc.chains.length, 2);
});

test("draftHint requires jumpTo for jump action", async () => {
  const page = await boot();
  page.openAdd();
  page.draft.name = "x";
  page.draft.src = ["office"];
  page.draft.dst = ["web-srv"];
  page.draft.action = "jump";
  page.draft.jumpTo = "";
  assert.match(page.draftHint, /цепочк/i);
  page.draft.jumpTo = "LIMITED";
  assert.equal(page.draftHint, "");
});

test("persist sends chains-shaped body", async () => {
  const page = await boot();
  await page.saveDraft(); // открыть/сохранить как в соседних тестах
  const put = calls.find((c) => c.path === "/api/rules" && c.method === "PUT");
  assert.ok(Array.isArray(put.body.chains));
});
```

Точный каркас `boot()`/`calls` перенять у существующего файла (там уже есть Alpine-стабы и Api-мок) — не выдумывать новый.

Запуск: `node --test 'internal/httpapi/web/*.test.js'` — новые тесты падают.

- [ ] **Step 2: rules.js — состояние и операции**

Ключевые изменения компонента `rulesPage` (остальное — endpoints, комбобоксы, фильтры — не трогаем):

```js
doc: { chains: [] },
active: 0,
settings: { name: "", defaultAction: "deny", chainPosition: "top" },
draft: { index: -1, name: "", comment: "", src: [], dst: [], proto: "any", action: "deny", jumpTo: "", srcPorts: "", dstPorts: "", mirror: false },

get activeChain() { return this.doc.chains[this.active]; },
get isPrimary() { return this.active === 0; },

_applyDoc(doc) {
  this.doc = { chains: (doc.chains || []).map((c) => ({ ...c, rules: (c.rules || []).map((r) => ({ ...r })) })) };
  this._syncSettings();
},

_syncSettings() {
  const c = this.doc.chains[this.active];
  if (!c) return;
  this.settings = { name: c.name, defaultAction: c.defaultAction, chainPosition: c.chainPosition || "top" };
},
```

- `filteredRules`: `this.doc.rules` → `this.activeChain.rules` (map с index по этой же цепочке).
- `openAdd/openEdit/saveDraft/removeRule/moveRule`: работают с копией `this.activeChain.rules` и после изменения зовут `this.persist(this.doc)`; `saveDraft` записывает `jumpTo: d.action === "jump" ? d.jumpTo : ""` в правило.
- `emptyDraft` включает `jumpTo: ""`.
- `get draftHint` дополнить:

```js
if (d.action === "jump") {
  if (!d.jumpTo) return "Выберите цепочку для перехода";
  if (d.jumpTo === this.activeChain.name) return "Цель перехода должна отличаться от текущей цепочки";
}
```

- Табы:

```js
addChain() {
  this.doc.chains.push({ name: "", defaultAction: "deny", rules: [] });
  this.active = this.doc.chains.length - 1;
  this.startEdit();
},

async removeChain(i) {
  if (i === 0) return;
  const name = this.doc.chains[i]?.name;
  const referenced = this.doc.chains.some((c) => c.rules.some((r) => r.action === "jump" && r.jumpTo === name));
  if (referenced) { showBanner("Цепочка используется действием jump — сначала уберите ссылки"); return; }
  if (!confirm(`Удалить цепочку «${name}»?`)) return;
  try {
    await this.persist({ chains: this.doc.chains.filter((_, j) => j !== i) });
    if (this.active >= this.doc.chains.length) this.active = this.doc.chains.length - 1;
  } catch (e) {
    showBanner("Ошибка удаления цепочки: " + e.message);
  }
},

switchChain(i) { this.active = i; this.editing = false; this._syncSettings(); },
```

- Настройки: `saveSettings` пишет в активную цепочку:

```js
async saveSettings() {
  try {
    const chains = this.doc.chains.slice();
    chains[this.active] = { ...chains[this.active], name: this.settings.name.trim(), defaultAction: this.settings.defaultAction };
    if (this.isPrimary) chains[this.active].chainPosition = this.settings.chainPosition;
    await this.persist({ chains });
    this.editing = false;
  } catch (e) {
    showBanner("Ошибка сохранения параметров: " + e.message);
  }
},
```

- `persist(next)`:

```js
async persist(next) {
  const doc = await Api.put("/api/rules", { chains: next.chains });
  this._applyDoc(doc);
  showBanner("Правила сохранены", "ok");
},
```

- `startEdit/cancelEdit`: `settings` синхронизируется через `_syncSettings` (уже показано выше); `startEdit` просто ставит `editing = true`.
- Удалить `formatChainPosition/formatChainName`, если больше нигде не используются (проверить `rules_columns.test.js`).

- [ ] **Step 3: rules.html**

Над таблицей (внутри `<main x-data="rulesPage">`, до настроек):

```html
<div class="chain-tabs">
  <template x-for="(c, i) in doc.chains" :key="i">
    <button type="button" class="chain-tab" :class="{ active: active === i }" @click="switchChain(i)">
      <span x-text="c.name || 'без имени'"></span>
      <span x-show="i > 0" class="chain-tab-remove" @click.stop="removeChain(i)" title="Удалить цепочку">×</span>
    </button>
  </template>
  <button type="button" class="chain-tab-add" @click="addChain()">+ цепочка</button>
</div>
```

Настройки группы: заголовок/лейблы нейтральные («Цепочка»), select позиции в FORWARD обёрнут в `x-show="isPrimary"`. Значение имени: `x-model="settings.name"`.

Модалка: option `jump` в select действия:

```html
<option value="jump">переход в цепочку</option>
```

Поле цели:

```html
<label x-show="draft.action === 'jump'">
  <span>Перейти в цепочку</span>
  <select x-model="draft.jumpTo">
    <option value="" disabled>— выберите —</option>
    <template x-for="c in doc.chains.filter((c, i) => i !== active)" :key="c.name">
      <option :value="c.name" x-text="c.name"></option>
    </template>
  </select>
</label>
```

- [ ] **Step 4: style.css**

```css
.chain-tabs { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
.chain-tab { display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; border: 1px solid var(--border, #ccc); border-radius: 6px; background: transparent; cursor: pointer; }
.chain-tab.active { font-weight: 600; background: var(--accent-soft, #eef); }
.chain-tab-remove { color: #a00; cursor: pointer; padding: 0 2px; }
.chain-tab-add { border-style: dashed; }
```

Подогнать переменные под существующую палитру файла.

- [ ] **Step 5: запуск JS-тестов**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: зелёное.

- [ ] **Step 6: полный бэкенд-вериф и пересборка**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./... && make build`
Expected: зелёное; бинарник пересобран (embed gotcha).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): chain tabs and jump-to selector on the rules page"
```

---

### Task 6: Пример данных и финальная верификация

**Files:**
- Create: `examples/rules-multi-chain.yaml`

**Interfaces:** нет новых; задача — документирующий пример и полный прогон.

- [ ] **Step 1: пример**

```yaml
# Пример политики с дополнительной цепочкой: опасным пользователям — только DNS,
# остальной трафик из зоны запрещён, все прочие правила живут в главной цепочке.
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - name: quarantine-guests
        comment: отправляем опасных в ограниченную цепочку
        src: [guests]
        dst: [any]
        action: jump
        jumpTo: FIRENET-LIMITED
      - name: office-web
        src: [office]
        dst: [internet]
        proto: tcp
        dstPorts: ["80", "443"]
        action: allow
  - name: FIRENET-LIMITED
    defaultAction: deny
    rules:
      - name: limited-dns
        comment: разрешён только DNS
        src: [guests]
        dst: [dns-servers]
        proto: udp
        dstPorts: ["53"]
        action: allow
```

- [ ] **Step 2: полная верификация**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./... && node --test 'internal/httpapi/web/*.test.js'`
Expected: всё зелёное, gofmt молчит.

Smoke-прогон компиляции примера (по желанию, локально): `go run ./cmd/firenet compile` с примерами topology/subnets из `examples/` и данным файлом правил — скрипты в `out/` должны содержать `-N FIRENET-LIMITED` и `-j FIRENET-LIMITED`.

- [ ] **Step 3: Commit**

```bash
git add examples/rules-multi-chain.yaml
git commit -m "docs(examples): multi-chain rules sample"
```
