# Линтер правил — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static analyzer (`internal/lint`) that finds unreachable/conflicting rules, unused chains, and mirror redundancy in `rules.Policy`, surfaced as advisory findings on the web "Правила" page via a new `GET /api/lint` endpoint.

**Architecture:** A new leaf package `internal/lint` (no CLI/HTTP deps, mirrors `internal/diagnose`'s style) exposes `Check(pol, topo) []Finding`. Rule `src`/`dst`/ports are resolved to numeric interval ranges (reusing the interval-overlap technique `internal/compiler/match.go` already uses for ports, generalized to IPv4 addresses too) so rules referencing different names for the same underlying CIDR are compared correctly. `internal/app.Lint` wraps `Check` with the usual load/validate convention; `internal/httpapi` exposes it read-only; `rules.js`/`rules.html` add a "Проверить" button and results panel.

**Tech Stack:** Go 1.23 (stdlib only — no new dependencies), vanilla JS + Alpine.js (existing `internal/httpapi/web` stack), `node:test` for JS tests.

**Spec:** `docs/superpowers/specs/2026-08-26-rule-linter-design.md`

## Global Constraints

- IPv4-only: the project already rejects IPv6 for literal rule endpoints (`topology.ParseEndpointPrefix`); `internal/lint` assumes IPv4 throughout and skips any non-IPv4 CIDR it encounters rather than crashing on it.
- Findings are always advisory (`Severity` is `"warning"` or `"info"`) — nothing in this feature blocks `PUT /api/rules`, `POST /api/validate`, or `POST /api/compile`.
- No CLI command — the linter is reachable only through `GET /api/lint` and the web UI, per the approved spec's explicit non-goal.
- `internal/lint` does not depend on `internal/graph` or `internal/compiler` — it is a pure policy-level analyzer, independent of routing/device placement (that's `internal/diagnose`'s job).
- `Check(pol, topo)` requires `pol.Validate(topo)` to have already passed; it does not re-validate structure (existence of names, jump cycles, etc.) — callers (here, `app.Lint`) are responsible for calling `pol.Validate(topo)` first.
- Verification after every task, in this order: `go build ./...`, `go vet ./...`, `gofmt -l .` (must print nothing), `go test ./...`; for the web task additionally `node --test 'internal/httpapi/web/*.test.js'`.
- Web assets are embedded via `go:embed` — `make build` is required before the change is visible through `firenet serve`, but per-task verification doesn't require running the server or a browser (project convention: automated tests only, no routine manual browser pass).
- Commit message style: `type(scope): summary` (e.g. `feat(lint): ...`, `test(lint): ...`), matching this repo's existing history.

---

## Task 1: Interval primitives (`internal/lint/ranges.go`)

**Files:**
- Create: `internal/lint/ranges.go`
- Create: `internal/lint/ranges_test.go`

**Interfaces:**
- Consumes: nothing (foundation of the package).
- Produces (used by every later task in this package):
  - `type interval struct{ lo, hi uint64 }` — an inclusive numeric range. Used both for IPv4 addresses (0..2^32-1) and ports (0..65535).
  - `func mergeIntervals(rs []interval) []interval` — sorts by `lo`, merges overlapping *and touching* (`next.lo <= cur.hi+1`) ranges. Returns `nil` for empty input.
  - `func intervalsOverlap(a, b []interval) bool` — **requires** both `a` and `b` to already be `mergeIntervals`-clean (sorted, non-overlapping). True if any pair from `a`/`b` shares a value.
  - `func intervalsCover(covering, covered []interval) bool` — **requires** both pre-merged. True if every interval in `covered` lies entirely within some single interval of `covering`. Vacuously true if `covered` is empty.

- [ ] **Step 1: Write the failing tests**

```go
// internal/lint/ranges_test.go
package lint

import (
	"reflect"
	"testing"
)

func TestMergeIntervals(t *testing.T) {
	tests := []struct {
		name string
		in   []interval
		want []interval
	}{
		{"empty", nil, nil},
		{"single", []interval{{10, 20}}, []interval{{10, 20}}},
		{"disjoint stays separate", []interval{{10, 20}, {30, 40}}, []interval{{10, 20}, {30, 40}}},
		{"overlapping merges", []interval{{10, 25}, {20, 40}}, []interval{{10, 40}}},
		{"touching merges", []interval{{10, 20}, {21, 30}}, []interval{{10, 30}}},
		{"unsorted input sorts first", []interval{{30, 40}, {10, 20}}, []interval{{10, 20}, {30, 40}}},
		{"contained interval absorbed", []interval{{10, 40}, {15, 20}}, []interval{{10, 40}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mergeIntervals(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("mergeIntervals(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestIntervalsOverlap(t *testing.T) {
	tests := []struct {
		name string
		a, b []interval
		want bool
	}{
		{"disjoint", []interval{{0, 10}}, []interval{{20, 30}}, false},
		{"touching but not overlapping", []interval{{0, 10}}, []interval{{11, 20}}, false},
		{"overlapping", []interval{{0, 10}}, []interval{{5, 20}}, true},
		{"one contains other", []interval{{0, 100}}, []interval{{40, 50}}, true},
		{"multi-range hit on second pair", []interval{{0, 10}, {100, 110}}, []interval{{50, 60}, {105, 120}}, true},
		{"empty b", []interval{{0, 10}}, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := intervalsOverlap(tt.a, tt.b); got != tt.want {
				t.Fatalf("intervalsOverlap(%v, %v) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestIntervalsCover(t *testing.T) {
	tests := []struct {
		name              string
		covering, covered []interval
		want              bool
	}{
		{"exact match", []interval{{0, 100}}, []interval{{0, 100}}, true},
		{"fully inside", []interval{{0, 100}}, []interval{{20, 30}}, true},
		{"partially outside", []interval{{0, 100}}, []interval{{90, 110}}, false},
		{"covered spans two disjoint covering ranges — not covered by either alone", []interval{{0, 50}, {60, 100}}, []interval{{40, 70}}, false},
		{"multiple covered ranges all inside", []interval{{0, 100}}, []interval{{10, 20}, {80, 90}}, true},
		{"empty covered is vacuously covered", []interval{{0, 10}}, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := intervalsCover(tt.covering, tt.covered); got != tt.want {
				t.Fatalf("intervalsCover(%v, %v) = %v, want %v", tt.covering, tt.covered, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/lint/... -run 'TestMergeIntervals|TestIntervalsOverlap|TestIntervalsCover' -v`
Expected: build failure — `undefined: interval` / `undefined: mergeIntervals` etc. (package `internal/lint` doesn't exist yet).

- [ ] **Step 3: Implement**

```go
// internal/lint/ranges.go
package lint

import "sort"

// interval is an inclusive numeric range, used for both IPv4 addresses
// (0..2^32-1) and ports (0..65535).
type interval struct{ lo, hi uint64 }

// mergeIntervals sorts rs by lo and merges ranges that overlap or touch
// (next.lo <= cur.hi+1), so a contiguous span split across several
// entries (e.g. two adjacent /25s, or "80-100" and "101-200" in one
// rule's port list) collapses to one interval. Returns nil for empty
// input.
func mergeIntervals(rs []interval) []interval {
	if len(rs) == 0 {
		return nil
	}
	sorted := append([]interval(nil), rs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].lo < sorted[j].lo })
	out := []interval{sorted[0]}
	for _, r := range sorted[1:] {
		last := &out[len(out)-1]
		if r.lo <= last.hi+1 {
			if r.hi > last.hi {
				last.hi = r.hi
			}
			continue
		}
		out = append(out, r)
	}
	return out
}

// intervalsOverlap reports whether any value is present in both a and b.
// a and b must already be mergeIntervals-clean (sorted, non-overlapping).
func intervalsOverlap(a, b []interval) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i].hi < b[j].lo:
			i++
		case b[j].hi < a[i].lo:
			j++
		default:
			return true
		}
	}
	return false
}

// intervalsCover reports whether every interval in covered lies entirely
// within some single interval of covering. Both must already be
// mergeIntervals-clean. Vacuously true if covered is empty.
func intervalsCover(covering, covered []interval) bool {
	for _, c := range covered {
		found := false
		for _, g := range covering {
			if g.lo <= c.lo && c.hi <= g.hi {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add internal/lint/ranges.go internal/lint/ranges_test.go
git commit -m "$(cat <<'EOF'
feat(lint): add interval merge/overlap/cover primitives

Foundation for the rule linter: IPv4 addresses and ports are both just
numeric ranges, compared with the same merge-then-sweep technique
compiler/match.go already uses for ports.
EOF
)"
```

---

## Task 2: `Finding`/`Severity` types (`internal/lint/lint.go`)

**Files:**
- Create: `internal/lint/lint.go`
- Create: `internal/lint/finding_test.go`

**Interfaces:**
- Consumes: nothing yet (Task 7 will append `Check` to this same file once every check exists).
- Produces (used by every check task and by `internal/app`):
  - `type Severity string` with `SeverityWarning`, `SeverityInfo`.
  - `type Finding struct { Severity Severity; Chain string; Rules []string; Message string }` with JSON tags `severity`, `chain`, `rules,omitempty`, `message`.

- [ ] **Step 1: Write the failing tests**

```go
// internal/lint/finding_test.go
package lint

import (
	"encoding/json"
	"testing"
)

func TestFinding_JSONShape(t *testing.T) {
	f := Finding{Severity: SeverityWarning, Chain: "FIRENET-FWD", Rules: []string{"a", "b"}, Message: "msg"}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"severity":"warning","chain":"FIRENET-FWD","rules":["a","b"],"message":"msg"}`
	if string(b) != want {
		t.Fatalf("got %s, want %s", b, want)
	}
}

func TestFinding_JSONOmitsEmptyRules(t *testing.T) {
	f := Finding{Severity: SeverityInfo, Chain: "ORPHAN", Message: "unused chain"}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"severity":"info","chain":"ORPHAN","message":"unused chain"}`
	if string(b) != want {
		t.Fatalf("got %s, want %s", b, want)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/lint/... -run TestFinding -v`
Expected: build failure — `undefined: Finding`.

- [ ] **Step 3: Implement**

```go
// internal/lint/lint.go
// Package lint statically analyzes a rules.Policy for likely mistakes —
// unreachable rules, conflicting overlaps, unused chains, and mirror
// redundancy. Every result is advisory: nothing here blocks compiling or
// persisting a policy, and nothing here considers topology routing (see
// internal/diagnose for path-aware analysis of one concrete flow).
package lint

// Severity is how strongly a Finding should be surfaced. Neither value
// blocks anything — see the package doc.
type Severity string

const (
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// Finding is one static-analysis result.
type Finding struct {
	Severity Severity `json:"severity"`
	Chain    string   `json:"chain"`
	Rules    []string `json:"rules,omitempty"`
	Message  string   `json:"message"`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/lint/lint.go internal/lint/finding_test.go
git commit -m "$(cat <<'EOF'
feat(lint): add Finding/Severity types

Package doc + the shared result type every check (added in later
commits) and the future GET /api/lint handler build on.
EOF
)"
```

---

## Task 3: Endpoint & port resolution (`internal/lint/resolve.go`)

**Files:**
- Create: `internal/lint/resolve.go`
- Create: `internal/lint/resolve_test.go`

**Interfaces:**
- Consumes: `interval` (Task 1).
- Produces (used by Task 4 onward):
  - `var anyIPInterval interval` — sentinel covering the full IPv4 space.
  - `var anyPortInterval interval` — sentinel covering all 65535 ports (used when a rule's port list is empty, meaning "any port").
  - `func endpointIntervals(topo *topology.Topology, name string) []interval` — resolves one `src`/`dst` entry the same way `rules.validEndpoint` does: `"any"`, then `topo.Subnets`, `topo.Networks`, `topo.Sets`, else a literal address/CIDR via `topology.ParseEndpointPrefix`. Non-IPv4 CIDRs are skipped. Unresolvable names return `nil` (shouldn't happen given `Check`'s precondition).
  - `func portIntervals(specs []string) []interval` — resolves a rule's `SrcPorts`/`DstPorts` (dash syntax, e.g. `"443"` or `"1000-2000"` — **not** the colon syntax `compiler/match.go` uses for already-compiled rules). Empty list means "any port".
- Also produces, in `resolve_test.go`, the shared fixture `func testTopology() *topology.Topology` that Tasks 4, 5, 6, and 7's tests all reuse (declared once, in this package, visible to every other `_test.go` file in `internal/lint`).

- [ ] **Step 1: Write the failing tests**

```go
// internal/lint/resolve_test.go
package lint

import (
	"net/netip"
	"reflect"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// testTopology is the shared fixture for every test in this package:
// subnets office (10.0.0.0/24) and dmz (10.0.1.0/24, adjacent to office),
// network "corp" grouping both, and set "blocked" combining a subnet
// with a host address.
func testTopology() *topology.Topology {
	return &topology.Topology{
		Subnets: map[string]topology.Subnet{
			"office": {Name: "office", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"dmz":    {Name: "dmz", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"corp": {Name: "corp", Subnets: []string{"office", "dmz"}},
		},
		Sets: map[string]topology.Set{
			"blocked": {
				Name:      "blocked",
				Subnets:   []string{"office"},
				Addresses: []netip.Prefix{netip.MustParsePrefix("192.168.1.9/32")},
			},
		},
	}
}

// addrUint32 mirrors prefixInterval's byte order for readable literals in
// test expectations — big-endian, i.e. the address's actual numeric value.
func addrUint32(s string) uint64 {
	b := netip.MustParseAddr(s).As4()
	return uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])
}

func TestEndpointIntervals(t *testing.T) {
	topo := testTopology()
	tests := []struct {
		name string
		want []interval
	}{
		{rules.Any, []interval{anyIPInterval}},
		{"office", []interval{{lo: addrUint32("10.0.0.0"), hi: addrUint32("10.0.0.255")}}},
		{"10.0.2.5", []interval{{lo: addrUint32("10.0.2.5"), hi: addrUint32("10.0.2.5")}}},
		{"10.0.2.0/24", []interval{{lo: addrUint32("10.0.2.0"), hi: addrUint32("10.0.2.255")}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := endpointIntervals(topo, tt.name)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("endpointIntervals(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestEndpointIntervals_NetworkAggregatesMembers(t *testing.T) {
	topo := testTopology()
	got := mergeIntervals(endpointIntervals(topo, "corp"))
	want := mergeIntervals([]interval{
		{lo: addrUint32("10.0.0.0"), hi: addrUint32("10.0.0.255")},
		{lo: addrUint32("10.0.1.0"), hi: addrUint32("10.0.1.255")},
	})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("corp intervals = %v, want %v", got, want)
	}
}

func TestEndpointIntervals_SetCombinesSubnetsAndAddresses(t *testing.T) {
	topo := testTopology()
	got := mergeIntervals(endpointIntervals(topo, "blocked"))
	want := mergeIntervals([]interval{
		{lo: addrUint32("10.0.0.0"), hi: addrUint32("10.0.0.255")},
		{lo: addrUint32("192.168.1.9"), hi: addrUint32("192.168.1.9")},
	})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("blocked set intervals = %v, want %v", got, want)
	}
}

func TestEndpointIntervals_UnknownNameResolvesEmpty(t *testing.T) {
	topo := testTopology()
	if got := endpointIntervals(topo, "nonexistent"); got != nil {
		t.Fatalf("unknown name should resolve to nil, got %v", got)
	}
}

func TestPortIntervals(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []interval
	}{
		{"empty means any", nil, []interval{anyPortInterval}},
		{"single port", []string{"443"}, []interval{{443, 443}}},
		{"range", []string{"1000-2000"}, []interval{{1000, 2000}}},
		{"multiple specs", []string{"80", "443"}, []interval{{80, 80}, {443, 443}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := portIntervals(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("portIntervals(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/lint/... -run 'TestEndpointIntervals|TestPortIntervals' -v`
Expected: build failure — `undefined: endpointIntervals` / `undefined: anyIPInterval` etc.

- [ ] **Step 3: Implement**

```go
// internal/lint/resolve.go
package lint

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// anyIPInterval is the sentinel span for the rules.Any ("any") endpoint —
// the whole IPv4 address space. IPv6 isn't supported anywhere else in
// this project either (see topology.ParseEndpointPrefix), so IPv4's
// 32-bit space is the entire domain here.
var anyIPInterval = interval{lo: 0, hi: 0xFFFFFFFF}

// anyPortInterval is the sentinel span for an empty port list ("any port").
var anyPortInterval = interval{lo: 0, hi: 65535}

// endpointIntervals resolves one rule src/dst entry to the IPv4 ranges it
// matches, in the same name-resolution order as rules.validEndpoint:
// "any", subnet, network, set, else a literal address/CIDR. topo must
// already be valid (topology.Validate) — see Check's precondition.
// Non-IPv4 CIDRs (topologically possible via a hand-written subnets.yaml
// entry, even though the project has no IPv6 support in practice) are
// skipped rather than causing a crash.
func endpointIntervals(topo *topology.Topology, name string) []interval {
	if name == rules.Any {
		return []interval{anyIPInterval}
	}
	_, isSet := topo.Sets[name]
	_, isSubnet := topo.Subnets[name]
	_, isNetwork := topo.Networks[name]
	if isSet || isSubnet || isNetwork {
		var out []interval
		for _, c := range topo.EntityCIDRs(name) {
			p, err := netip.ParsePrefix(c)
			if err != nil || !p.Addr().Is4() {
				continue
			}
			out = append(out, prefixInterval(p))
		}
		return out
	}
	if p, ok := topology.ParseEndpointPrefix(name); ok {
		return []interval{prefixInterval(p)}
	}
	return nil
}

// prefixInterval converts an IPv4 prefix to its inclusive address range.
func prefixInterval(p netip.Prefix) interval {
	p = p.Masked()
	b := p.Addr().As4()
	lo := uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])
	span := uint64(1) << (32 - p.Bits())
	return interval{lo: lo, hi: lo + span - 1}
}

// portIntervals resolves a rule's SrcPorts/DstPorts (dash-separated, e.g.
// "80" or "1000-2000" — rules.Rule's own syntax, validated by
// rules.validatePortSpec) to the port ranges they match. An empty list
// means "any port".
func portIntervals(specs []string) []interval {
	if len(specs) == 0 {
		return []interval{anyPortInterval}
	}
	out := make([]interval, 0, len(specs))
	for _, spec := range specs {
		lo, hi, ok := parsePortSpec(spec)
		if !ok {
			continue // Check's precondition guarantees pol.Validate(topo) already passed
		}
		out = append(out, interval{lo: uint64(lo), hi: uint64(hi)})
	}
	return out
}

func parsePortSpec(spec string) (lo, hi int, ok bool) {
	loStr, hiStr, ranged := strings.Cut(spec, "-")
	if !ranged {
		hiStr = loStr
	}
	lo, err1 := strconv.Atoi(loStr)
	hi, err2 := strconv.Atoi(hiStr)
	if err1 != nil || err2 != nil || lo < 1 || hi > 65535 || lo > hi {
		return 0, 0, false
	}
	return lo, hi, true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/lint/resolve.go internal/lint/resolve_test.go
git commit -m "$(cat <<'EOF'
feat(lint): resolve rule endpoints and ports to intervals

Mirrors rules.validEndpoint's name-resolution order so two rules that
reference the same IPs under different names still compare correctly.
EOF
)"
```

---

## Task 4: Rule span matching (`internal/lint/match.go`)

**Files:**
- Create: `internal/lint/match.go`
- Create: `internal/lint/match_test.go`

**Interfaces:**
- Consumes: `interval`/`mergeIntervals`/`intervalsOverlap`/`intervalsCover` (Task 1), `endpointIntervals`/`portIntervals` (Task 3), `testTopology()` (Task 3's test file).
- Produces (used by Tasks 5 and 6):
  - `type ruleSpan struct{ src, dst, srcPorts, dstPorts []interval; proto rules.Proto }` — one rule's match space, pre-merged per dimension.
  - `func ruleSpanOf(topo *topology.Topology, r rules.Rule) ruleSpan`
  - `func ruleSpansOf(topo *topology.Topology, rs []rules.Rule) []ruleSpan`
  - `func spansOverlap(a, b ruleSpan) bool` — true if a and b can match at least one common packet.
  - `func spanCovers(a, b ruleSpan) bool` — true if every packet b matches, a also matches (a fully shadows b when evaluated first).

- [ ] **Step 1: Write the failing tests**

```go
// internal/lint/match_test.go
package lint

import (
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

func TestSpansOverlapAndCovers(t *testing.T) {
	topo := testTopology()

	officeToDmz := ruleSpanOf(topo, rules.Rule{Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}})
	anyToDmz := ruleSpanOf(topo, rules.Rule{Src: []string{rules.Any}, Dst: []string{"dmz"}, Proto: rules.ProtoAny})
	officeToOffice := ruleSpanOf(topo, rules.Rule{Src: []string{"office"}, Dst: []string{"office"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}})

	if !spansOverlap(officeToDmz, anyToDmz) {
		t.Fatal("officeToDmz should overlap anyToDmz")
	}
	if !spanCovers(anyToDmz, officeToDmz) {
		t.Fatal("anyToDmz (any src, proto any) should cover the narrower officeToDmz")
	}
	if spanCovers(officeToDmz, anyToDmz) {
		t.Fatal("officeToDmz must not cover the broader anyToDmz")
	}
	if spansOverlap(officeToDmz, officeToOffice) {
		t.Fatal("disjoint dst (dmz vs office) must not overlap")
	}
}

func TestProtoOverlapsAndCovers(t *testing.T) {
	if !protoOverlaps(rules.ProtoAny, rules.ProtoTCP) {
		t.Fatal("any overlaps tcp")
	}
	if protoOverlaps(rules.ProtoTCP, rules.ProtoUDP) {
		t.Fatal("tcp/udp must not overlap")
	}
	if !protoCovers(rules.ProtoAny, rules.ProtoTCP) {
		t.Fatal("any covers tcp")
	}
	if protoCovers(rules.ProtoTCP, rules.ProtoAny) {
		t.Fatal("tcp must not cover any")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/lint/... -run 'TestSpansOverlapAndCovers|TestProtoOverlapsAndCovers' -v`
Expected: build failure — `undefined: ruleSpanOf` etc.

- [ ] **Step 3: Implement**

```go
// internal/lint/match.go
package lint

import (
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// ruleSpan is a rule's src/dst/port match space resolved to merged,
// sorted interval lists, computed once per rule so pairwise comparisons
// across a chain don't re-resolve names for every pair.
type ruleSpan struct {
	src, dst, srcPorts, dstPorts []interval
	proto                        rules.Proto
}

func ruleSpanOf(topo *topology.Topology, r rules.Rule) ruleSpan {
	return ruleSpan{
		src:      mergeIntervals(flattenEndpoints(topo, r.Src)),
		dst:      mergeIntervals(flattenEndpoints(topo, r.Dst)),
		srcPorts: mergeIntervals(portIntervals(r.SrcPorts)),
		dstPorts: mergeIntervals(portIntervals(r.DstPorts)),
		proto:    r.Proto,
	}
}

func ruleSpansOf(topo *topology.Topology, rs []rules.Rule) []ruleSpan {
	out := make([]ruleSpan, len(rs))
	for i, r := range rs {
		out[i] = ruleSpanOf(topo, r)
	}
	return out
}

func flattenEndpoints(topo *topology.Topology, names []string) []interval {
	var out []interval
	for _, n := range names {
		out = append(out, endpointIntervals(topo, n)...)
	}
	return out
}

// spansOverlap reports whether a and b can match at least one common
// packet.
func spansOverlap(a, b ruleSpan) bool {
	return protoOverlaps(a.proto, b.proto) &&
		intervalsOverlap(a.src, b.src) &&
		intervalsOverlap(a.dst, b.dst) &&
		intervalsOverlap(a.srcPorts, b.srcPorts) &&
		intervalsOverlap(a.dstPorts, b.dstPorts)
}

// spanCovers reports whether every packet b can match, a also matches —
// i.e. a fully shadows b when a is evaluated first.
func spanCovers(a, b ruleSpan) bool {
	return protoCovers(a.proto, b.proto) &&
		intervalsCover(a.src, b.src) &&
		intervalsCover(a.dst, b.dst) &&
		intervalsCover(a.srcPorts, b.srcPorts) &&
		intervalsCover(a.dstPorts, b.dstPorts)
}

func protoOverlaps(a, b rules.Proto) bool {
	return a == rules.ProtoAny || b == rules.ProtoAny || a == b
}

func protoCovers(a, b rules.Proto) bool {
	return a == rules.ProtoAny || a == b
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/lint/match.go internal/lint/match_test.go
git commit -m "$(cat <<'EOF'
feat(lint): combine src/dst/proto/ports into per-rule overlap/covers

spansOverlap and spanCovers are the building blocks every check
(unreachable rules, conflicts, mirror pairs) compares rules with.
EOF
)"
```

---

## Task 5: Unreachable-rule and conflicting-overlap checks (`internal/lint/checks_overlap.go`)

**Files:**
- Create: `internal/lint/checks_overlap.go`
- Create: `internal/lint/checks_overlap_test.go`

**Interfaces:**
- Consumes: `Finding`/`Severity` (Task 2), `ruleSpansOf`/`spansOverlap`/`spanCovers` (Task 4), `testTopology()` (Task 3's test file).
- Produces (used by Task 7's `Check`, and by Task 6's tests via the shared `chainPolicy` test helper):
  - `func checkUnreachable(pol *rules.Policy, topo *topology.Topology) []Finding`
  - `func checkConflict(pol *rules.Policy, topo *topology.Topology) []Finding`
  - `func chainPolicy(rs ...rules.Rule) *rules.Policy` (test helper, in `checks_overlap_test.go`, reused by `checks_misc_test.go` and `lint_test.go`) — wraps rs in a single primary chain named `"FIRENET-FWD"`.

- [ ] **Step 1: Write the failing tests**

```go
// internal/lint/checks_overlap_test.go
package lint

import (
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

// chainPolicy wraps rs in a single primary chain, for tests that only
// care about rule-level behavior within one chain.
func chainPolicy(rs ...rules.Rule) *rules.Policy {
	return &rules.Policy{Chains: []rules.Chain{{Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop, Rules: rs}}}
}

func TestCheckUnreachable_DuplicateRule(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "broad", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
		rules.Rule{Name: "narrow", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
	)
	got := checkUnreachable(pol, topo)
	if len(got) != 1 || got[0].Rules[0] != "broad" || got[0].Rules[1] != "narrow" {
		t.Fatalf("want one unreachable finding for narrow, got %+v", got)
	}
	if !strings.Contains(got[0].Message, "никогда не применяется") {
		t.Fatalf("message should explain unreachability: %q", got[0].Message)
	}
}

func TestCheckUnreachable_DifferentActionStillUnreachable(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "deny-all", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		rules.Rule{Name: "allow-office", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
	)
	got := checkUnreachable(pol, topo)
	if len(got) != 1 || got[0].Rules[1] != "allow-office" {
		t.Fatalf("want allow-office flagged unreachable, got %+v", got)
	}
}

func TestCheckUnreachable_NoOverlapNoFinding(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "a", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		rules.Rule{Name: "b", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"80"}, Action: rules.ActionAllow},
	)
	if got := checkUnreachable(pol, topo); len(got) != 0 {
		t.Fatalf("disjoint ports must not be unreachable: %+v", got)
	}
}

func TestCheckConflict_PartialOverlapDifferentAction(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "allow-443-8080", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443", "8080"}, Action: rules.ActionAllow},
		rules.Rule{Name: "deny-8080-9090", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"8080", "9090"}, Action: rules.ActionDeny},
	)
	got := checkConflict(pol, topo)
	if len(got) != 1 {
		t.Fatalf("want one conflict finding, got %+v", got)
	}
}

func TestCheckConflict_FullCoverageIsNotConflict(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "allow-all", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
		rules.Rule{Name: "deny-office", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
	)
	if got := checkConflict(pol, topo); len(got) != 0 {
		t.Fatalf("full coverage is checkUnreachable's finding, not a conflict: %+v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/lint/... -run 'TestCheckUnreachable|TestCheckConflict' -v`
Expected: build failure — `undefined: checkUnreachable` / `undefined: checkConflict`.

- [ ] **Step 3: Implement**

```go
// internal/lint/checks_overlap.go
package lint

import (
	"fmt"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// checkUnreachable flags a rule that can never fire because an earlier
// rule in the same chain already fully covers its match space — the
// earlier rule decides the outcome first, regardless of what action the
// later rule declares. Only the first (nearest) covering predecessor is
// reported per rule.
func checkUnreachable(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		spans := ruleSpansOf(topo, c.Rules)
		for j := 1; j < len(c.Rules); j++ {
			for i := 0; i < j; i++ {
				if !spanCovers(spans[i], spans[j]) {
					continue
				}
				var msg string
				if c.Rules[i].Action == c.Rules[j].Action {
					msg = fmt.Sprintf("правило %q никогда не применяется — более раннее правило %q уже покрывает весь его трафик с тем же действием", c.Rules[j].Name, c.Rules[i].Name)
				} else {
					msg = fmt.Sprintf("правило %q никогда не применяется — более раннее правило %q решает исход первым (action=%s)", c.Rules[j].Name, c.Rules[i].Name, c.Rules[i].Action)
				}
				out = append(out, Finding{
					Severity: SeverityWarning,
					Chain:    c.Name,
					Rules:    []string{c.Rules[i].Name, c.Rules[j].Name},
					Message:  msg,
				})
				break
			}
		}
	}
	return out
}

// checkConflict flags two rules in the same chain that partially overlap
// (neither fully covers the other — that's checkUnreachable's job) but
// declare different actions, so the outcome for the overlapping subset
// of traffic depends on which one is evaluated first.
func checkConflict(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		spans := ruleSpansOf(topo, c.Rules)
		for i := range c.Rules {
			for j := i + 1; j < len(c.Rules); j++ {
				if c.Rules[i].Action == c.Rules[j].Action {
					continue
				}
				if !spansOverlap(spans[i], spans[j]) {
					continue
				}
				if spanCovers(spans[i], spans[j]) || spanCovers(spans[j], spans[i]) {
					continue
				}
				out = append(out, Finding{
					Severity: SeverityWarning,
					Chain:    c.Name,
					Rules:    []string{c.Rules[i].Name, c.Rules[j].Name},
					Message: fmt.Sprintf("правила %q и %q частично пересекаются с разными action (%s/%s) — для общего трафика решает порядок правил",
						c.Rules[i].Name, c.Rules[j].Name, c.Rules[i].Action, c.Rules[j].Action),
				})
			}
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/lint/checks_overlap.go internal/lint/checks_overlap_test.go
git commit -m "$(cat <<'EOF'
feat(lint): detect unreachable rules and conflicting overlaps
EOF
)"
```

---

## Task 6: Dead-chain, mirror, and broad-rule checks (`internal/lint/checks_misc.go`)

**Files:**
- Create: `internal/lint/checks_misc.go`
- Create: `internal/lint/checks_misc_test.go`

**Interfaces:**
- Consumes: `Finding`/`Severity` (Task 2), `ruleSpansOf`/`intervalsOverlap` (Tasks 1 and 4), `chainPolicy` (Task 5's test file), `testTopology()` (Task 3's test file).
- Produces (used by Task 7's `Check`):
  - `func checkDeadChains(pol *rules.Policy) []Finding`
  - `func checkMirror(pol *rules.Policy, topo *topology.Topology) []Finding`
  - `func checkBroadAnyRule(pol *rules.Policy) []Finding`

- [ ] **Step 1: Write the failing tests**

```go
// internal/lint/checks_misc_test.go
package lint

import (
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

func TestCheckDeadChains(t *testing.T) {
	pol := &rules.Policy{Chains: []rules.Chain{
		{Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop, Rules: []rules.Rule{
			{Name: "go-limited", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionJump, JumpTo: "LIMITED"},
		}},
		{Name: "LIMITED", DefaultAction: rules.ActionDeny},
		{Name: "ORPHAN", DefaultAction: rules.ActionDeny},
	}}
	got := checkDeadChains(pol)
	if len(got) != 1 || got[0].Chain != "ORPHAN" {
		t.Fatalf("want ORPHAN flagged dead, got %+v", got)
	}
}

func TestCheckMirror_RedundantSelfOverlap(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(rules.Rule{Name: "r", Src: []string{"office"}, Dst: []string{"office"}, Proto: rules.ProtoAny, Action: rules.ActionAllow, Mirror: true})
	got := checkMirror(pol, topo)
	if len(got) != 1 || got[0].Rules[0] != "r" {
		t.Fatalf("want redundant-mirror finding, got %+v", got)
	}
}

func TestCheckMirror_ManualPairSuggestsMerge(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "office-to-dmz", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, SrcPorts: []string{"1024-65535"}, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		rules.Rule{Name: "dmz-to-office", Src: []string{"dmz"}, Dst: []string{"office"}, Proto: rules.ProtoTCP, SrcPorts: []string{"443"}, DstPorts: []string{"1024-65535"}, Action: rules.ActionAllow},
	)
	got := checkMirror(pol, topo)
	if len(got) != 1 || got[0].Rules[0] != "office-to-dmz" || got[0].Rules[1] != "dmz-to-office" {
		t.Fatalf("want manual-mirror-pair finding, got %+v", got)
	}
}

func TestCheckMirror_NoFindingWhenAlreadyMirrored(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(rules.Rule{Name: "r", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow, Mirror: true})
	if got := checkMirror(pol, topo); len(got) != 0 {
		t.Fatalf("mirror already set and no self-overlap: want no findings, got %+v", got)
	}
}

func TestCheckBroadAnyRule(t *testing.T) {
	pol := chainPolicy(
		rules.Rule{Name: "wide-open", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		rules.Rule{Name: "documented", Comment: "explicitly open by design", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
	)
	got := checkBroadAnyRule(pol)
	if len(got) != 1 || got[0].Rules[0] != "wide-open" {
		t.Fatalf("only the uncommented any/any rule should be flagged, got %+v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/lint/... -run 'TestCheckDeadChains|TestCheckMirror|TestCheckBroadAnyRule' -v`
Expected: build failure — `undefined: checkDeadChains` etc.

- [ ] **Step 3: Implement**

```go
// internal/lint/checks_misc.go
package lint

import (
	"fmt"
	"slices"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// checkDeadChains flags a non-primary chain that no rule ever jumps to.
func checkDeadChains(pol *rules.Policy) []Finding {
	referenced := make(map[string]bool)
	for _, c := range pol.Chains {
		for _, r := range c.Rules {
			if r.Action == rules.ActionJump {
				referenced[r.JumpTo] = true
			}
		}
	}
	var out []Finding
	for i, c := range pol.Chains {
		if i == 0 || referenced[c.Name] {
			continue
		}
		out = append(out, Finding{
			Severity: SeverityWarning,
			Chain:    c.Name,
			Message:  fmt.Sprintf("цепочка %q не используется — на неё нет ни одного jump", c.Name),
		})
	}
	return out
}

// checkMirror flags two symmetry issues: a mirror flag that adds nothing
// because src/dst already overlap, and two separate rules that manually
// implement what one mirrored rule would do.
func checkMirror(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		spans := ruleSpansOf(topo, c.Rules)
		for i, r := range c.Rules {
			if r.Mirror && intervalsOverlap(spans[i].src, spans[i].dst) {
				out = append(out, Finding{
					Severity: SeverityInfo,
					Chain:    c.Name,
					Rules:    []string{r.Name},
					Message:  fmt.Sprintf("правило %q: src и dst уже пересекаются — mirror не добавляет новых пар", r.Name),
				})
			}
		}
		for i := 0; i < len(c.Rules); i++ {
			a := c.Rules[i]
			if a.Mirror {
				continue
			}
			for j := i + 1; j < len(c.Rules); j++ {
				b := c.Rules[j]
				if b.Mirror || a.Proto != b.Proto || a.Action != b.Action {
					continue
				}
				if isExactMirrorPair(spans[i], spans[j]) {
					out = append(out, Finding{
						Severity: SeverityInfo,
						Chain:    c.Name,
						Rules:    []string{a.Name, b.Name},
						Message:  fmt.Sprintf("правила %q и %q — точные зеркала друг друга; можно объединить в одно с mirror: true", a.Name, b.Name),
					})
				}
			}
		}
	}
	return out
}

// isExactMirrorPair reports whether b is exactly what compiling a with
// mirror: true would additionally produce — src/dst swapped and, since
// the traffic direction reverses, srcPorts/dstPorts swapped too (see
// internal/compiler/compiler.go: expandAtomic).
func isExactMirrorPair(a, b ruleSpan) bool {
	return slices.Equal(a.src, b.dst) && slices.Equal(a.dst, b.src) &&
		slices.Equal(a.srcPorts, b.dstPorts) && slices.Equal(a.dstPorts, b.srcPorts)
}

// checkBroadAnyRule flags an any→any, proto-any rule with no comment —
// likely intentional, but worth a nudge to document the intent.
func checkBroadAnyRule(pol *rules.Policy) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		for _, r := range c.Rules {
			if r.Comment != "" {
				continue
			}
			if len(r.Src) == 1 && r.Src[0] == rules.Any && len(r.Dst) == 1 && r.Dst[0] == rules.Any && r.Proto == rules.ProtoAny {
				out = append(out, Finding{
					Severity: SeverityInfo,
					Chain:    c.Name,
					Rules:    []string{r.Name},
					Message:  fmt.Sprintf("правило %q разрешает/запрещает весь трафик (any→any, proto any) без комментария — стоит пояснить назначение", r.Name),
				})
			}
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/lint/checks_misc.go internal/lint/checks_misc_test.go
git commit -m "$(cat <<'EOF'
feat(lint): detect dead chains, mirror redundancy, and undocumented any-rules
EOF
)"
```

---

## Task 7: `Check` orchestrator (`internal/lint/lint.go`)

**Files:**
- Modify: `internal/lint/lint.go` (append `Check`)
- Create: `internal/lint/lint_test.go`

**Interfaces:**
- Consumes: every `checkXxx` function from Tasks 5 and 6.
- Produces (used by `internal/app.Lint`, Task 8): `func Check(pol *rules.Policy, topo *topology.Topology) []Finding` — the package's sole public entry point.

- [ ] **Step 1: Write the failing test**

```go
// internal/lint/lint_test.go
package lint

import (
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

func TestCheck_CombinesAllChecksInDocumentedOrder(t *testing.T) {
	topo := testTopology()
	pol := &rules.Policy{Chains: []rules.Chain{
		{
			Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop,
			Rules: []rules.Rule{
				// "corp" (office+dmz) fully covers office->dmz, so this is
				// checkUnreachable's finding, not checkBroadAnyRule's (no
				// literal "any" endpoint here) nor checkConflict's (full
				// coverage is excluded from conflict).
				{Name: "allow-corp", Src: []string{"corp"}, Dst: []string{"corp"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
				{Name: "unreachable", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
			},
		},
		{Name: "ORPHAN", DefaultAction: rules.ActionDeny},
	}}
	got := Check(pol, topo)
	if len(got) != 2 {
		t.Fatalf("want 2 findings (unreachable rule + dead chain), got %+v", got)
	}
	if got[0].Chain != "FIRENET-FWD" || got[0].Rules[1] != "unreachable" {
		t.Fatalf("want the unreachable-rule finding first, got %+v", got[0])
	}
	if got[1].Chain != "ORPHAN" {
		t.Fatalf("want the dead-chain finding second, got %+v", got[1])
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/lint/... -run TestCheck_CombinesAllChecksInDocumentedOrder -v`
Expected: build failure — `undefined: Check`.

- [ ] **Step 3: Implement**

Append to `internal/lint/lint.go` (after the `Finding` struct from Task 2):

```go

// Check runs every lint pass against pol and returns their findings.
// Findings are grouped by check — unreachable rules, then conflicting
// overlaps, then mirror issues, then overly broad rules, then dead
// chains — and within each check ordered by chain and rule position, so
// results are fully deterministic across runs of the same policy.
//
// pol must already have passed pol.Validate(topo): Check assumes every
// src/dst name resolves and every jump target exists, and does not
// re-validate structure itself.
func Check(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	out = append(out, checkUnreachable(pol, topo)...)
	out = append(out, checkConflict(pol, topo)...)
	out = append(out, checkMirror(pol, topo)...)
	out = append(out, checkBroadAnyRule(pol)...)
	out = append(out, checkDeadChains(pol)...)
	return out
}
```

`lint.go` had no imports before this task (`Severity`/`Finding` needed none). Insert a new import block right after the package doc comment / `package lint` line and before `type Severity string`:

```go
import (
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/lint/... -v`
Expected: PASS — every test in the package, from Task 1 through this one.

- [ ] **Step 5: Commit**

```bash
git add internal/lint/lint.go internal/lint/lint_test.go
git commit -m "$(cat <<'EOF'
feat(lint): add Check orchestrator tying all five checks together

internal/lint's public surface is now complete: Check(pol, topo) []Finding.
EOF
)"
```

---

## Task 8: `app.Lint` wrapper (`internal/app/lint.go`)

**Files:**
- Create: `internal/app/lint.go`
- Create: `internal/app/lint_test.go`

**Interfaces:**
- Consumes: `lint.Check` (Task 7), `LoadProject` and `discardLogger` (both already exist in `internal/app`, see `internal/app/load.go` and `internal/app/compile_test.go`).
- Produces (used by Task 9's HTTP handler): `func Lint(ctx context.Context, log *slog.Logger, topo *topology.Topology, pol *rules.Policy) ([]lint.Finding, error)`.

- [ ] **Step 1: Write the failing tests**

```go
// internal/app/lint_test.go
package app

import (
	"context"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

const lintAppTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const lintAppSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
`

const lintAppRules = `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: allow-all, comment: "broad by design", src: [any], dst: [any], proto: any, action: allow}
      - {name: shadowed, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: deny}
`

func TestLint_ReturnsFindingsFromValidPolicy(t *testing.T) {
	topo, err := LoadProject([]byte(lintAppTopology), []byte(lintAppSubnets))
	if err != nil {
		t.Fatalf("load project: %v", err)
	}
	pol, err := rules.Load(strings.NewReader(lintAppRules))
	if err != nil {
		t.Fatalf("load rules: %v", err)
	}
	findings, err := Lint(context.Background(), discardLogger(), topo, pol)
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	if len(findings) != 1 || findings[0].Rules[1] != "shadowed" {
		t.Fatalf("want the shadowed rule flagged unreachable, got %+v", findings)
	}
}

func TestLint_InvalidPolicyErrors(t *testing.T) {
	topo, err := LoadProject([]byte(lintAppTopology), []byte(lintAppSubnets))
	if err != nil {
		t.Fatalf("load project: %v", err)
	}
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{{Name: "bad", Src: []string{"no-such-subnet"}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionAllow}},
	}}}
	if _, err := Lint(context.Background(), discardLogger(), topo, pol); err == nil {
		t.Fatal("want error for a rule referencing an unknown subnet")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/app/... -run TestLint -v`
Expected: build failure — `undefined: Lint`.

- [ ] **Step 3: Implement**

```go
// internal/app/lint.go
package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/kudes1/firenet/internal/lint"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// Lint runs the rule linter (internal/lint) against an already-loaded
// project. It validates pol against topo itself (mirroring Diagnose), so
// callers can pass pol straight from rules.Load without validating first.
func Lint(_ context.Context, log *slog.Logger, topo *topology.Topology, pol *rules.Policy) ([]lint.Finding, error) {
	if err := pol.Validate(topo); err != nil {
		return nil, fmt.Errorf("invalid rules: %w", err)
	}
	findings := lint.Check(pol, topo)
	log.Debug("linted rules", "findings", len(findings))
	return findings, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/app/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/app/lint.go internal/app/lint_test.go
git commit -m "$(cat <<'EOF'
feat(app): add Lint wrapper around internal/lint.Check
EOF
)"
```

---

## Task 9: `GET /api/lint` endpoint (`internal/httpapi`)

**Files:**
- Modify: `internal/httpapi/handlers.go` (add `lint` handler, after the `diagnose` handler)
- Modify: `internal/httpapi/server.go` (register the route)
- Modify: `internal/httpapi/handlers_test.go` (add `TestLintEndpoint`)

**Interfaces:**
- Consumes: `app.Lint` (Task 8), `h.loadTopology()` / `h.loadPolicy()` (already exist, `internal/httpapi/handlers.go:189` and `:210`), `writeJSON`/`writeError` (already exist).
- Produces: route `GET /api/lint` → JSON body `{"findings": [...]}` (each element shaped per `lint.Finding`'s JSON tags from Task 2).

- [ ] **Step 1: Write the failing test**

Append to `internal/httpapi/handlers_test.go` (add `"github.com/kudes1/firenet/internal/lint"` to the import block):

```go
func TestLintEndpoint(t *testing.T) {
	h, store := newTestServer(t)

	t.Run("clean policy has no findings", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodGet, "/api/lint", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Findings []lint.Finding `json:"findings"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(out.Findings) != 0 {
			t.Fatalf("want no findings for the default fixture, got %+v", out.Findings)
		}
	})

	t.Run("unreachable rule is reported", func(t *testing.T) {
		if err := store.WriteRules([]byte(`
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: allow-all, comment: "broad by design", src: [any], dst: [any], proto: any, action: allow}
      - {name: shadowed, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: deny}
`)); err != nil {
			t.Fatal(err)
		}
		rec := doJSON(t, h, http.MethodGet, "/api/lint", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Findings []lint.Finding `json:"findings"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Findings) != 1 || out.Findings[0].Chain != "FIRENET-FWD" {
			t.Fatalf("want one unreachable-rule finding, got %+v", out.Findings)
		}
	})

	t.Run("invalid rules file surfaces as client error", func(t *testing.T) {
		if err := store.WriteRules([]byte(`
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: bad, src: [no-such-subnet], dst: [any], proto: any, action: allow}
`)); err != nil {
			t.Fatal(err)
		}
		rec := doJSON(t, h, http.MethodGet, "/api/lint", nil)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/httpapi/... -run TestLintEndpoint -v`
Expected: FAIL — `status 404: ...` (no `GET /api/lint` route registered yet, so `doJSON` hits the mux's default 404 handler).

- [ ] **Step 3: Implement**

In `internal/httpapi/handlers.go`, insert the new handler right after the `diagnose` handler's closing `}` (i.e. right before `func (h *handlers) getLayout`):

```go
func (h *handlers) lint(w http.ResponseWriter, r *http.Request) {
	topo, err := h.loadTopology()
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	pol, err := h.loadPolicy()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parse stored rules: %w", err))
		return
	}
	findings, err := app.Lint(r.Context(), h.log, topo, pol)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": findings})
}
```

In `internal/httpapi/server.go`, register the route right after the diagnose one:

```go
	mux.HandleFunc("POST /api/diagnose", h.diagnose)
	mux.HandleFunc("GET /api/lint", h.lint)
	mux.HandleFunc("GET /api/layout", h.getLayout)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/httpapi/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/handlers.go internal/httpapi/server.go internal/httpapi/handlers_test.go
git commit -m "$(cat <<'EOF'
feat(httpapi): add GET /api/lint endpoint
EOF
)"
```

---

## Task 10: "Проверить" button and findings panel on the rules page

**Files:**
- Modify: `internal/httpapi/web/rules.html`
- Modify: `internal/httpapi/web/rules.js`
- Modify: `internal/httpapi/web/style.css`
- Modify: `internal/httpapi/web/rules_page.test.js`

**Interfaces:**
- Consumes: `GET /api/lint` (Task 9), `Api.get` / `showBanner` (existing, `internal/httpapi/web/common.js`), `switchChain` (existing, `rules.js`).
- Produces: `rulesPage` Alpine component gains state `linting`, `lintOpen`, `lintFindings`, `highlightedRules` and methods `runLint()`, `jumpToFinding(f)`.

- [ ] **Step 1: Write the failing tests**

In `internal/httpapi/web/rules_page.test.js`, change the `bootPage` signature and its `fetch` stub to support a lint fixture:

```js
function bootPage({ failPut = null, lintFindings = [] } = {}) {
```

Add a new branch in the `fetch` stub, right before the final `return { ok: false, status: 404, ... }` fallback:

```js
      if (path_ === "/api/lint") {
        return { ok: true, status: 200, json: async () => ({ findings: lintFindings }) };
      }
```

Append at the end of the file:

```js
test("runLint fetches findings and opens the panel", async () => {
  const ctx = bootPage({
    lintFindings: [{ severity: "warning", chain: "FIRENET-FWD", rules: ["web"], message: "правило web никогда не применяется" }],
  });
  await ctx.page.init();

  await ctx.page.runLint();

  assert.equal(ctx.page.lintOpen, true);
  assert.equal(ctx.page.lintFindings.length, 1);
  assert.equal(ctx.page.lintFindings[0].chain, "FIRENET-FWD");
});

test("jumpToFinding switches to the finding's chain and highlights its rules", async () => {
  const ctx = bootPage();
  await ctx.page.init();
  ctx.page.active = 0;

  ctx.page.jumpToFinding({ severity: "warning", chain: "LIMITED", rules: ["limited-dns"], message: "..." });

  assert.equal(ctx.page.active, 1); // LIMITED is rulesFixture.chains[1]
  assert.deepEqual(ctx.page.highlightedRules, ["limited-dns"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/httpapi/web/rules_page.test.js`
Expected: FAIL — `page.runLint is not a function` / `page.jumpToFinding is not a function`.

- [ ] **Step 3: Implement**

In `internal/httpapi/web/rules.js`, add new state fields right after `searchOpen: false,`:

```js
    searchOpen: false,
    linting: false,
    lintOpen: false,
    lintFindings: [],
    highlightedRules: [],
```

Add new methods right after the `persist` method, before the closing `}));`:

```js
    async persist(next) {
      const doc = await Api.put("/api/rules", { chains: next.chains });
      this._applyDoc(doc);
      showBanner("Правила сохранены", "ok");
    },

    // --- lint ---

    async runLint() {
      this.linting = true;
      try {
        const res = await Api.get("/api/lint");
        this.lintFindings = res.findings || [];
        this.lintOpen = true;
      } catch (e) {
        showBanner("Ошибка проверки правил: " + e.message);
      } finally {
        this.linting = false;
      }
    },

    jumpToFinding(f) {
      const idx = this.doc.chains.findIndex((c) => c.name === f.chain);
      if (idx >= 0) this.switchChain(idx);
      this.highlightedRules = f.rules || [];
      clearTimeout(this._lintHighlightTimer);
      this._lintHighlightTimer = setTimeout(() => { this.highlightedRules = []; }, 2000);
    },
  }));
  });
}
```

In `internal/httpapi/web/rules.html`, add the button next to the existing search button:

```html
        <button type="button" class="secondary btn-search" @click="searchOpen = !searchOpen" title="Поиск по правилам"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.25"/><path d="m13.2 13.2-4.3-4.3"/></svg></button>
        <button type="button" class="secondary" :disabled="linting" @click="runLint()" title="Проверить правила на типичные проблемы">Проверить</button>
        <button type="button" class="primary" @click="openAdd()">+ правило</button>
      </div>
    </div>

    <div class="lint-panel" x-show="lintOpen" x-cloak>
      <header class="lint-panel-header">
        <strong>Находки линтера (<span x-text="lintFindings.length"></span>)</strong>
        <button type="button" class="lint-panel-close" @click="lintOpen = false" title="Закрыть" aria-label="Закрыть">&times;</button>
      </header>
      <div class="lint-panel-body">
        <p class="hint" x-show="!lintFindings.length">Проблем не найдено.</p>
        <template x-for="(f, i) in lintFindings" :key="i">
          <button type="button" class="lint-finding" @click="jumpToFinding(f)">
            <span class="badge" :class="f.severity === 'warning' ? 'badge-warn' : 'badge-info'" x-text="f.severity"></span>
            <span class="lint-finding-chain" x-text="f.chain"></span>
            <span class="lint-finding-msg" x-text="f.message"></span>
          </button>
        </template>
      </div>
    </div>
