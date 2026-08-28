# Switch-Switch Filtered Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a switch-switch link carry the same `aExports`/`bExports` route filter a router-router link already supports, so a real trunk between two switches doesn't have to flatten both sides into one L2 domain.

**Architecture:** A filtered switch-switch link is excluded from L2-domain merging (`assignL2Domains`) and instead becomes an announce-oriented edge (`Edge.Allow`) between the two domain bus nodes its switches end up in — structurally identical to how a filtered router-router link already works between two router nodes. Reachability computation for the "Связи" UI's export candidates gets the matching fix so a switch-side device resolves to its domain node instead of a nonexistent router node.

**Tech Stack:** Go (stdlib only, no new dependencies). Existing packages: `internal/topology`, `internal/graph`, `internal/diagnose`.

**Spec:** `docs/superpowers/specs/2026-08-28-switch-filtered-links-design.md`

## Global Constraints

- A filtered link (`topology.LinkFilter`) must connect two devices of the same kind, and that kind must be router or switch — mixed router↔switch stays rejected.
- A filtered switch-switch link never merges its two switches into one L2 domain; unfiltered switch-switch links merge exactly as today.
- If a filtered switch link's two switches end up in the same domain anyway (merged via another unfiltered path), no domain-domain edge is added — that pairing is a documented no-op, not an error.
- A domain with fewer than 2 local attach points still gets its bus node built when it participates in at least one filtered switch link (otherwise its one local point would be stranded).
- Adding a second `Allow`-restricted edge between the same `(from, to)` pair must union the two `Allow.To` sets, not silently keep only the first; an unconditional (`Allow == nil`) edge always wins over a restricted one.
- No HTTP API or web asset changes: `links.js`/`links.html`/`topology.js` are already generic over `Link.Filter` regardless of device kind.
- Verification commands for every task: `go build ./...`, `go vet ./...`, `gofmt -l .`, plus the task's own `go test` targets.

---

### Task 1: Allow filtered links between two switches

**Files:**
- Modify: `internal/topology/validate.go:70-73`
- Test: `internal/topology/validate_test.go`

**Interfaces:**
- Consumes: `topology.DeviceRouter`, `topology.DeviceSwitch` (existing `DeviceKind` constants), `topology.Topology.Devices map[string]Device`, `topology.Link.Filter *LinkFilter`.
- Produces: `(*Topology).Validate() error` now accepts a `Filter` on two routers or two switches; still rejects a mixed pair with an error containing `"filtered link must connect two routers or two switches"`.

- [ ] **Step 1: Write the failing tests**

Add to `internal/topology/validate_test.go` (near the existing `TestValidate_FilteredLink_*` tests, e.g. right after `TestValidate_FilteredLink_OK` at line 237):

```go
func TestValidate_FilteredLink_TwoSwitchesOK(t *testing.T) {
	topo := baseTopology(t)
	topo.Devices["sw1"] = Device{Name: "sw1", Kind: DeviceSwitch}
	topo.Devices["sw2"] = Device{Name: "sw2", Kind: DeviceSwitch}
	topo.Links = append(topo.Links, Link{
		A: Endpoint{"sw1"}, B: Endpoint{"sw2"},
		Filter: &LinkFilter{AExports: []string{"n1"}, BExports: []string{"n2"}},
	})
	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_FilteredLink_RejectsMixedRouterSwitch(t *testing.T) {
	topo := baseTopology(t)
	topo.Devices["sw"] = Device{Name: "sw", Kind: DeviceSwitch}
	topo.Links[0] = Link{
		A: Endpoint{"r1"}, B: Endpoint{"sw"},
		Filter: &LinkFilter{AExports: []string{"n1"}, BExports: []string{"n2"}},
	}
	err := topo.Validate()
	if err == nil || !strings.Contains(err.Error(), "two routers or two switches") {
		t.Fatalf("expected mixed-kind error, got: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/topology/... -run TestValidate_FilteredLink -v`