```

Add the highlight class binding to the rule row `<tr>` (inside `<template x-for="row in filteredRules" :key="row.index">`):

```html
        <template x-for="row in filteredRules" :key="row.index">
          <tr :class="{ 'lint-highlighted': highlightedRules.includes(row.rule.name) }">
```

In `internal/httpapi/web/style.css`, append at the end of the file (after `.diag-steps li::marker { color: var(--accent); font-size: 0.85em; }`):

```css

.badge-warn { background: rgba(245, 158, 11, 0.18); color: #f59e0b; }
.badge-info { background: rgba(59, 130, 246, 0.18); color: #3b82f6; }

.lint-panel {
  position: fixed;
  top: var(--space-4);
  right: var(--space-4);
  width: min(420px, calc(100vw - var(--space-4) * 2));
  max-height: calc(100vh - var(--space-4) * 2);
  overflow-y: auto;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
  z-index: 5;
}
.lint-panel-header { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
.lint-panel-close { background: none; border: none; cursor: pointer; font-size: 1.2em; }
.lint-panel-body { padding: var(--space-2) var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.lint-finding { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2); background: none; cursor: pointer; width: 100%; }
.lint-finding:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.lint-finding-chain { font-size: 0.8em; opacity: 0.7; }
.lint-finding-msg { font-size: 0.9em; }
.lint-highlighted { outline: 2px solid var(--accent); outline-offset: -2px; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/httpapi/web/rules_page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/rules.html internal/httpapi/web/rules.js internal/httpapi/web/style.css internal/httpapi/web/rules_page.test.js
git commit -m "$(cat <<'EOF'
feat(web): add lint findings panel to the rules page

"Проверить" fetches GET /api/lint; clicking a finding switches to its
chain and highlights the affected rule rows.
EOF
)"
```

---

## Task 11: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full Go check sequence**

```bash
go build ./...
go vet ./...
gofmt -l .
go test ./...
```

Expected: `go build`/`go vet`/`go test` all clean; `gofmt -l .` prints nothing.

- [ ] **Step 2: Run the full JS test suite**

```bash
node --test 'internal/httpapi/web/*.test.js'
```

Expected: all pass, including the new/updated `rules_page.test.js` cases.

- [ ] **Step 3: Rebuild the embedded binary**

```bash
make build
```

Expected: succeeds — this refreshes the `go:embed`'d web assets so `./bin/firenet serve` reflects the new UI (per this repo's Gotchas: the binary embeds `internal/httpapi/web/` at build time).

- [ ] **Step 4: Commit if anything drifted**

If any of the above required a fix (e.g. `gofmt -w .`), commit it separately:

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(lint): fix formatting

EOF
)"
```

If nothing drifted, no commit is needed — this task is verification-only.