Expected: `TestValidate_FilteredLink_TwoSwitchesOK` FAILs with the current `"filtered link must connect two routers"` error (since sw1/sw2 aren't routers). `TestValidate_FilteredLink_RejectsMixedRouterSwitch` passes already (existing behavior) — that's fine, it stays green through this change.

- [ ] **Step 3: Relax the validation check**

In `internal/topology/validate.go`, replace (around line 70-73):

```go
		if l.Filter != nil {
			if t.Devices[l.A.Device].Kind != DeviceRouter || t.Devices[l.B.Device].Kind != DeviceRouter {
				return fmt.Errorf("%s: filtered link must connect two routers", where)
			}
```

with:

```go
		if l.Filter != nil {
			aKind, bKind := t.Devices[l.A.Device].Kind, t.Devices[l.B.Device].Kind
			if aKind != bKind || (aKind != DeviceRouter && aKind != DeviceSwitch) {
				return fmt.Errorf("%s: filtered link must connect two routers or two switches", where)
			}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/topology/... -v`
Expected: PASS, including every pre-existing `TestValidate_*` test (the existing `TestValidate_FilteredLink_NeedsTwoRouters` test asserts the error contains `"two routers"`, which is still a substring of the new message, so it keeps passing unmodified).

- [ ] **Step 5: Commit**

```bash
git add internal/topology/validate.go internal/topology/validate_test.go
git commit -m "$(cat <<'EOF'
feat(topology): allow filtered links between two switches

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Split filtered switch-switch links out of L2-domain merging

**Files:**
- Modify: `internal/graph/graph.go` (the `Build` function, `internal/graph/graph.go:99-174`)
- Test: `internal/graph/graph_test.go`

**Interfaces:**
- Consumes: `topology.Topology.Devices/Links/Networks`, `topology.LinkFilter{AExports, BExports []string}`, existing unexported `exportSubnets(topo *topology.Topology, names []string) (map[string]struct{}, error)`, existing unexported `assignL2Domains(topo *topology.Topology, switchLinks []topology.Link) map[string]string`, `edgeAllow{To map[string]struct{}}`, `domainNode(name string) Node`.
- Produces (new unexported helpers other tasks/tests rely on):
  - `splitSwitchLinks(topo *topology.Topology) (plain, filtered []topology.Link)` — every switch-switch link, partitioned by whether it carries a `Filter`.
  - `addFilteredSwitchEdges(g *Graph, topo *topology.Topology, domainOf map[string]string, links []topology.Link) error` — wires the announce-oriented domain-domain edges for `filtered` links.
  - `Build`'s behavior: a filtered switch-switch link no longer merges its two switches' domains; `AllSimplePaths` between subnets on either side now honors the filter's `Allow` the same way a router-router filtered link does.

- [ ] **Step 1: Write the failing tests**

Add to `internal/graph/graph_test.go` (after `TestBuild_MultiSwitchDomainJoinedName`, before `func filteredTopo()`):

```go
// filteredSwitchTopo mirrors filteredTopo (below) but the filter sits on a
// switch-switch link instead of a router-router one: m is behind sw1; d
// and o are both behind sw2, so sw2's domain already has >=2 local attach
// points on its own (m's sw1 domain has only 1 — that side exercises the
// "domain gets a bus even with <2 points" exception).
func filteredSwitchTopo(t *testing.T) *topology.Topology {
	return &topology.Topology{
		Devices: map[string]topology.Device{
			"m":   {Name: "m", Kind: topology.DeviceRouter},
			"d":   {Name: "d", Kind: topology.DeviceRouter},
			"o":   {Name: "o", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: prefix(t, "10.0.0.0/24")},
			"b": {Name: "b", CIDR: prefix(t, "10.0.1.0/24")},
			"c": {Name: "c", CIDR: prefix(t, "10.0.2.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": netWithSubnets("NA", []string{"a"}, topology.Endpoint{Device: "m"}),
			"NB": netWithSubnets("NB", []string{"b"}, topology.Endpoint{Device: "d"}),
			"NC": netWithSubnets("NC", []string{"c"}, topology.Endpoint{Device: "o"}),
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "m"}, B: topology.Endpoint{Device: "sw1"}},
			{A: topology.Endpoint{Device: "d"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "o"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"},
				Filter: &topology.LinkFilter{AExports: []string{"NA"}, BExports: []string{"NB"}}},
		},
	}
}

func TestBuild_FilteredSwitchLinkSplitsDomains(t *testing.T) {
	topo := filteredSwitchTopo(t)
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("b"), DefaultLimits())
	if err != nil || len(paths) != 1 {
		t.Fatalf("a->b: got %d paths (%v), want 1 (b is announced by sw2's side of the filter)", len(paths), err)
	}
	foundSw1, foundSw2 := false, false
	for _, n := range paths[0].Nodes {
		if n == (Node{Kind: NodeDomain, Name: "sw1"}) {
			foundSw1 = true
		}
		if n == (Node{Kind: NodeDomain, Name: "sw2"}) {
			foundSw2 = true
		}
	}
	if !foundSw1 || !foundSw2 {
		t.Fatalf("path %+v must cross sw1 and sw2 as two separate domains, not a merged sw1+sw2", paths[0].Nodes)
	}
}

func TestBuild_FilteredSwitchLinkBlocksUnannouncedDst(t *testing.T) {
	topo := filteredSwitchTopo(t)
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("c"), DefaultLimits())
	if err != nil || len(paths) != 0 {
		t.Fatalf("a->c must be filtered out (c is not in the sw1-sw2 filter's BExports), got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_FilteredSwitchLinkNoOpWhenAlreadyMerged(t *testing.T) {
	// sw1 and sw2 are also joined via sw3 through plain links, so the
	// filtered sw1-sw2 link connects two switches that are already in the
	// same domain: it must contribute no extra edge, and definitely not a
	// second, phantom domain.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"r2":  {Name: "r2", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
			"sw3": {Name: "sw3", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw1"}},
			{A: topology.Endpoint{Device: "r2"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw3"}},
			{A: topology.Endpoint{Device: "sw3"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"},
				Filter: &topology.LinkFilter{AExports: []string{"NA"}, BExports: []string{"NB"}}},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: prefix(t, "10.0.0.0/24")},
			"b": {Name: "b", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": netWithSubnets("NA", []string{"a"}, topology.Endpoint{Device: "r1"}),
			"NB": netWithSubnets("NB", []string{"b"}, topology.Endpoint{Device: "r2"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("b"), DefaultLimits())
	if err != nil || len(paths) != 1 {
		t.Fatalf("sw1 and sw2 are already merged via sw3: got %d paths (%v), want exactly 1 through one merged domain", len(paths), err)
	}
	want := Node{Kind: NodeDomain, Name: "sw1+sw2+sw3"}
	found := false
	for _, n := range paths[0].Nodes {
		if n == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("path %+v must cross the single merged domain %+v; the filtered sw1-sw2 link must not fork off a second one", paths[0].Nodes, want)
	}
}

func TestBuild_LonelySwitchStaysUnwiredWithoutFilteredLink(t *testing.T) {
	// Regression guard: a switch with exactly one local attach point and
	// no filtered link of its own still gets no bus node — the new "keep
	// the bus even with <2 points" exception must not fire here.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw1"}},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: prefix(t, "10.0.0.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": netWithSubnets("NA", []string{"a"}, topology.Endpoint{Device: "r1"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// r1 legitimately has one edge of its own (to subnet "a", from its
	// direct network attachment) regardless of the switch link — that
	// edge is not what this test is about. What must NOT happen is r1
	// getting wired to sw1's bus, and the bus itself must not exist.
	bus := Node{Kind: NodeDomain, Name: "sw1"}
	if len(g.adj[bus]) != 0 {
		t.Fatalf("a lone switch with one attach point and no filtered link must have no bus node, got adj[bus]=%v", g.adj[bus])
	}
	for _, e := range g.adj[RouterNode("r1")] {
		if e.To == bus {
			t.Fatalf("r1 must not be wired to sw1's bus when sw1 has <2 points and no filtered link, got edge to %v", e.To)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/graph/... -run TestBuild_FilteredSwitchLink -v`
Expected: `TestBuild_FilteredSwitchLinkSplitsDomains` fails at `topo.Validate()` (Task 1 already landed, so validation itself passes) or, once past validation, fails because today's `assignL2Domains` merges sw1 and sw2 into domain `"sw1+sw2"` regardless of the filter — the path exists but never crosses two separate domain nodes, so the `foundSw1 && foundSw2` assertion fails. `TestBuild_FilteredSwitchLinkBlocksUnannouncedDst` fails because `a->c` is currently reachable (1 path, not 0) since sw1/sw2 are one flat domain today.

- [ ] **Step 3: Implement domain splitting and the filtered domain-domain edge**

Replace the whole `Build` function in `internal/graph/graph.go` (currently lines 99-174) with:

```go
// Build derives the router/subnet graph. It assumes topo has already passed
// Validate (link references are known to be well-formed).
func Build(topo *topology.Topology) (*Graph, error) {
	g := newGraph()

	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		if aIsSwitch || bIsSwitch {
			continue
		}
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
		g.addEdgeAllow(RouterNode(l.A.Device), RouterNode(l.B.Device), ab)
		g.addEdgeAllow(RouterNode(l.B.Device), RouterNode(l.A.Device), ba)
	}

	plainSwitchLinks, filteredSwitchLinks := splitSwitchLinks(topo)
	domainOf := assignL2Domains(topo, plainSwitchLinks)

	// A domain that anchors a filtered switch link needs its bus node even
	// with a single local attach point below (see the loop over
	// domainPoints further down): that point is no longer stranded, it has
	// the filtered link's peer domain on its other side.
	domainsWithFilteredLink := make(map[string]bool, len(filteredSwitchLinks)*2)
	for _, l := range filteredSwitchLinks {
		domainsWithFilteredLink[domainOf[l.A.Device]] = true
		domainsWithFilteredLink[domainOf[l.B.Device]] = true
	}

	domainPoints := make(map[string][]attachPoint)
	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		switch {
		case aIsSwitch && !bIsSwitch:
			name := domainOf[l.A.Device]
			domainPoints[name] = append(domainPoints[name], attachPoint{node: RouterNode(l.B.Device)})
		case bIsSwitch && !aIsSwitch:
			name := domainOf[l.B.Device]
			domainPoints[name] = append(domainPoints[name], attachPoint{node: RouterNode(l.A.Device)})
		}
	}

	// Every subnet inherits the attachment of its owning network (one
	// network = one L2 segment; Validate guarantees a single owner).
	for _, n := range topo.Networks {
		for _, ref := range n.Attach {
			dev := topo.Devices[ref.Device]
			for _, sname := range n.Subnets {
				switch dev.Kind {
				case topology.DeviceSwitch:
					name := domainOf[ref.Device]
					domainPoints[name] = append(domainPoints[name], attachPoint{node: SubnetNode(sname)})
				case topology.DeviceRouter:
					g.addUndirected(RouterNode(ref.Device), SubnetNode(sname))
				}
			}
		}
	}

	for name, points := range domainPoints {
		if len(points) < 2 && !domainsWithFilteredLink[name] {
			continue // nothing on the other side of this switch to reach
		}
		bus := domainNode(name)
		for _, p := range points {
			g.addUndirected(p.node, bus)
		}
	}

	if err := addFilteredSwitchEdges(g, topo, domainOf, filteredSwitchLinks); err != nil {
		return nil, err
	}

	return g, nil
}

// splitSwitchLinks partitions the switch-switch links of topo into plain
// (feeding assignL2Domains's merge) and filtered (route-filtered like a
// router-router link, kept out of the merge — see addFilteredSwitchEdges).
func splitSwitchLinks(topo *topology.Topology) (plain, filtered []topology.Link) {
	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		if !aIsSwitch || !bIsSwitch {
			continue
		}
		if l.Filter != nil {
			filtered = append(filtered, l)
		} else {
			plain = append(plain, l)
		}
	}
	return plain, filtered
}

// addFilteredSwitchEdges wires each filtered switch-switch link as an
// announce-oriented edge between the two domain bus nodes its switches
// belong to — exactly like a filtered router-router link, but on domain
// nodes instead of router nodes. A link whose switches ended up in the
// same domain anyway (merged via another, unfiltered path) contributes no
// edge: the domains are already one and the same, nothing to restrict.
func addFilteredSwitchEdges(g *Graph, topo *topology.Topology, domainOf map[string]string, links []topology.Link) error {
	for _, l := range links {
		domA, domB := domainOf[l.A.Device], domainOf[l.B.Device]
		if domA == domB {
			continue
		}
		aExports, err := exportSubnets(topo, l.Filter.AExports)
		if err != nil {
			return fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
		}
		bExports, err := exportSubnets(topo, l.Filter.BExports)
		if err != nil {
			return fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
		}
		g.addEdgeAllow(domainNode(domA), domainNode(domB), &edgeAllow{To: bExports})
		g.addEdgeAllow(domainNode(domB), domainNode(domA), &edgeAllow{To: aExports})
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/graph/... -v`
Expected: PASS, including every pre-existing `TestBuild_*` test in the file (none of the earlier fixtures use a filtered switch-switch link, so `filteredSwitchLinks` is empty for them and behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add internal/graph/graph.go internal/graph/graph_test.go
git commit -m "$(cat <<'EOF'
feat(graph): split filtered switch-switch links out of L2-domain merging

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Union duplicate announce-oriented edges instead of dropping them

**Files:**
- Modify: `internal/graph/graph.go:79-86` (`addEdgeAllow`)
- Test: `internal/graph/graph_test.go`

**Interfaces:**
- Consumes: `Edge{To Node, Allow *edgeAllow}`, `edgeAllow{To map[string]struct{}}`, `g.adj map[Node][]Edge` (from Task 2's `addFilteredSwitchEdges`, which can now call `addEdgeAllow` twice for the same `(from, to)` pair when two different filtered switch links resolve to the same domain pair).
- Produces: `(*Graph).addEdgeAllow(from, to Node, allow *edgeAllow)` now merges instead of silently keeping only the first call for a given `(from, to)`.

- [ ] **Step 1: Write the failing test**

Add to `internal/graph/graph_test.go` (after `TestBuild_LonelySwitchStaysUnwiredWithoutFilteredLink` from Task 2):

```go
func TestBuild_TwoFilteredSwitchLinksOnSameDomainPairUnionExports(t *testing.T) {
	// sw1a/sw1b merge into one domain, sw2a/sw2b merge into another; two
	// separate filtered links (sw1a-sw2a and sw1b-sw2b) both connect that
	// same pair of domains, each announcing a different subnet. Both must
	// stay reachable — the second link's announcement must not be
	// silently dropped in favor of the first.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1a":  {Name: "r1a", Kind: topology.DeviceRouter},
			"r1b":  {Name: "r1b", Kind: topology.DeviceRouter},
			"r2a":  {Name: "r2a", Kind: topology.DeviceRouter},
			"r2b":  {Name: "r2b", Kind: topology.DeviceRouter},
			"sw1a": {Name: "sw1a", Kind: topology.DeviceSwitch},
			"sw1b": {Name: "sw1b", Kind: topology.DeviceSwitch},
			"sw2a": {Name: "sw2a", Kind: topology.DeviceSwitch},
			"sw2b": {Name: "sw2b", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1a"}, B: topology.Endpoint{Device: "sw1a"}},
			{A: topology.Endpoint{Device: "r1b"}, B: topology.Endpoint{Device: "sw1b"}},
			{A: topology.Endpoint{Device: "r2a"}, B: topology.Endpoint{Device: "sw2a"}},
			{A: topology.Endpoint{Device: "r2b"}, B: topology.Endpoint{Device: "sw2b"}},
			{A: topology.Endpoint{Device: "sw1a"}, B: topology.Endpoint{Device: "sw1b"}},
			{A: topology.Endpoint{Device: "sw2a"}, B: topology.Endpoint{Device: "sw2b"}},
			{A: topology.Endpoint{Device: "sw1a"}, B: topology.Endpoint{Device: "sw2a"},
				Filter: &topology.LinkFilter{AExports: []string{"NA1"}, BExports: []string{"NB1"}}},
			{A: topology.Endpoint{Device: "sw1b"}, B: topology.Endpoint{Device: "sw2b"},
				Filter: &topology.LinkFilter{AExports: []string{"NA2"}, BExports: []string{"NB2"}}},
		},
		Subnets: map[string]topology.Subnet{
			"A1": {Name: "A1", CIDR: prefix(t, "10.0.0.0/24")},
			"A2": {Name: "A2", CIDR: prefix(t, "10.0.1.0/24")},
			"B1": {Name: "B1", CIDR: prefix(t, "10.0.2.0/24")},
			"B2": {Name: "B2", CIDR: prefix(t, "10.0.3.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA1": netWithSubnets("NA1", []string{"A1"}, topology.Endpoint{Device: "r1a"}),
			"NA2": netWithSubnets("NA2", []string{"A2"}, topology.Endpoint{Device: "r1b"}),
			"NB1": netWithSubnets("NB1", []string{"B1"}, topology.Endpoint{Device: "r2a"}),
			"NB2": netWithSubnets("NB2", []string{"B2"}, topology.Endpoint{Device: "r2b"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	for _, pair := range [][2]string{{"A1", "B1"}, {"A1", "B2"}, {"A2", "B1"}, {"A2", "B2"}} {
		paths, err := g.AllSimplePaths(SubnetNode(pair[0]), SubnetNode(pair[1]), DefaultLimits())
		if err != nil || len(paths) != 1 {
			t.Fatalf("%s->%s: got %d paths (%v), want 1 (union of both filtered links' exports)", pair[0], pair[1], len(paths), err)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/graph/... -run TestBuild_TwoFilteredSwitchLinksOnSameDomainPairUnionExports -v`
Expected: FAILs on `A1->B2` and `A2->B1` (0 paths instead of 1) — today's `addEdgeAllow` keeps only the first call's `Allow` for a given `(from, to)` pair and silently ignores the second, so `B2`/`A2` never get announced on the shared domain-domain edge.

- [ ] **Step 3: Merge instead of dropping on a duplicate edge**

In `internal/graph/graph.go`, replace `addEdgeAllow` (currently lines 79-86):

```go
func (g *Graph) addEdgeAllow(from, to Node, allow *edgeAllow) {
	for _, e := range g.adj[from] {
		if e.To == to {
			return
		}
	}
	g.adj[from] = append(g.adj[from], Edge{To: to, Allow: allow})
}
```

with:

```go
// addEdgeAllow adds an edge from->to, or, if one already exists, merges
// allow into it instead of keeping only the first caller's restriction: an
// unconditional edge (Allow == nil) always wins, and two restricted edges
// union their announced destinations (either one having announced dst is
// enough for real routing to have learned it).
func (g *Graph) addEdgeAllow(from, to Node, allow *edgeAllow) {
	for i, e := range g.adj[from] {
		if e.To != to {
			continue
		}
		switch {
		case e.Allow == nil:
			// already unconditional: a further restriction can't narrow it
		case allow == nil:
			g.adj[from][i].Allow = nil // any unconditional announcement wins
		default:
			for name := range allow.To {
				e.Allow.To[name] = struct{}{}
			}
		}
		return
	}
	g.adj[from] = append(g.adj[from], Edge{To: to, Allow: allow})
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/graph/... -v`
Expected: PASS, including all of Task 1 and Task 2's tests.

- [ ] **Step 5: Commit**

```bash
git add internal/graph/graph.go internal/graph/graph_test.go
git commit -m "$(cat <<'EOF'
fix(graph): union duplicate announce-oriented edges instead of dropping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Fix export-candidate reachability for switch-side devices

**Files:**
- Modify: `internal/graph/reachable.go:17-34` (`ReachableEntities`)
- Test: `internal/graph/reachable_test.go`

**Interfaces:**
- Consumes: `splitSwitchLinks(topo *topology.Topology) (plain, filtered []topology.Link)` and `assignL2Domains(topo *topology.Topology, switchLinks []topology.Link) map[string]string` (from Task 2), `domainNode(name string) Node`, `RouterNode(name string) Node`, `plainReachableSubnets(g *Graph, start Node) []string` (unchanged).
- Produces: new unexported `startNode(topo *topology.Topology, device string) (Node, error)`; `ReachableEntities` now returns correct candidates when `device` is a switch (previously always empty).

- [ ] **Step 1: Write the failing test**

Add to `internal/graph/reachable_test.go` (after `TestReachableEntities_DeviceBehindSwitchOwnsItsNetwork`):

```go
func TestReachableEntities_SwitchDeviceItself(t *testing.T) {
	// Today ReachableEntities always starts from RouterNode(device), which
	// never exists for a switch — candidates for a switch-side filtered
	// link silently come back empty. sw1's own network must be in reach.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"r2":  {Name: "r2", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw1"}},
			{A: topology.Endpoint{Device: "r2"}, B: topology.Endpoint{Device: "sw2"}},
			*filter(&topology.Link{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"}}, []string{"NA"}, []string{"NB"}),
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"b": {Name: "b", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": {Name: "NA", Subnets: []string{"a"}, Attach: []topology.Endpoint{{Device: "r1"}}},
			"NB": {Name: "NB", Subnets: []string{"b"}, Attach: []topology.Endpoint{{Device: "r2"}}},
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	got, err := ReachableEntities(topo, "sw1", 2) // exclude the filtered sw1-sw2 link itself
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"NA", "a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if err := ValidateFilterExports(topo); err != nil {
		t.Fatalf("own-network export rejected: %v", err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/graph/... -run TestReachableEntities_SwitchDeviceItself -v`
Expected: FAIL — `got []` (nil), `want [NA a]`, because `RouterNode("sw1")` has no edges in the graph.

- [ ] **Step 3: Resolve the correct start node(s)**

**Note (ruling, recorded after this step was first attempted):** the version
below is corrected from the plan's original draft. The original draft always
returned a single `domainNode(domainOf[device])` for a switch. That is wrong:
`Build` only wires a domain's local points to its bus node when the domain
has ≥2 of them or a *surviving* filtered link anchors it — and
`ReachableEntities` always excludes the very link a caller is asking about,
which is routinely a domain's only qualifying reason. So the domain node can
end up with zero edges in the trimmed graph, and the original draft's
`TestReachableEntities_SwitchDeviceItself` (below) would fail against its own
prescribed code. The corrected version resolves a switch to *every one* of
its domain's own attach points directly (each router on it, each subnet whose
network attaches to it) instead of relying on the bus node alone.

In `internal/graph/reachable.go`, replace:

```go
	local := plainReachableSubnets(g, RouterNode(device))
```

with:

```go
	starts, err := startNodes(&trimmed, device)
	if err != nil {
		return nil, err
	}
	local := plainReachableSubnets(g, starts)
```

Then add, right after the `ReachableEntities` function:

```go
// startNodes resolves the graph node(s) standing in for device: a router
// is always its own single node. A switch has no node of its own — it is
// represented by its L2-domain bus (see Build) — but that bus node can
// have no edges in a graph built with one of its links excluded: Build
// only wires a domain's local points (routers, direct subnets) to its bus
// when the domain has >=2 of them or a surviving filtered link anchors
// it, and ReachableEntities always excludes the very link a caller is
// asking about — routinely a domain's only qualifying reason. So a switch
// resolves to every one of its domain's own attach points directly (each
// router on it, each subnet whose network attaches to it) in addition to
// the domain node itself — the domain node still matters when a
// *different*, still-present filtered link wires it onward elsewhere.
func startNodes(topo *topology.Topology, device string) ([]Node, error) {
	d, ok := topo.Devices[device]
	if !ok {
		return nil, fmt.Errorf("unknown device %q", device)
	}
	if d.Kind == topology.DeviceRouter {
		return []Node{RouterNode(device)}, nil
	}

	plainLinks, _ := splitSwitchLinks(topo)
	domainOf := assignL2Domains(topo, plainLinks)
	domain := domainOf[device]

	seen := map[Node]bool{}
	var starts []Node
	add := func(n Node) {
		if !seen[n] {
			seen[n] = true
			starts = append(starts, n)
		}
	}
	add(domainNode(domain))

	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		switch {
		case aIsSwitch && !bIsSwitch && domainOf[l.A.Device] == domain:
			add(RouterNode(l.B.Device))
		case bIsSwitch && !aIsSwitch && domainOf[l.B.Device] == domain:
			add(RouterNode(l.A.Device))
		}
	}
	for _, n := range topo.Networks {
		for _, ref := range n.Attach {
			if topo.Devices[ref.Device].Kind != topology.DeviceSwitch || domainOf[ref.Device] != domain {
				continue
			}
			for _, sname := range n.Subnets {
				add(SubnetNode(sname))
			}
		}
	}
	return starts, nil
}
```

`plainReachableSubnets` must accept multiple seeds now. Replace it (it lives
a little further down the same file):

```go
func plainReachableSubnets(g *Graph, start Node) []string {
	seen := map[Node]bool{start: true}
	queue := []Node{start}
```

with:

```go
// plainReachableSubnets BFSes from every node in starts over unrestricted
// edges only (no filtered-link hops) and returns the subnet names reached
// — the seeds that count as "locally available" for export candidates.
// Going through switch domains counts, so a router behind a switch owns
// its segment's subnets.
func plainReachableSubnets(g *Graph, starts []Node) []string {
	seen := map[Node]bool{}
	var queue []Node
	for _, s := range starts {
		if !seen[s] {
			seen[s] = true
			queue = append(queue, s)
		}
	}
```

(keep the existing doc comment's replacement — the one above already
supersedes the original "BFSes from start..." comment, delete the old one so
it isn't duplicated.)

Also update the doc comment above `ReachableEntities` (currently "reachable from router device") to say "from device (router or switch)".

Add this second test right after `TestReachableEntities_SwitchDeviceItself` in
`internal/graph/reachable_test.go`, covering the case the original draft's
test didn't — zero router attach points, a subnet attached directly to the
switch, reachable elsewhere only through the very filtered link being
validated:

```go
func TestReachableEntities_SwitchWithNoRouterOwnsDirectSubnet(t *testing.T) {
	// sw1 has no router of its own at all — its only network attaches
	// directly to the switch, and its only route elsewhere is the very
	// filtered link being validated. The domain bus for a single-point,
	// filter-only domain never gets wired in the trimmed graph, so sw1's
	// own subnet must still count as locally reachable regardless.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r2":  {Name: "r2", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r2"}, B: topology.Endpoint{Device: "sw2"}},
			*filter(&topology.Link{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"}}, []string{"NA"}, []string{"NB"}),
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"b": {Name: "b", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": {Name: "NA", Subnets: []string{"a"}, Attach: []topology.Endpoint{{Device: "sw1"}}},
			"NB": {Name: "NB", Subnets: []string{"b"}, Attach: []topology.Endpoint{{Device: "r2"}}},
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	got, err := ReachableEntities(topo, "sw1", 1) // exclude the filtered sw1-sw2 link itself
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"NA", "a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if err := ValidateFilterExports(topo); err != nil {
		t.Fatalf("own-network export rejected: %v", err)
	}
}
```

The controller has already verified this exact corrected code compiles and
all of `internal/graph`'s tests (including both new tests above) pass —
this is not a fresh design, it's a verified correction.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/graph/... -v`
Expected: PASS, including every pre-existing `TestReachableEntities_*` and `TestValidateFilterExports` test.

- [ ] **Step 5: Commit**

```bash
git add internal/graph/reachable.go internal/graph/reachable_test.go
git commit -m "$(cat <<'EOF'
fix(graph): resolve switch devices to their domain node in ReachableEntities

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end diagnose coverage

**Files:**
- Test: `internal/diagnose/diagnose_test.go`

**Interfaces:**
- Consumes: `topology.Load`/`topology.LoadSubnets` (YAML parsing), `graph.Build`, `graph.DefaultLimits()`, `diagnose.Run(topo *topology.Topology, sets []compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, flow diagnose.Flow) (*diagnose.Report, error)`, `diagnose.Report{Paths []PathResult, ReturnRouteExists bool}` — all unchanged signatures, exercising Tasks 1-4 together through the public diagnose API.
- Produces: no new production code — this task is pure regression/behavior coverage at the package boundary the user actually observed the original bug through.

- [ ] **Step 1: Write the failing (well, currently-erroring-on-validate) tests**

Add to `internal/diagnose/diagnose_test.go` (after `TestRun_ReturnRouteExists_FalseWhenRouteNotAnnouncedBack`, i.e. at the end of the file):

```go
const switchFilterDiagTopology = `
devices:
  - {name: ra, kind: router}
  - {name: rb, kind: router}
  - {name: rc, kind: router}
  - {name: sw-a, kind: switch}
  - {name: sw-b, kind: switch}
links:
  - {a: {device: ra}, b: {device: sw-a}}
  - {a: {device: rb}, b: {device: sw-b}}
  - {a: {device: rc}, b: {device: sw-b}}
  - a: {device: sw-a}
    b: {device: sw-b}
    filter: {a-exports: [NA], b-exports: [NB]}
networks:
  - {name: NA, subnets: [a], attach: [{device: ra}]}
  - {name: NB, subnets: [b], attach: [{device: rb}]}
  - {name: NC, subnets: [c], attach: [{device: rc}]}
`

const switchFilterDiagSubnets = `
subnets:
  - {name: a, cidr: 10.20.0.0/24}
  - {name: b, cidr: 10.20.1.0/24}
  - {name: c, cidr: 10.20.2.0/24}
`

// A filtered switch-switch link constrains route propagation across the
// trunk exactly like a filtered router-router link: b is announced across
// sw-a→sw-b (BExports) and stays reachable, c is not and becomes
// unreachable at the network layer — not because of any firewall verdict
// (sets is nil: every router allows unconditionally), a routing gap.
func TestRun_FilteredSwitchLinkConstrainsPropagation(t *testing.T) {
	topo, err := topology.Load(strings.NewReader(switchFilterDiagTopology))
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := topology.LoadSubnets(strings.NewReader(switchFilterDiagSubnets))
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

	repAB, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.20.0.5"), Dst: netip.MustParseAddr("10.20.1.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run a->b: %v", err)
	}
	if len(repAB.Paths) == 0 {
		t.Fatal("a->b: expected a path, b is announced across the sw-a/sw-b trunk")
	}
	if !repAB.ReturnRouteExists {
		t.Fatal("a->b: return route must exist, a is announced back across the same trunk")
	}

	repAC, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.20.0.5"), Dst: netip.MustParseAddr("10.20.2.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run a->c: %v", err)
	}
	if len(repAC.Paths) != 0 {
		t.Fatalf("a->c: expected no path, c was never announced across the sw-a/sw-b trunk, got %+v", repAC.Paths)
	}
	// The return direction is NOT the mirror of the blocked forward path:
	// dst=a is announced via aExports regardless of which router on
	// sw-b's domain sends it (source is never checked — route-filtering
	// is destination-oriented, see internal/graph), so c can still reach
	// a even though nothing can reach c. ReturnRouteExists tracks exactly
	// this asymmetry, the same way TestBuild_FilteredLinkPropagatesLearnedRouteAcrossPlainLink
	// does at the router-router level.
	if !repAC.ReturnRouteExists {
		t.Fatal("a->c: c can still reach a via aExports regardless of source, so the return route does exist at the network layer")
	}
}

// Regression guard for the original bug report: an *unfiltered* switch
// link still merges both switches into one L2 domain, so c (behind rc, on
// sw-b like b) stays reachable from a in a single path. Nothing in Tasks
// 1-4 should have changed this.
func TestRun_PlainSwitchLinkStillMergesDomain(t *testing.T) {
	topo, err := topology.Load(strings.NewReader(switchFilterDiagTopology))
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	topo.Links[3].Filter = nil // same topology, plain sw-a/sw-b link
	subs, err := topology.LoadSubnets(strings.NewReader(switchFilterDiagSubnets))
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
		Src: netip.MustParseAddr("10.20.0.5"), Dst: netip.MustParseAddr("10.20.2.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run a->c: %v", err)
	}
	if len(rep.Paths) != 1 {
		t.Fatalf("a->c: expected exactly 1 path through the merged sw-a+sw-b domain, got %+v", rep.Paths)
	}
}
```

- [ ] **Step 2: Run the tests**

Run: `go test ./internal/diagnose/... -run 'TestRun_FilteredSwitchLinkConstrainsPropagation|TestRun_PlainSwitchLinkStillMergesDomain' -v`
Expected: PASS immediately — Tasks 1-4 already implement everything these tests exercise; this task adds coverage at the package boundary the user's bug report came through, it doesn't change production code.

If either test fails, do not patch it by loosening the assertion — stop and re-check Tasks 1-4 against this plan's code blocks first (see `superpowers:systematic-debugging`).

- [ ] **Step 3: Commit**

```bash
git add internal/diagnose/diagnose_test.go
git commit -m "$(cat <<'EOF'
test(diagnose): cover switch-switch filtered links end to end

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full verification pass

**Files:** none (verification only).

**Interfaces:** none — this task runs the project's standard checks across everything touched by Tasks 1-5.

- [ ] **Step 1: Build, vet, format**

Run:
```bash
go build ./...
go vet ./...
gofmt -l .
```
Expected: all three exit clean (`gofmt -l .` prints nothing).

- [ ] **Step 2: Full Go test suite**

Run: `go test ./...`
Expected: PASS across every package, no regressions in `internal/topology`, `internal/graph`, `internal/diagnose`, `internal/compiler`, `internal/httpapi`.

- [ ] **Step 3: Web asset tests**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: PASS, including `links_page.test.js` and `topology_render.test.js` — no web code changed in this plan, so this is a pure regression check confirming the "Связи" UI and canvas indeed needed no changes for switch-switch filtered links (per the design doc's UI section).

- [ ] **Step 4: Manual note (no browser testing required)**

Per project convention, do not drive a full browser session for this change — the automated suites above are the verification bar. If you want a quick sanity read without a browser, `GET /api/topology` after PUTting a switch-switch filtered link (e.g. via `curl`) and confirm the response round-trips the `filter` block on that link.
