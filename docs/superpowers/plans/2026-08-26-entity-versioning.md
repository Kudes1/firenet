# Entity Versioning (internal/pgstore) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `FileProjectStore` with Postgres-backed entity-level versioning: the confirmed project lives as a linear history of versions built from per-entity rows, edits happen in personal drafts, and an admin confirms a draft into a new version after an entity-level conflict check.

**Architecture:** `internal/projectdoc` (new, pure data types, no I/O) holds the wire DTOs currently defined in `internal/httpapi/dto.go`, plus a new `LayoutDoc` and a `ProjectDoc` bundling all four documents — both `internal/httpapi` and the new `internal/pgstore` import it, avoiding an import cycle. `internal/pgstore` maps a `ProjectDoc` to/from ~12 kinds of flat `(kind, key) -> data` entity rows, and implements versions (read-only, linear, append-only), drafts (personal, CAS-protected), diff/conflict detection, and confirm/restore, all backed by two new Postgres tables per concept (confirmed history vs. draft-in-progress). `internal/httpapi` handlers become draft-aware (`/api/drafts/{id}/...`) with read-only current-version counterparts (`/api/versions/current/...`), replacing direct file I/O.

**Tech Stack:** Go 1.25, `github.com/jackc/pgx/v5` (already a dependency from the auth-foundation plan), PostgreSQL 16. No new external dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-multiuser-collab-design.md` (sections "Модель данных", "`internal/pgstore`", "Request-флоу", "Права и ошибки" — this plan implements the `versions`/`entity_changes`/`drafts`/`draft_entity_changes` tables and the draft-aware API; auth/users/sessions are already implemented, see `docs/superpowers/plans/2026-08-26-multiuser-foundation.md`).

## Global Constraints

- Go 1.25 module `github.com/kudes1/firenet`, no cgo.
- Follow existing conventions: `writeJSON`/`writeError` envelopes, plain `testing` (no testify), `dbtest.Open(t)` for Postgres-backed tests (skips without `FIRENET_TEST_DATABASE_URL`), `gofmt`.
- No backward-compat shims: `FileProjectStore`'s role shrinks to the one-time legacy-file import in `internal/cli/serve.go`; the `ProjectStore` interface and its use in `handlers` disappear entirely, not left dual-mode.
- Entity data ordering: only **rules within a chain** and **chains within a policy** are order-sensitive (first-match firewall semantics) — every other kind (device/link/network/set/union/subnet) is reconstructed in a stable, deterministic order (sorted by key) with no semantic loss, since the compiler graph-walks by name, not list position.
- Link identity is the *unordered* device pair: `internal/topology/validate.go` normalizes `(A, B)` by sorting before comparing and rejects a second link on the same pair — so the entity key for `link` and `layout_link` is `min(A,B) + "|" + max(A,B)`, matching the key format already used in `.firenet-layout.json`'s `links` map.

---

## File Structure

**New package `internal/projectdoc`** (pure types, no I/O):
- `topology.go` — `EndpointDoc`, `LinkFilterDoc`, `LinkDoc`, `DeviceDoc`, `NetworkDoc`, `SetDoc`, `UnionDoc`, `TopologyDoc`, `EntityDoc` (moved verbatim from `internal/httpapi/dto.go`)
- `subnets.go` — `SubnetDoc`, `SubnetsDoc` (moved verbatim)
- `rules.go` — `RuleDoc`, `ChainDoc`, `PolicyDoc`, `(PolicyDoc) ToPolicy()`, `NewPolicyDoc()` (moved verbatim, imports `internal/rules`)
- `layout.go` — `LayoutPoint`, `LayoutCamera`, `LayoutDoc` (**new** — layout is untyped `json.RawMessage` today)
- `project.go` — `ProjectDoc` (**new**, bundles the four documents)

**Modified `internal/httpapi/dto.go`** — struct definitions replaced by type aliases (`type TopologyDoc = projectdoc.TopologyDoc`, etc.) so every existing reference in `handlers.go`/`handlers_test.go` keeps compiling unchanged.

**New package `internal/pgstore`**:
- `entities.go` — `entityRef`, `entityRow`, kind constants, `toEntities(ProjectDoc) (map[entityRef]json.RawMessage, error)`, `fromEntities(map[entityRef]entityRow) (ProjectDoc, error)`
- `store.go` — `Store`, `NewStore`, snapshot helpers (`entitySnapshotAt`, `draftOverrides`, `mergeSnapshot`)
- `diff.go` — `EntityDiff`, `diffSnapshots`
- `versions.go` — `VersionInfo`, `ErrNoVersions`, `CurrentVersion`, `ReadAt`, `History`, `DiffVersions`
- `drafts.go` — `Draft`, `EntityConflict`, `ErrDraftNotFound`, `ErrRevisionMismatch`, `ErrForbidden`, `CreateDraft`, `ListDrafts`, `ReadDraft`, `WriteDraft`, `DeleteDraft`, `DiffDraft`, `Conflicts`, `Confirm`
- `restore.go` — `Restore`
- `seed.go` — `SeedInitialVersion` (one-time legacy-file import)

**New migration** `internal/db/migrations/0002_versions_drafts.sql`.

**Modified `internal/httpapi`**:
- `store.go` — `ProjectStore` interface removed; `FileProjectStore` kept only for `internal/cli/serve.go`'s one-time import.
- `handlers.go` — `handlers.store` becomes `*pgstore.Store`; `getTopology`/`putTopology`/`getSubnets`/`putSubnets`/`getRules`/`putRules`/`getLayout`/`putLayout`/`validate`/`compile`/`diagnose`/`lint` become draft-aware, with read-only current-version counterparts.
- `draft_handlers.go` (new) — create/list/delete draft, diff, confirm.
- `version_handlers.go` (new) — history, diff, restore.
- `server.go` — full route rewrite.
- `handlers_test.go` — `newTestServer` reworked to seed via `pgstore` and open a draft instead of writing YAML files.

---

### Task 1: Extract `internal/projectdoc`

**Files:**
- Create: `internal/projectdoc/topology.go`
- Create: `internal/projectdoc/subnets.go`
- Create: `internal/projectdoc/rules.go`
- Create: `internal/projectdoc/layout.go`
- Create: `internal/projectdoc/project.go`
- Create: `internal/projectdoc/layout_test.go`
- Modify: `internal/httpapi/dto.go`

**Interfaces:**
- Produces: `projectdoc.{EndpointDoc,LinkFilterDoc,LinkDoc,DeviceDoc,NetworkDoc,SetDoc,UnionDoc,TopologyDoc,EntityDoc,SubnetDoc,SubnetsDoc,RuleDoc,ChainDoc,PolicyDoc,LayoutPoint,LayoutCamera,LayoutDoc,ProjectDoc}`, `(PolicyDoc) ToPolicy() rules.Policy`, `NewPolicyDoc(*rules.Policy) PolicyDoc`.
- Consumes (in `httpapi`, via aliases): every one of the above except `LayoutDoc`/`ProjectDoc`, which are new and referenced directly as `projectdoc.LayoutDoc`/`projectdoc.ProjectDoc` from Task 9 onward.

- [ ] **Step 1: Move the existing DTOs verbatim into `internal/projectdoc`**

`internal/projectdoc/topology.go`:
```go
// Package projectdoc holds the wire-format types for a firenet project
// (topology, subnets, rules, layout) shared between internal/httpapi (the
// HTTP/JSON boundary) and internal/pgstore (entity-level persistence) —
// neither package may import the other, so these types live below both.
package projectdoc

// EndpointDoc is one side of a logical connection.
type EndpointDoc struct {
	Device string `json:"device" yaml:"device"`
}

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

// DeviceDoc is a network node.
type DeviceDoc struct {
	Name string `json:"name" yaml:"name"`
	Kind string `json:"kind" yaml:"kind"`
}

// NetworkDoc is one L2 segment: an attachment to devices plus the named
// list of member subnets (which becomes one ipset at compile time).
type NetworkDoc struct {
	Name        string        `json:"name" yaml:"name"`
	Subnets     []string      `json:"subnets,omitempty" yaml:"subnets,omitempty"`
	Attach      []EndpointDoc `json:"attach,omitempty" yaml:"attach,omitempty"`
	Description string        `json:"description,omitempty" yaml:"description,omitempty"`
}

// SetDoc is a named address group for rule matching: references to subnets
// plus individual host addresses.
type SetDoc struct {
	Name        string   `json:"name" yaml:"name"`
	Subnets     []string `json:"subnets,omitempty" yaml:"subnets,omitempty"`
	Addresses   []string `json:"addresses,omitempty" yaml:"addresses,omitempty"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
}

// UnionDoc is a visual location grouping devices and networks. Purely
// presentational: it never reaches the compiler.
type UnionDoc struct {
	Name        string   `json:"name" yaml:"name"`
	Devices     []string `json:"devices,omitempty" yaml:"devices,omitempty"`
	Networks    []string `json:"networks,omitempty" yaml:"networks,omitempty"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
}

// TopologyDoc is the full wire shape of topology.yaml.
type TopologyDoc struct {
	Devices  []DeviceDoc  `json:"devices" yaml:"devices"`
	Links    []LinkDoc    `json:"links" yaml:"links"`
	Networks []NetworkDoc `json:"networks" yaml:"networks"`
	Sets     []SetDoc     `json:"sets" yaml:"sets"`
	Unions   []UnionDoc   `json:"unions" yaml:"unions"`
}

// EntityDoc is one export candidate for a link filter combo: a network or
// bare subnet, with its CIDR filled in for subnets.
type EntityDoc struct {
	Name string `json:"name"`
	CIDR string `json:"cidr,omitempty"`
}
```

`internal/projectdoc/subnets.go`:
```go
package projectdoc

// SubnetDoc is a named CIDR block. Attachment lives on the Network that
// contains it.
type SubnetDoc struct {
	Name        string `json:"name" yaml:"name"`
	CIDR        string `json:"cidr" yaml:"cidr"`
	Description string `json:"description,omitempty" yaml:"description,omitempty"`
}

// SubnetsDoc is the full wire shape of subnets.yaml.
type SubnetsDoc struct {
	Subnets []SubnetDoc `json:"subnets" yaml:"subnets"`
}
```

`internal/projectdoc/rules.go`:
```go
package projectdoc

import "github.com/kudes1/firenet/internal/rules"

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

// PolicyDoc is the full wire shape of rules.yaml (chains format).
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

- [ ] **Step 2: Write the failing test for the new `LayoutDoc`**

`internal/projectdoc/layout_test.go`:
```go
package projectdoc

import (
	"encoding/json"
	"testing"
)

func TestLayoutDocRoundTrip(t *testing.T) {
	const raw = `{"devices":{"r1":{"x":10,"y":20}},"networks":{"main":{"x":5,"y":6}},"links":{"office|r1":[[{"x":1,"y":2},{"x":3,"y":4}]]},"camera":{"x":1,"y":2,"z":0.5}}`

	var doc LayoutDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if doc.Devices["r1"] != (LayoutPoint{X: 10, Y: 20}) {
		t.Fatalf("got device point %+v", doc.Devices["r1"])
	}
	if doc.Camera == nil || *doc.Camera != (LayoutCamera{X: 1, Y: 2, Z: 0.5}) {
		t.Fatalf("got camera %+v", doc.Camera)
	}
	if len(doc.Links["office|r1"]) != 1 || len(doc.Links["office|r1"][0]) != 2 {
		t.Fatalf("got links %+v", doc.Links)
	}

	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var roundTripped LayoutDoc
	if err := json.Unmarshal(out, &roundTripped); err != nil {
		t.Fatalf("unmarshal round-tripped: %v", err)
	}
	if roundTripped.Devices["r1"] != doc.Devices["r1"] {
		t.Fatalf("round-trip lost device point: %+v", roundTripped.Devices["r1"])
	}
}

func TestLayoutDocEmpty(t *testing.T) {
	var doc LayoutDoc
	if err := json.Unmarshal([]byte("{}"), &doc); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	if doc.Devices != nil || doc.Camera != nil {
		t.Fatalf("expected zero-value LayoutDoc, got %+v", doc)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/projectdoc/...`
Expected: FAIL — `internal/projectdoc` package (and `LayoutDoc`) don't exist yet.

- [ ] **Step 4: Write `internal/projectdoc/layout.go` and `internal/projectdoc/project.go`**

`internal/projectdoc/layout.go`:
```go
package projectdoc

// LayoutPoint is a 2D canvas position.
type LayoutPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// LayoutCamera is the canvas viewport's pan/zoom state.
type LayoutCamera struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// LayoutDoc is the full wire shape of the UI canvas layout: node
// positions keyed by name, link waypoints keyed by the same
// "min(a,b)|max(a,b)" pair topology.Validate uses for link identity, and
// the camera's pan/zoom. Purely presentational — never reaches the
// compiler.
type LayoutDoc struct {
	Devices  map[string]LayoutPoint     `json:"devices,omitempty"`
	Networks map[string]LayoutPoint     `json:"networks,omitempty"`
	Links    map[string][][]LayoutPoint `json:"links,omitempty"`
	Camera   *LayoutCamera              `json:"camera,omitempty"`
}
```

`internal/projectdoc/project.go`:
```go
package projectdoc

// ProjectDoc bundles the four documents that make up a firenet project —
// the unit internal/pgstore reads/writes as a whole.
type ProjectDoc struct {
	Topology TopologyDoc `json:"topology"`
	Subnets  SubnetsDoc  `json:"subnets"`
	Rules    PolicyDoc   `json:"rules"`
	Layout   LayoutDoc   `json:"layout"`
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/projectdoc/... -v`
Expected: `PASS` for both tests.

- [ ] **Step 6: Replace `internal/httpapi/dto.go` with aliases**

```go
// Package httpapi serves firenet's web UI and the JSON API it talks to. It
// is an adapter, at the same tier as internal/cli: it reuses
// internal/topology, internal/rules and internal/app for all domain logic
// and knows nothing about the CLI.
package httpapi

import "github.com/kudes1/firenet/internal/projectdoc"

// These are aliases, not new types: internal/projectdoc is the single
// source of truth (internal/pgstore needs the same types and can't import
// this package, since this package will import internal/pgstore). Every
// existing reference to httpapi.TopologyDoc etc. keeps compiling as-is.
type (
	EndpointDoc   = projectdoc.EndpointDoc
	LinkFilterDoc = projectdoc.LinkFilterDoc
	LinkDoc       = projectdoc.LinkDoc
	DeviceDoc     = projectdoc.DeviceDoc
	NetworkDoc    = projectdoc.NetworkDoc
	SetDoc        = projectdoc.SetDoc
	UnionDoc      = projectdoc.UnionDoc
	TopologyDoc   = projectdoc.TopologyDoc
	EntityDoc     = projectdoc.EntityDoc
	SubnetDoc     = projectdoc.SubnetDoc
	SubnetsDoc    = projectdoc.SubnetsDoc
	RuleDoc       = projectdoc.RuleDoc
	ChainDoc      = projectdoc.ChainDoc
	PolicyDoc     = projectdoc.PolicyDoc
)

// NewPolicyDoc converts the domain model to the wire doc.
var NewPolicyDoc = projectdoc.NewPolicyDoc
```

- [ ] **Step 7: Run the full existing suite to confirm nothing broke**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./internal/httpapi/... ./internal/projectdoc/...`
Expected: builds clean, `gofmt -l .` prints nothing, all tests `PASS` (the alias swap is a pure refactor — every existing handler/test reference to `TopologyDoc` etc. still resolves, and `doc.ToPolicy()` still works since Go aliases share the aliased type's method set).

- [ ] **Step 8: Commit**

```bash
git add internal/projectdoc internal/httpapi/dto.go
git commit -m "refactor(projectdoc): extract wire DTOs so pgstore can use them without a cycle"
```

---

### Task 1.5: Extend `dbtest`'s truncate list for the new tables

**Files:**
- Modify: `internal/db/dbtest/dbtest.go`

This is folded in here (not its own task) because Task 3 immediately needs
it to keep tests isolated, and it's a one-line change to a file already
carrying a comment inviting exactly this.

- [ ] **Step 1: Update the `TRUNCATE` list**

In `internal/db/dbtest/dbtest.go`, change:
```go
		_, _ = pool.Exec(ctx, "TRUNCATE users, sessions RESTART IDENTITY CASCADE")
```
to:
```go
		_, _ = pool.Exec(ctx, "TRUNCATE users, sessions, versions, entity_changes, drafts, draft_entity_changes RESTART IDENTITY CASCADE")
```
(`draft_entity_changes` cascades from `drafts` via its FK, but listing it
explicitly keeps the statement self-documenting and correct even if that
FK's `ON DELETE CASCADE` is ever loosened.)

- [ ] **Step 2: Commit alongside Task 3** (this change has no independent test — it's verified by every `internal/pgstore` test in Task 3 passing repeatably across runs)

---

### Task 2: `internal/pgstore` — entity mapping

**Files:**
- Create: `internal/pgstore/entities.go`
- Create: `internal/pgstore/entities_test.go`

**Interfaces:**
- Consumes: `projectdoc.ProjectDoc` and its nested types (Task 1).
- Produces:
  - `type entityRef struct { Kind, Key string }`
  - `type entityRow struct { Change string; Data json.RawMessage }` (`Change` one of `"added"|"modified"|"removed"`; `Data` nil iff `Change == "removed"`)
  - Kind constants: `kindDevice, kindLink, kindNetwork, kindSet, kindUnion, kindSubnet, kindChain, kindRule, kindLayoutDevice, kindLayoutNetwork, kindLayoutLink, kindLayoutCamera` (all `string`)
  - `func toEntities(doc projectdoc.ProjectDoc) (map[entityRef]json.RawMessage, error)`
  - `func fromEntities(snapshot map[entityRef]entityRow) (projectdoc.ProjectDoc, error)`
  - `func linkKey(a, b string) string` (`min(a,b) + "|" + max(a,b)`)

- [ ] **Step 1: Write the failing test**

`internal/pgstore/entities_test.go`:
```go
package pgstore

import (
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func sampleDoc() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
			Links:   []projectdoc.LinkDoc{{A: projectdoc.EndpointDoc{Device: "r2"}, B: projectdoc.EndpointDoc{Device: "r1"}}},
			Networks: []projectdoc.NetworkDoc{{Name: "n1", Subnets: []string{"office"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}}},
			Sets:     []projectdoc.SetDoc{{Name: "s1", Subnets: []string{"office"}}},
			Unions:   []projectdoc.UnionDoc{{Name: "u1", Devices: []string{"r1"}}},
		},
		Subnets: projectdoc.SubnetsDoc{Subnets: []projectdoc.SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}},
		Rules: projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{
			{Name: "FIRENET-FWD", DefaultAction: "deny", Rules: []projectdoc.RuleDoc{
				{Name: "r-a", Src: []string{"any"}, Dst: []string{"any"}, Action: "allow"},
				{Name: "r-b", Src: []string{"any"}, Dst: []string{"any"}, Action: "deny"},
			}},
		}},
		Layout: projectdoc.LayoutDoc{
			Devices: map[string]projectdoc.LayoutPoint{"r1": {X: 1, Y: 2}},
			Links:   map[string][][]projectdoc.LayoutPoint{"r1|r2": {{{X: 0, Y: 0}}}},
			Camera:  &projectdoc.LayoutCamera{X: 1, Y: 2, Z: 1},
		},
	}
}

func TestToEntitiesCoversEveryKind(t *testing.T) {
	entities, err := toEntities(sampleDoc())
	if err != nil {
		t.Fatalf("toEntities: %v", err)
	}

	wantKinds := map[string]bool{
		kindDevice: false, kindLink: false, kindNetwork: false, kindSet: false, kindUnion: false,
		kindSubnet: false, kindChain: false, kindRule: false,
		kindLayoutDevice: false, kindLayoutLink: false, kindLayoutCamera: false,
	}
	for ref := range entities {
		if _, ok := wantKinds[ref.Kind]; ok {
			wantKinds[ref.Kind] = true
		}
	}
	for kind, seen := range wantKinds {
		if !seen {
			t.Errorf("no entity of kind %q produced", kind)
		}
	}
}

func TestLinkKeyIsOrderNormalized(t *testing.T) {
	if linkKey("r2", "r1") != linkKey("r1", "r2") {
		t.Fatalf("linkKey should ignore endpoint order")
	}
	if got, want := linkKey("r2", "r1"), "r1|r2"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestToEntitiesThenFromEntitiesRoundTrips(t *testing.T) {
	doc := sampleDoc()
	entities, err := toEntities(doc)
	if err != nil {
		t.Fatalf("toEntities: %v", err)
	}

	snapshot := make(map[entityRef]entityRow, len(entities))
	for ref, data := range entities {
		snapshot[ref] = entityRow{Change: "added", Data: data}
	}

	got, err := fromEntities(snapshot)
	if err != nil {
		t.Fatalf("fromEntities: %v", err)
	}

	if len(got.Topology.Devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(got.Topology.Devices))
	}
	if len(got.Topology.Links) != 1 || got.Topology.Links[0].A.Device != "r2" || got.Topology.Links[0].B.Device != "r1" {
		t.Fatalf("got links %+v, want the original r2->r1 link preserved", got.Topology.Links)
	}
	if len(got.Rules.Chains) != 1 || len(got.Rules.Chains[0].Rules) != 2 {
		t.Fatalf("got chains %+v", got.Rules.Chains)
	}
	if got.Rules.Chains[0].Rules[0].Name != "r-a" || got.Rules.Chains[0].Rules[1].Name != "r-b" {
		t.Fatalf("rule order not preserved: %+v", got.Rules.Chains[0].Rules)
	}
	if got.Layout.Devices["r1"] != (projectdoc.LayoutPoint{X: 1, Y: 2}) {
		t.Fatalf("got layout device %+v", got.Layout.Devices["r1"])
	}
	if got.Layout.Camera == nil || *got.Layout.Camera != (projectdoc.LayoutCamera{X: 1, Y: 2, Z: 1}) {
		t.Fatalf("got layout camera %+v", got.Layout.Camera)
	}
}

func TestFromEntitiesSkipsRemoved(t *testing.T) {
	doc := sampleDoc()
	entities, err := toEntities(doc)
	if err != nil {
		t.Fatalf("toEntities: %v", err)
	}
	snapshot := make(map[entityRef]entityRow, len(entities))
	for ref, data := range entities {
		snapshot[ref] = entityRow{Change: "added", Data: data}
	}
	snapshot[entityRef{Kind: kindDevice, Key: "r2"}] = entityRow{Change: "removed"}

	got, err := fromEntities(snapshot)
	if err != nil {
		t.Fatalf("fromEntities: %v", err)
	}
	for _, d := range got.Topology.Devices {
		if d.Name == "r2" {
			t.Fatalf("removed device r2 still present: %+v", got.Topology.Devices)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pgstore/...`
Expected: FAIL — `internal/pgstore` package doesn't exist yet.

- [ ] **Step 3: Write `internal/pgstore/entities.go`**

```go
// Package pgstore is the Postgres-backed home for a firenet project's
// version history and personal drafts. It maps projectdoc.ProjectDoc to
// and from flat (kind, key) -> data entity rows, so that two edits to
// different entities never conflict even if they land in the same YAML
// file, and one entity's whole history can be reconstructed on its own.
package pgstore

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/projectdoc"
)

const (
	kindDevice        = "device"
	kindLink          = "link"
	kindNetwork       = "network"
	kindSet           = "set"
	kindUnion         = "union"
	kindSubnet        = "subnet"
	kindChain         = "chain"
	kindRule          = "rule"
	kindLayoutDevice  = "layout_device"
	kindLayoutNetwork = "layout_network"
	kindLayoutLink    = "layout_link"
	kindLayoutCamera  = "layout_camera"
)

// layoutCameraKey is the single (kind=layout_camera) entity's key — there
// is at most one camera per project.
const layoutCameraKey = ""

type entityRef struct {
	Kind string
	Key  string
}

// entityRow is one entity's state at some point in the history: either
// its current data, or a tombstone (Change == "removed", Data == nil).
type entityRow struct {
	Change string
	Data   json.RawMessage
}

// linkKey is the entity identity for a link (and its layout waypoints):
// the endpoint pair, order-normalized the same way
// internal/topology/validate.go does when rejecting duplicate links.
func linkKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

// chainRuleEntity is the envelope stored for a "rule" entity: the rule
// itself plus its position within the chain, since entity rows have no
// inherent order and rule order is firewall-semantically significant
// (first match wins).
type chainRuleEntity struct {
	Order int                  `json:"order"`
	Rule  projectdoc.RuleDoc   `json:"rule"`
}

// chainEntity is the envelope for a "chain" entity: chain metadata (never
// its Rules, which are separate "rule" entities) plus its position among
// the policy's chains (index 0 is always the primary chain).
type chainEntity struct {
	Order         int    `json:"order"`
	Name          string `json:"name"`
	DefaultAction string `json:"defaultAction"`
	ChainPosition string `json:"chainPosition,omitempty"`
}

func marshalEntity(v any) (json.RawMessage, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal entity: %w", err)
	}
	return b, nil
}

// toEntities flattens a ProjectDoc into the full set of entities it
// implies: every key present here is "should exist with this data".
// Callers diff this against a base snapshot to find what changed.
func toEntities(doc projectdoc.ProjectDoc) (map[entityRef]json.RawMessage, error) {
	out := map[entityRef]json.RawMessage{}
	put := func(kind, key string, v any) error {
		data, err := marshalEntity(v)
		if err != nil {
			return err
		}
		out[entityRef{Kind: kind, Key: key}] = data
		return nil
	}

	for _, d := range doc.Topology.Devices {
		if err := put(kindDevice, d.Name, d); err != nil {
			return nil, err
		}
	}
	for _, l := range doc.Topology.Links {
		if err := put(kindLink, linkKey(l.A.Device, l.B.Device), l); err != nil {
			return nil, err
		}
	}
	for _, n := range doc.Topology.Networks {
		if err := put(kindNetwork, n.Name, n); err != nil {
			return nil, err
		}
	}
	for _, s := range doc.Topology.Sets {
		if err := put(kindSet, s.Name, s); err != nil {
			return nil, err
		}
	}
	for _, u := range doc.Topology.Unions {
		if err := put(kindUnion, u.Name, u); err != nil {
			return nil, err
		}
	}
	for _, s := range doc.Subnets.Subnets {
		if err := put(kindSubnet, s.Name, s); err != nil {
			return nil, err
		}
	}
	for ci, c := range doc.Rules.Chains {
		ce := chainEntity{Order: ci, Name: c.Name, DefaultAction: c.DefaultAction, ChainPosition: c.ChainPosition}
		if err := put(kindChain, c.Name, ce); err != nil {
			return nil, err
		}
		for ri, r := range c.Rules {
			re := chainRuleEntity{Order: ri, Rule: r}
			if err := put(kindRule, c.Name+"::"+r.Name, re); err != nil {
				return nil, err
			}
		}
	}
	for name, p := range doc.Layout.Devices {
		if err := put(kindLayoutDevice, name, p); err != nil {
			return nil, err
		}
	}
	for name, p := range doc.Layout.Networks {
		if err := put(kindLayoutNetwork, name, p); err != nil {
			return nil, err
		}
	}
	for key, waypoints := range doc.Layout.Links {
		if err := put(kindLayoutLink, key, waypoints); err != nil {
			return nil, err
		}
	}
	if doc.Layout.Camera != nil {
		if err := put(kindLayoutCamera, layoutCameraKey, doc.Layout.Camera); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// fromEntities reconstructs a ProjectDoc from a snapshot (one row per
// live (kind, key); rows with Change == "removed" are ignored). Every
// kind except chain/rule is sorted by key for a stable, deterministic
// order; chains and rules use their stored Order.
func fromEntities(snapshot map[entityRef]entityRow) (projectdoc.ProjectDoc, error) {
	var doc projectdoc.ProjectDoc

	type ordered[T any] struct {
		key   string
		order int
		value T
	}
	sortByKey := func(keys []string) { sort.Strings(keys) }

	var deviceKeys, linkKeys, networkKeys, setKeys, unionKeys, subnetKeys []string
	var layoutDeviceKeys, layoutNetworkKeys, layoutLinkKeys []string
	var chains []ordered[chainEntity]
	rulesByChain := map[string][]ordered[projectdoc.RuleDoc]{}

	for ref, row := range snapshot {
		if row.Change == "removed" {
			continue
		}
		switch ref.Kind {
		case kindDevice:
			deviceKeys = append(deviceKeys, ref.Key)
		case kindLink:
			linkKeys = append(linkKeys, ref.Key)
		case kindNetwork:
			networkKeys = append(networkKeys, ref.Key)
		case kindSet:
			setKeys = append(setKeys, ref.Key)
		case kindUnion:
			unionKeys = append(unionKeys, ref.Key)
		case kindSubnet:
			subnetKeys = append(subnetKeys, ref.Key)
		case kindChain:
			var ce chainEntity
			if err := json.Unmarshal(row.Data, &ce); err != nil {
				return doc, fmt.Errorf("unmarshal chain %q: %w", ref.Key, err)
			}
			chains = append(chains, ordered[chainEntity]{key: ref.Key, order: ce.Order, value: ce})
		case kindRule:
			chainName, _, ok := cutRuleKey(ref.Key)
			if !ok {
				return doc, fmt.Errorf("malformed rule key %q", ref.Key)
			}
			var re chainRuleEntity
			if err := json.Unmarshal(row.Data, &re); err != nil {
				return doc, fmt.Errorf("unmarshal rule %q: %w", ref.Key, err)
			}
			rulesByChain[chainName] = append(rulesByChain[chainName], ordered[projectdoc.RuleDoc]{key: ref.Key, order: re.Order, value: re.Rule})
		case kindLayoutDevice:
			layoutDeviceKeys = append(layoutDeviceKeys, ref.Key)
		case kindLayoutNetwork:
			layoutNetworkKeys = append(layoutNetworkKeys, ref.Key)
		case kindLayoutLink:
			layoutLinkKeys = append(layoutLinkKeys, ref.Key)
		case kindLayoutCamera:
			var cam projectdoc.LayoutCamera
			if err := json.Unmarshal(row.Data, &cam); err != nil {
				return doc, fmt.Errorf("unmarshal camera: %w", err)
			}
			doc.Layout.Camera = &cam
		default:
			return doc, fmt.Errorf("unknown entity kind %q", ref.Kind)
		}
	}

	sortByKey(deviceKeys)
	for _, k := range deviceKeys {
		var v projectdoc.DeviceDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindDevice, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal device %q: %w", k, err)
		}
		doc.Topology.Devices = append(doc.Topology.Devices, v)
	}
	sortByKey(linkKeys)
	for _, k := range linkKeys {
		var v projectdoc.LinkDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLink, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal link %q: %w", k, err)
		}
		doc.Topology.Links = append(doc.Topology.Links, v)
	}
	sortByKey(networkKeys)
	for _, k := range networkKeys {
		var v projectdoc.NetworkDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindNetwork, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal network %q: %w", k, err)
		}
		doc.Topology.Networks = append(doc.Topology.Networks, v)
	}
	sortByKey(setKeys)
	for _, k := range setKeys {
		var v projectdoc.SetDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindSet, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal set %q: %w", k, err)
		}
		doc.Topology.Sets = append(doc.Topology.Sets, v)
	}
	sortByKey(unionKeys)
	for _, k := range unionKeys {
		var v projectdoc.UnionDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindUnion, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal union %q: %w", k, err)
		}
		doc.Topology.Unions = append(doc.Topology.Unions, v)
	}
	sortByKey(subnetKeys)
	for _, k := range subnetKeys {
		var v projectdoc.SubnetDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindSubnet, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal subnet %q: %w", k, err)
		}
		doc.Subnets.Subnets = append(doc.Subnets.Subnets, v)
	}

	sort.Slice(chains, func(i, j int) bool { return chains[i].order < chains[j].order })
	for _, c := range chains {
		rs := rulesByChain[c.key]
		sort.Slice(rs, func(i, j int) bool { return rs[i].order < rs[j].order })
		chainDoc := projectdoc.ChainDoc{
			Name: c.value.Name, DefaultAction: c.value.DefaultAction, ChainPosition: c.value.ChainPosition,
			Rules: make([]projectdoc.RuleDoc, len(rs)),
		}
		for i, r := range rs {
			chainDoc.Rules[i] = r.value
		}
		doc.Rules.Chains = append(doc.Rules.Chains, chainDoc)
	}

	sortByKey(layoutDeviceKeys)
	for _, k := range layoutDeviceKeys {
		var p projectdoc.LayoutPoint
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLayoutDevice, Key: k}].Data, &p); err != nil {
			return doc, fmt.Errorf("unmarshal layout device %q: %w", k, err)
		}
		if doc.Layout.Devices == nil {
			doc.Layout.Devices = map[string]projectdoc.LayoutPoint{}
		}
		doc.Layout.Devices[k] = p
	}
	sortByKey(layoutNetworkKeys)
	for _, k := range layoutNetworkKeys {
		var p projectdoc.LayoutPoint
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLayoutNetwork, Key: k}].Data, &p); err != nil {
			return doc, fmt.Errorf("unmarshal layout network %q: %w", k, err)
		}
		if doc.Layout.Networks == nil {
			doc.Layout.Networks = map[string]projectdoc.LayoutPoint{}
		}
		doc.Layout.Networks[k] = p
	}
	sortByKey(layoutLinkKeys)
	for _, k := range layoutLinkKeys {
		var wp [][]projectdoc.LayoutPoint
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLayoutLink, Key: k}].Data, &wp); err != nil {
			return doc, fmt.Errorf("unmarshal layout link %q: %w", k, err)
		}
		if doc.Layout.Links == nil {
			doc.Layout.Links = map[string][][]projectdoc.LayoutPoint{}
		}
		doc.Layout.Links[k] = wp
	}

	return doc, nil
}

// cutRuleKey splits a "chain::rule" entity key.
func cutRuleKey(key string) (chain, rule string, ok bool) {
	for i := 0; i+1 < len(key); i++ {
		if key[i] == ':' && key[i+1] == ':' {
			return key[:i], key[i+2:], true
		}
	}
	return "", "", false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for all five tests.

- [ ] **Step 5: Commit**

```bash
git add internal/pgstore
git commit -m "feat(pgstore): map ProjectDoc to/from flat entity rows"
```

---

### Task 3: `internal/pgstore` — migration, `Store`, snapshot helpers

**Files:**
- Create: `internal/db/migrations/0002_versions_drafts.sql`
- Modify: `internal/db/dbtest/dbtest.go` (Task 1.5's change)
- Create: `internal/pgstore/store.go`
- Create: `internal/pgstore/store_test.go`

**Interfaces:**
- Consumes: `entityRef`, `entityRow` (Task 2).
- Produces:
  - `type Store struct{ db *pgxpool.Pool }`, `func NewStore(pool *pgxpool.Pool) *Store`
  - `func (s *Store) entitySnapshotAt(ctx, versionID int64) (map[entityRef]entityRow, error)`
  - `func (s *Store) draftOverrides(ctx, draftID string) (map[entityRef]entityRow, error)`
  - `func mergeSnapshot(base, overrides map[entityRef]entityRow) map[entityRef]entityRow`

- [ ] **Step 1: Write the migration**

`internal/db/migrations/0002_versions_drafts.sql`:
```sql
-- Confirmed history. Append-only, linear (no branches).
CREATE TABLE versions (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_by UUID REFERENCES users(id),
    draft_id     UUID, -- which draft this version came from; no FK (see below)
    note         TEXT  -- e.g. "restored to v5"
);

-- One row per entity that changed in a given version.
CREATE TABLE entity_changes (
    id         BIGSERIAL PRIMARY KEY,
    version_id BIGINT NOT NULL REFERENCES versions(id),
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    change     TEXT NOT NULL CHECK (change IN ('added', 'modified', 'removed')),
    data       JSONB, -- NULL when change = 'removed'
    author     UUID NOT NULL REFERENCES users(id)
);
CREATE INDEX entity_changes_lookup ON entity_changes (kind, key, version_id DESC);

-- A personal draft: edits layered on top of a specific base version.
CREATE TABLE drafts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner           UUID NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    base_version_id BIGINT NOT NULL REFERENCES versions(id),
    status          TEXT NOT NULL DEFAULT 'open', -- open|conflict|merged|closed
    revision        BIGINT NOT NULL DEFAULT 0,     -- CAS token for WriteDraft
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner, name)
);

-- Current state of a draft's edits: one row per entity it touches (not a
-- history — overwritten on every save; the draft holds only real diffs
-- from its base version).
CREATE TABLE draft_entity_changes (
    draft_id UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,
    key      TEXT NOT NULL,
    change   TEXT NOT NULL CHECK (change IN ('added', 'modified', 'removed')),
    data     JSONB,
    PRIMARY KEY (draft_id, kind, key)
);
```

(`versions.draft_id` has no FK: it would form a cycle with
`drafts.base_version_id -> versions`. It exists only so history display
can say "version 7 came from draft X"; nothing enforces referential
integrity on it, and nothing needs to.)

- [ ] **Step 2: Apply Task 1.5's `dbtest.go` change** (if not already applied)

- [ ] **Step 3: Write the failing test**

`internal/pgstore/store_test.go`:
```go
package pgstore

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
)

func newTestStoreWithUser(t *testing.T) (*Store, auth.User) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	u, err := users.CreateUser(context.Background(), "tester", "hunter22222", auth.RoleAdmin)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return NewStore(pool), u
}

// insertVersion is a raw-SQL test helper. Task 7 (Confirm) and Task 8
// (Restore) are the real way versions get created; entitySnapshotAt needs
// to be tested before either exists.
func insertVersion(t *testing.T, s *Store, author auth.User, entities map[entityRef]entityRow) int64 {
	t.Helper()
	ctx := context.Background()
	var versionID int64
	err := s.db.QueryRow(ctx, `INSERT INTO versions (confirmed_by) VALUES ($1) RETURNING id`, author.ID).Scan(&versionID)
	if err != nil {
		t.Fatalf("insert version: %v", err)
	}
	for ref, row := range entities {
		_, err := s.db.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,$4,$5,$6)`,
			versionID, ref.Kind, ref.Key, row.Change, row.Data, author.ID)
		if err != nil {
			t.Fatalf("insert entity_change: %v", err)
		}
	}
	return versionID
}

func insertDraft(t *testing.T, s *Store, owner auth.User, baseVersion int64) string {
	t.Helper()
	var id string
	err := s.db.QueryRow(context.Background(), `INSERT INTO drafts (owner, name, base_version_id) VALUES ($1,$2,$3) RETURNING id`,
		owner.ID, "test-draft", baseVersion).Scan(&id)
	if err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	return id
}

func TestEntitySnapshotAtLatestPerKey(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "modified", Data: []byte(`{"name":"r1","kind":"switch"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	atV1, err := s.entitySnapshotAt(ctx, v1)
	if err != nil {
		t.Fatalf("entitySnapshotAt(v1): %v", err)
	}
	if len(atV1) != 1 {
		t.Fatalf("got %d entities at v1, want 1", len(atV1))
	}

	atV2, err := s.entitySnapshotAt(ctx, v2)
	if err != nil {
		t.Fatalf("entitySnapshotAt(v2): %v", err)
	}
	if len(atV2) != 2 {
		t.Fatalf("got %d entities at v2, want 2", len(atV2))
	}
	if string(atV2[entityRef{Kind: kindDevice, Key: "r1"}].Data) != `{"name":"r1","kind":"switch"}` {
		t.Fatalf("got stale data at v2: %s", atV2[entityRef{Kind: kindDevice, Key: "r1"}].Data)
	}
}

func TestEntitySnapshotAtExcludesRemoved(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "removed"},
	})

	snapshot, err := s.entitySnapshotAt(ctx, v2)
	if err != nil {
		t.Fatalf("entitySnapshotAt: %v", err)
	}
	if len(snapshot) != 0 {
		t.Fatalf("got %d entities, want 0 (r1 was removed)", len(snapshot))
	}
}

func TestDraftOverrides(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
	})
	draftID := insertDraft(t, s, author, v1)

	_, err := s.db.Exec(ctx, `INSERT INTO draft_entity_changes (draft_id, kind, key, change, data) VALUES ($1,$2,$3,$4,$5)`,
		draftID, kindDevice, "r2", "added", []byte(`{"name":"r2"}`))
	if err != nil {
		t.Fatalf("insert draft_entity_change: %v", err)
	}

	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		t.Fatalf("draftOverrides: %v", err)
	}
	if len(overrides) != 1 {
		t.Fatalf("got %d overrides, want 1", len(overrides))
	}
}

func TestMergeSnapshot(t *testing.T) {
	base := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2"}`)},
	}
	overrides := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r2"}: {Change: "removed"},
		{Kind: kindDevice, Key: "r3"}: {Change: "added", Data: []byte(`{"name":"r3"}`)},
	}

	merged := mergeSnapshot(base, overrides)
	if len(merged) != 2 {
		t.Fatalf("got %d entities, want 2", len(merged))
	}
	if _, ok := merged[entityRef{Kind: kindDevice, Key: "r2"}]; ok {
		t.Fatal("r2 should have been removed by the override")
	}
	if _, ok := merged[entityRef{Kind: kindDevice, Key: "r3"}]; !ok {
		t.Fatal("r3 should have been added by the override")
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `go test ./internal/pgstore/...`
Expected: FAIL — `Store`/`NewStore`/`entitySnapshotAt`/`draftOverrides`/`mergeSnapshot` undefined, and the `versions`/`drafts`/etc. tables don't exist yet (the migration file alone doesn't apply itself — `dbtest.Open` calls `db.Migrate`, which picks up the new file automatically once it's present, so this FAIL is a Go compile error, not a missing-table error, since Step 1 already wrote the migration).

- [ ] **Step 5: Write `internal/pgstore/store.go`**

```go
package pgstore

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the Postgres-backed home for a project's version history and
// personal drafts.
type Store struct {
	db *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{db: pool}
}

// entitySnapshotAt returns the live entity set as of versionID: for each
// (kind, key), the row with the highest version_id <= versionID, unless
// that row's change is "removed".
func (s *Store) entitySnapshotAt(ctx context.Context, versionID int64) (map[entityRef]entityRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT kind, key, change, data FROM (
			SELECT DISTINCT ON (kind, key) kind, key, change, data
			FROM entity_changes
			WHERE version_id <= $1
			ORDER BY kind, key, version_id DESC
		) latest
		WHERE change != 'removed'`, versionID)
	if err != nil {
		return nil, fmt.Errorf("query entity snapshot at %d: %w", versionID, err)
	}
	defer rows.Close()

	out := map[entityRef]entityRow{}
	for rows.Next() {
		var ref entityRef
		var row entityRow
		if err := rows.Scan(&ref.Kind, &ref.Key, &row.Change, &row.Data); err != nil {
			return nil, fmt.Errorf("scan entity snapshot row: %w", err)
		}
		out[ref] = row
	}
	return out, rows.Err()
}

// draftOverrides returns a draft's current per-entity edits, including
// "removed" tombstones — mergeSnapshot needs those to delete the
// corresponding key from the base snapshot.
func (s *Store) draftOverrides(ctx context.Context, draftID string) (map[entityRef]entityRow, error) {
	rows, err := s.db.Query(ctx, `SELECT kind, key, change, data FROM draft_entity_changes WHERE draft_id = $1`, draftID)
	if err != nil {
		return nil, fmt.Errorf("query draft overrides: %w", err)
	}
	defer rows.Close()

	out := map[entityRef]entityRow{}
	for rows.Next() {
		var ref entityRef
		var row entityRow
		if err := rows.Scan(&ref.Kind, &ref.Key, &row.Change, &row.Data); err != nil {
			return nil, fmt.Errorf("scan draft override row: %w", err)
		}
		out[ref] = row
	}
	return out, rows.Err()
}

// mergeSnapshot applies overrides onto base: a "removed" override deletes
// the key; anything else replaces it.
func mergeSnapshot(base, overrides map[entityRef]entityRow) map[entityRef]entityRow {
	out := make(map[entityRef]entityRow, len(base)+len(overrides))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overrides {
		if v.Change == "removed" {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for all tests (Task 2's entity-mapping tests plus this task's four).

- [ ] **Step 7: Commit**

```bash
git add internal/db/migrations/0002_versions_drafts.sql internal/db/dbtest/dbtest.go internal/pgstore/store.go internal/pgstore/store_test.go
git commit -m "feat(pgstore): add versions/drafts schema and entity snapshot helpers"
```

---

### Task 4: `internal/pgstore` — diff engine

**Files:**
- Create: `internal/pgstore/diff.go`
- Create: `internal/pgstore/diff_test.go`

**Interfaces:**
- Consumes: `entityRef`, `entityRow` (Task 2).
- Produces:
  - `type EntityDiff struct { Kind, Key, Change string; Before, After json.RawMessage }`
  - `func diffSnapshots(before, after map[entityRef]entityRow) []EntityDiff` — sorted by `(Kind, Key)`, omits unchanged entities.

This is pure, DB-free logic — shared by `DiffVersions` (Task 5), `DiffDraft`, and `Conflicts` (Task 7), so it's tested in isolation first.

- [ ] **Step 1: Write the failing test**

`internal/pgstore/diff_test.go`:
```go
package pgstore

import "testing"

func TestDiffSnapshots(t *testing.T) {
	before := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
		{Kind: kindDevice, Key: "r3"}: {Change: "added", Data: []byte(`{"name":"r3","kind":"router"}`)},
	}
	after := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},    // unchanged
		{Kind: kindDevice, Key: "r2"}: {Change: "modified", Data: []byte(`{"name":"r2","kind":"switch"}`)}, // modified
		{Kind: kindDevice, Key: "r4"}: {Change: "added", Data: []byte(`{"name":"r4","kind":"router"}`)},    // added
		// r3 removed
	}

	diffs := diffSnapshots(before, after)
	if len(diffs) != 3 {
		t.Fatalf("got %d diffs, want 3 (r2 modified, r3 removed, r4 added): %+v", len(diffs), diffs)
	}

	byKey := map[string]EntityDiff{}
	for _, d := range diffs {
		byKey[d.Key] = d
	}

	if d := byKey["r2"]; d.Change != "modified" || string(d.Before) != `{"name":"r2","kind":"router"}` || string(d.After) != `{"name":"r2","kind":"switch"}` {
		t.Fatalf("r2 diff wrong: %+v", d)
	}
	if d := byKey["r3"]; d.Change != "removed" || d.After != nil {
		t.Fatalf("r3 diff wrong: %+v", d)
	}
	if d := byKey["r4"]; d.Change != "added" || d.Before != nil {
		t.Fatalf("r4 diff wrong: %+v", d)
	}
	if _, ok := byKey["r1"]; ok {
		t.Fatal("r1 is unchanged and should not appear in the diff")
	}
}

func TestDiffSnapshotsIsSorted(t *testing.T) {
	before := map[entityRef]entityRow{}
	after := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "z"}: {Change: "added", Data: []byte(`{}`)},
		{Kind: kindDevice, Key: "a"}: {Change: "added", Data: []byte(`{}`)},
		{Kind: kindSubnet, Key: "a"}: {Change: "added", Data: []byte(`{}`)},
	}
	diffs := diffSnapshots(before, after)
	if len(diffs) != 3 {
		t.Fatalf("got %d diffs, want 3", len(diffs))
	}
	// kindDevice < kindSubnet lexically ("device" < "subnet"), then by key.
	want := []entityRef{{kindDevice, "a"}, {kindDevice, "z"}, {kindSubnet, "a"}}
	for i, d := range diffs {
		if d.Kind != want[i].Kind || d.Key != want[i].Key {
			t.Fatalf("diff %d = (%s,%s), want (%s,%s)", i, d.Kind, d.Key, want[i].Kind, want[i].Key)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pgstore/... -run TestDiffSnapshots`
Expected: FAIL — `EntityDiff`/`diffSnapshots` undefined.

- [ ] **Step 3: Write `internal/pgstore/diff.go`**

```go
package pgstore

import (
	"bytes"
	"encoding/json"
	"sort"
)

// EntityDiff is one entity's change between two snapshots: a version-to-
// version comparison, or a draft compared against its base version.
type EntityDiff struct {
	Kind   string
	Key    string
	Change string // added|modified|removed
	Before json.RawMessage // nil when Change == "added"
	After  json.RawMessage // nil when Change == "removed"
}

// diffSnapshots reports every entity that differs between before and
// after, sorted by (Kind, Key). Entities present in both with
// byte-identical data are omitted.
func diffSnapshots(before, after map[entityRef]entityRow) []EntityDiff {
	seen := make(map[entityRef]bool, len(before)+len(after))
	for ref := range before {
		seen[ref] = true
	}
	for ref := range after {
		seen[ref] = true
	}

	var out []EntityDiff
	for ref := range seen {
		b, hasBefore := before[ref]
		a, hasAfter := after[ref]
		switch {
		case !hasBefore && hasAfter:
			out = append(out, EntityDiff{Kind: ref.Kind, Key: ref.Key, Change: "added", After: a.Data})
		case hasBefore && !hasAfter:
			out = append(out, EntityDiff{Kind: ref.Kind, Key: ref.Key, Change: "removed", Before: b.Data})
		case hasBefore && hasAfter && !bytes.Equal(b.Data, a.Data):
			out = append(out, EntityDiff{Kind: ref.Kind, Key: ref.Key, Change: "modified", Before: b.Data, After: a.Data})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Key < out[j].Key
	})
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v -run TestDiffSnapshots`
Expected: `PASS` for both tests.

- [ ] **Step 5: Commit**

```bash
git add internal/pgstore/diff.go internal/pgstore/diff_test.go
git commit -m "feat(pgstore): add entity-level snapshot diff"
```

---

### Task 5: `internal/pgstore` — versions read path

**Files:**
- Create: `internal/pgstore/versions.go`
- Create: `internal/pgstore/versions_test.go`

**Interfaces:**
- Consumes: `entitySnapshotAt` (Task 3), `fromEntities` (Task 2), `diffSnapshots`/`EntityDiff` (Task 4).
- Produces:
  - `var ErrNoVersions = errors.New(...)`
  - `type VersionInfo struct { ID int64; CreatedAt time.Time; ConfirmedBy, DraftID, Note string }`
  - `func (s *Store) CurrentVersion(ctx) (int64, error)`
  - `func (s *Store) ReadAt(ctx, version int64) (projectdoc.ProjectDoc, error)`
  - `func (s *Store) History(ctx, limit int) ([]VersionInfo, error)`
  - `func (s *Store) DiffVersions(ctx, from, to int64) ([]EntityDiff, error)`

- [ ] **Step 1: Write the failing test**

`internal/pgstore/versions_test.go`:
```go
package pgstore

import (
	"context"
	"errors"
	"testing"
)

func TestCurrentVersionNoVersions(t *testing.T) {
	s, _ := newTestStoreWithUser(t)
	if _, err := s.CurrentVersion(context.Background()); !errors.Is(err, ErrNoVersions) {
		t.Fatalf("got err %v, want ErrNoVersions", err)
	}
}

func TestCurrentVersionIsTheLatest(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	insertVersion(t, s, author, map[entityRef]entityRow{{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{}`)}})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{}`)}})

	got, err := s.CurrentVersion(context.Background())
	if err != nil {
		t.Fatalf("CurrentVersion: %v", err)
	}
	if got != v2 {
		t.Fatalf("got %d, want %d", got, v2)
	}
}

func TestReadAtReconstructsTheDoc(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
		{Kind: kindSubnet, Key: "office"}: {Change: "added", Data: []byte(`{"name":"office","cidr":"10.0.0.0/24"}`)},
	})

	doc, err := s.ReadAt(context.Background(), v1)
	if err != nil {
		t.Fatalf("ReadAt: %v", err)
	}
	if len(doc.Topology.Devices) != 1 || doc.Topology.Devices[0].Name != "r1" {
		t.Fatalf("got devices %+v", doc.Topology.Devices)
	}
	if len(doc.Subnets.Subnets) != 1 || doc.Subnets.Subnets[0].Name != "office" {
		t.Fatalf("got subnets %+v", doc.Subnets.Subnets)
	}
}

func TestHistoryOrdersNewestFirstAndRespectsLimit(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, nil)
	v2 := insertVersion(t, s, author, nil)
	v3 := insertVersion(t, s, author, nil)

	all, err := s.History(context.Background(), 10)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(all) != 3 || all[0].ID != v3 || all[2].ID != v1 {
		t.Fatalf("got %+v, want newest-first [%d,%d,%d]", all, v3, v2, v1)
	}

	limited, err := s.History(context.Background(), 2)
	if err != nil {
		t.Fatalf("History(limit=2): %v", err)
	}
	if len(limited) != 2 || limited[0].ID != v3 {
		t.Fatalf("got %+v, want the 2 newest", limited)
	}
}

func TestDiffVersions(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	diffs, err := s.DiffVersions(context.Background(), v1, v2)
	if err != nil {
		t.Fatalf("DiffVersions: %v", err)
	}
	if len(diffs) != 1 || diffs[0].Key != "r2" || diffs[0].Change != "added" {
		t.Fatalf("got %+v", diffs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pgstore/... -run 'TestCurrentVersion|TestReadAt|TestHistory|TestDiffVersions'`
Expected: FAIL — `ErrNoVersions`/`CurrentVersion`/`ReadAt`/`History`/`DiffVersions`/`VersionInfo` undefined.

- [ ] **Step 3: Write `internal/pgstore/versions.go`**

```go
package pgstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kudes1/firenet/internal/projectdoc"
)

var ErrNoVersions = errors.New("no versions exist yet")

// VersionInfo is one entry in the confirmed history.
type VersionInfo struct {
	ID          int64
	CreatedAt   time.Time
	ConfirmedBy string // user id; empty for the seeded initial import
	DraftID     string // empty when the version didn't come from a draft (initial import, restore)
	Note        string
}

// CurrentVersion returns the id of the latest confirmed version.
func (s *Store) CurrentVersion(ctx context.Context) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `SELECT id FROM versions ORDER BY id DESC LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNoVersions
	}
	if err != nil {
		return 0, fmt.Errorf("current version: %w", err)
	}
	return id, nil
}

// ReadAt reconstructs the full project as of a specific version.
func (s *Store) ReadAt(ctx context.Context, version int64) (projectdoc.ProjectDoc, error) {
	snapshot, err := s.entitySnapshotAt(ctx, version)
	if err != nil {
		return projectdoc.ProjectDoc{}, err
	}
	return fromEntities(snapshot)
}

// History lists the most recent versions, newest first.
func (s *Store) History(ctx context.Context, limit int) ([]VersionInfo, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, created_at, COALESCE(confirmed_by::text, ''), COALESCE(draft_id::text, ''), COALESCE(note, '')
		FROM versions ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list history: %w", err)
	}
	defer rows.Close()

	var out []VersionInfo
	for rows.Next() {
		var v VersionInfo
		if err := rows.Scan(&v.ID, &v.CreatedAt, &v.ConfirmedBy, &v.DraftID, &v.Note); err != nil {
			return nil, fmt.Errorf("scan version: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// DiffVersions reports every entity that differs between two versions
// (in either direction — from can be newer than to).
func (s *Store) DiffVersions(ctx context.Context, from, to int64) ([]EntityDiff, error) {
	before, err := s.entitySnapshotAt(ctx, from)
	if err != nil {
		return nil, err
	}
	after, err := s.entitySnapshotAt(ctx, to)
	if err != nil {
		return nil, err
	}
	return diffSnapshots(before, after), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for every test in the package so far.

- [ ] **Step 5: Commit**

```bash
git add internal/pgstore/versions.go internal/pgstore/versions_test.go
git commit -m "feat(pgstore): add read-only version history (CurrentVersion/ReadAt/History/DiffVersions)"
```

---

### Task 6: `internal/pgstore` — drafts CRUD + CAS

**Files:**
- Create: `internal/pgstore/drafts.go`
- Create: `internal/pgstore/drafts_test.go`

**Interfaces:**
- Consumes: `entitySnapshotAt`, `draftOverrides`, `mergeSnapshot` (Task 3), `toEntities`/`fromEntities` (Task 2), `diffSnapshots`/`EntityDiff` (Task 4), `CurrentVersion` (Task 5), `auth.User` (already implemented).
- Produces:
  - `var ErrDraftNotFound, ErrDraftNameTaken, ErrRevisionMismatch error`
  - `type Draft struct { ID, Owner, Name, Status string; BaseVersionID, Revision int64; CreatedAt, UpdatedAt time.Time }`
  - `func (s *Store) CreateDraft(ctx, owner auth.User, name string) (Draft, error)`
  - `func (s *Store) ListDrafts(ctx, owner *auth.User) ([]Draft, error)`
  - `func (s *Store) ReadDraft(ctx, draftID string) (doc projectdoc.ProjectDoc, revision string, err error)`
  - `func (s *Store) WriteDraft(ctx, draftID string, doc projectdoc.ProjectDoc, expectRevision string) (newRevision string, err error)`
  - `func (s *Store) DeleteDraft(ctx, draftID string) error`
  - `func (s *Store) DiffDraft(ctx, draftID string) ([]EntityDiff, error)`

`WriteDraft`'s revision is the draft's `revision` counter (an integer,
formatted as a decimal string), not `updated_at` as the spec sketches —
functionally identical CAS semantics (compare-and-swap on an opaque
token from the last read), but immune to timestamp-resolution edge
cases and simpler to reason about.

- [ ] **Step 1: Write the failing test**

`internal/pgstore/drafts_test.go`:
```go
package pgstore

import (
	"context"
	"errors"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func TestCreateDraftFromCurrentVersion(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})

	d, err := s.CreateDraft(context.Background(), author, "my-changes")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if d.BaseVersionID != v1 || d.Status != "open" || d.Revision != 0 {
		t.Fatalf("unexpected draft: %+v", d)
	}
}

func TestCreateDraftDuplicateName(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	insertVersion(t, s, author, nil)
	ctx := context.Background()

	if _, err := s.CreateDraft(ctx, author, "dup"); err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := s.CreateDraft(ctx, author, "dup"); !errors.Is(err, ErrDraftNameTaken) {
		t.Fatalf("got err %v, want ErrDraftNameTaken", err)
	}
}

func TestReadDraftMergesBaseAndOverrides(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}

	doc, revision, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	if revision != "0" {
		t.Fatalf("got revision %q, want \"0\"", revision)
	}
	if len(doc.Topology.Devices) != 1 || doc.Topology.Devices[0].Name != "r1" {
		t.Fatalf("got devices %+v", doc.Topology.Devices)
	}
}

func TestWriteDraftPersistsOnlyRealDiffsAndBumpsRevision(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	doc, revision, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}

	doc.Topology.Devices = append(doc.Topology.Devices, projectdoc.DeviceDoc{Name: "r2", Kind: "router"})
	newRevision, err := s.WriteDraft(ctx, d.ID, doc, revision)
	if err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}
	if newRevision != "1" {
		t.Fatalf("got revision %q, want \"1\"", newRevision)
	}

	overrides, err := s.draftOverrides(ctx, d.ID)
	if err != nil {
		t.Fatalf("draftOverrides: %v", err)
	}
	if len(overrides) != 1 {
		t.Fatalf("got %d overrides, want 1 (only r2 differs from base)", len(overrides))
	}

	// Writing the same doc again (no actual change) should clear the
	// override back out once it's reverted to match base.
	doc.Topology.Devices = doc.Topology.Devices[:1] // drop r2 again
	finalRevision, err := s.WriteDraft(ctx, d.ID, doc, newRevision)
	if err != nil {
		t.Fatalf("WriteDraft (revert): %v", err)
	}
	if finalRevision != "2" {
		t.Fatalf("got revision %q, want \"2\"", finalRevision)
	}
	overrides, err = s.draftOverrides(ctx, d.ID)
	if err != nil {
		t.Fatalf("draftOverrides: %v", err)
	}
	if len(overrides) != 0 {
		t.Fatalf("got %d overrides, want 0 (draft reverted to base)", len(overrides))
	}
}

func TestWriteDraftRevisionMismatch(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, nil)
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	doc, _, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}

	if _, err := s.WriteDraft(ctx, d.ID, doc, "999"); !errors.Is(err, ErrRevisionMismatch) {
		t.Fatalf("got err %v, want ErrRevisionMismatch", err)
	}
}

func TestDeleteDraft(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, nil)
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}

	if err := s.DeleteDraft(ctx, d.ID); err != nil {
		t.Fatalf("DeleteDraft: %v", err)
	}
	if _, err := s.DeleteDraft(ctx, d.ID); !errors.Is(err, ErrDraftNotFound) {
		t.Fatalf("got err %v, want ErrDraftNotFound on double-delete", err)
	}
}

func TestListDraftsFiltersByOwner(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, nil)
	if _, err := s.CreateDraft(ctx, author, "a"); err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}

	mine, err := s.ListDrafts(ctx, &author)
	if err != nil {
		t.Fatalf("ListDrafts: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("got %d drafts, want 1", len(mine))
	}

	all, err := s.ListDrafts(ctx, nil)
	if err != nil {
		t.Fatalf("ListDrafts(nil): %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("got %d drafts, want 1", len(all))
	}
}

func TestDiffDraft(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	doc, revision, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	doc.Topology.Devices = append(doc.Topology.Devices, projectdoc.DeviceDoc{Name: "r2", Kind: "router"})
	if _, err := s.WriteDraft(ctx, d.ID, doc, revision); err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}

	diffs, err := s.DiffDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("DiffDraft: %v", err)
	}
	if len(diffs) != 1 || diffs[0].Key != "r2" || diffs[0].Change != "added" {
		t.Fatalf("got %+v", diffs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pgstore/... -run 'TestCreateDraft|TestReadDraft|TestWriteDraft|TestDeleteDraft|TestListDrafts|TestDiffDraft'`
Expected: FAIL — `Draft`/`CreateDraft`/etc. undefined.

- [ ] **Step 3: Write `internal/pgstore/drafts.go`**

```go
package pgstore

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/projectdoc"
)

var (
	ErrDraftNotFound    = errors.New("draft not found")
	ErrDraftNameTaken   = errors.New("a draft with this name already exists")
	ErrRevisionMismatch = errors.New("draft was changed by another request; reload and retry")
)

// Draft is a personal set of edits layered on top of a base version.
type Draft struct {
	ID            string
	Owner         string
	Name          string
	BaseVersionID int64
	Status        string // open|conflict|merged|closed
	Revision      int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

const draftColumns = "id, owner::text, name, base_version_id, status, revision, created_at, updated_at"

func scanDraft(row pgx.Row) (Draft, error) {
	var d Draft
	err := row.Scan(&d.ID, &d.Owner, &d.Name, &d.BaseVersionID, &d.Status, &d.Revision, &d.CreatedAt, &d.UpdatedAt)
	return d, err
}

// CreateDraft opens a new personal draft from the current version.
func (s *Store) CreateDraft(ctx context.Context, owner auth.User, name string) (Draft, error) {
	current, err := s.CurrentVersion(ctx)
	if err != nil {
		return Draft{}, err
	}
	d, err := scanDraft(s.db.QueryRow(ctx, `
		INSERT INTO drafts (owner, name, base_version_id)
		VALUES ($1, $2, $3)
		RETURNING `+draftColumns, owner.ID, name, current))
	if err != nil {
		if isUniqueViolation(err) {
			return Draft{}, ErrDraftNameTaken
		}
		return Draft{}, fmt.Errorf("create draft: %w", err)
	}
	return d, nil
}

// ListDrafts lists drafts, optionally filtered to one owner (pass nil for
// every draft — used for admin review).
func (s *Store) ListDrafts(ctx context.Context, owner *auth.User) ([]Draft, error) {
	var rows pgx.Rows
	var err error
	if owner != nil {
		rows, err = s.db.Query(ctx, `SELECT `+draftColumns+` FROM drafts WHERE owner = $1 ORDER BY created_at DESC`, owner.ID)
	} else {
		rows, err = s.db.Query(ctx, `SELECT `+draftColumns+` FROM drafts ORDER BY created_at DESC`)
	}
	if err != nil {
		return nil, fmt.Errorf("list drafts: %w", err)
	}
	defer rows.Close()

	var out []Draft
	for rows.Next() {
		d, err := scanDraft(rows)
		if err != nil {
			return nil, fmt.Errorf("scan draft: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) getDraft(ctx context.Context, draftID string) (Draft, error) {
	d, err := scanDraft(s.db.QueryRow(ctx, `SELECT `+draftColumns+` FROM drafts WHERE id = $1`, draftID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, ErrDraftNotFound
	}
	if err != nil {
		return Draft{}, fmt.Errorf("get draft: %w", err)
	}
	return d, nil
}

func revisionToken(rev int64) string { return strconv.FormatInt(rev, 10) }

// ReadDraft returns the draft's current effective document (its base
// version with its own edits layered on top) and a CAS token for
// WriteDraft.
func (s *Store) ReadDraft(ctx context.Context, draftID string) (projectdoc.ProjectDoc, string, error) {
	d, err := s.getDraft(ctx, draftID)
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	doc, err := fromEntities(mergeSnapshot(base, overrides))
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	return doc, revisionToken(d.Revision), nil
}

// WriteDraft replaces the draft's edits with whatever doc implies
// relative to its base version: entities that now differ from base are
// upserted into draft_entity_changes; entities that used to differ but
// now match base again are cleared, so a draft only ever stores real
// diffs. CAS via expectRevision, from a prior ReadDraft/WriteDraft call.
func (s *Store) WriteDraft(ctx context.Context, draftID string, doc projectdoc.ProjectDoc, expectRevision string) (string, error) {
	d, err := s.getDraft(ctx, draftID)
	if err != nil {
		return "", err
	}
	if revisionToken(d.Revision) != expectRevision {
		return "", ErrRevisionMismatch
	}

	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return "", err
	}
	targetEntities, err := toEntities(doc)
	if err != nil {
		return "", err
	}
	target := make(map[entityRef]entityRow, len(targetEntities))
	for ref, data := range targetEntities {
		target[ref] = entityRow{Data: data}
	}
	diffs := diffSnapshots(base, target)

	existingOverrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return "", err
	}
	touched := make(map[entityRef]bool, len(diffs))
	for _, diff := range diffs {
		touched[entityRef{Kind: diff.Kind, Key: diff.Key}] = true
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for ref := range existingOverrides {
		if touched[ref] {
			continue
		}
		if _, err := tx.Exec(ctx, `DELETE FROM draft_entity_changes WHERE draft_id=$1 AND kind=$2 AND key=$3`, draftID, ref.Kind, ref.Key); err != nil {
			return "", fmt.Errorf("clear stale draft override: %w", err)
		}
	}
	for _, diff := range diffs {
		var data []byte
		if diff.Change != "removed" {
			data = diff.After
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO draft_entity_changes (draft_id, kind, key, change, data)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (draft_id, kind, key) DO UPDATE SET change = EXCLUDED.change, data = EXCLUDED.data`,
			draftID, diff.Kind, diff.Key, diff.Change, data)
		if err != nil {
			return "", fmt.Errorf("upsert draft override: %w", err)
		}
	}

	newRevision := d.Revision + 1
	tag, err := tx.Exec(ctx, `UPDATE drafts SET revision=$1, updated_at=now() WHERE id=$2 AND revision=$3`, newRevision, draftID, d.Revision)
	if err != nil {
		return "", fmt.Errorf("bump draft revision: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", ErrRevisionMismatch
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return revisionToken(newRevision), nil
}

func (s *Store) DeleteDraft(ctx context.Context, draftID string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM drafts WHERE id=$1`, draftID)
	if err != nil {
		return fmt.Errorf("delete draft: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrDraftNotFound
	}
	return nil
}

// DiffDraft reports every entity the draft has changed relative to its
// base version.
func (s *Store) DiffDraft(ctx context.Context, draftID string) ([]EntityDiff, error) {
	d, err := s.getDraft(ctx, draftID)
	if err != nil {
		return nil, err
	}
	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return nil, err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return nil, err
	}
	return diffSnapshots(base, mergeSnapshot(base, overrides)), nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for every test in the package.

- [ ] **Step 5: Commit**

```bash
git add internal/pgstore/drafts.go internal/pgstore/drafts_test.go
git commit -m "feat(pgstore): add draft CRUD, CAS writes, and draft-vs-base diff"
```

---

### Task 7: `internal/pgstore` — conflicts and confirm

**Files:**
- Create: `internal/pgstore/confirm.go`
- Create: `internal/pgstore/confirm_test.go`

**Interfaces:**
- Consumes: everything from Tasks 2-6.
- Produces:
  - `type EntityConflict struct { Kind, Key string; DraftValue, CurrentValue json.RawMessage }`
  - `var ErrConfirmRace error`
  - `func (s *Store) Conflicts(ctx, draftID string) ([]EntityConflict, error)`
  - `func (s *Store) Confirm(ctx, draftID string, admin auth.User) (newVersion int64, conflicts []EntityConflict, err error)`

- [ ] **Step 1: Write the failing test**

`internal/pgstore/confirm_test.go`:
```go
package pgstore

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func TestConfirmNoConflictsCreatesVersion(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	doc, revision, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	doc.Topology.Devices = append(doc.Topology.Devices, projectdoc.DeviceDoc{Name: "r2", Kind: "router"})
	if _, err := s.WriteDraft(ctx, d.ID, doc, revision); err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}

	newVersion, conflicts, err := s.Confirm(ctx, d.ID, author)
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("got conflicts %+v, want none", conflicts)
	}
	if newVersion <= v1 {
		t.Fatalf("got version %d, want > %d", newVersion, v1)
	}

	final, err := s.ReadAt(ctx, newVersion)
	if err != nil {
		t.Fatalf("ReadAt(newVersion): %v", err)
	}
	if len(final.Topology.Devices) != 2 {
		t.Fatalf("got %d devices in confirmed version, want 2", len(final.Topology.Devices))
	}

	confirmed, err := s.getDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("getDraft: %v", err)
	}
	if confirmed.Status != "merged" {
		t.Fatalf("got draft status %q, want merged", confirmed.Status)
	}
}

func TestConfirmDetectsConflictOnSharedEntity(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})

	// Two drafts from the same base, both touching r1.
	draftA, err := s.CreateDraft(ctx, author, "draft-a")
	if err != nil {
		t.Fatalf("CreateDraft A: %v", err)
	}
	draftB, err := s.CreateDraft(ctx, author, "draft-b")
	if err != nil {
		t.Fatalf("CreateDraft B: %v", err)
	}

	docA, revA, err := s.ReadDraft(ctx, draftA.ID)
	if err != nil {
		t.Fatalf("ReadDraft A: %v", err)
	}
	docA.Topology.Devices[0].Kind = "switch"
	if _, err := s.WriteDraft(ctx, draftA.ID, docA, revA); err != nil {
		t.Fatalf("WriteDraft A: %v", err)
	}
	if _, _, err := s.Confirm(ctx, draftA.ID, author); err != nil {
		t.Fatalf("Confirm A: %v", err)
	}

	docB, revB, err := s.ReadDraft(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("ReadDraft B: %v", err)
	}
	docB.Topology.Devices[0].Kind = "firewall"
	if _, err := s.WriteDraft(ctx, draftB.ID, docB, revB); err != nil {
		t.Fatalf("WriteDraft B: %v", err)
	}

	conflicts, err := s.Conflicts(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("Conflicts: %v", err)
	}
	if len(conflicts) != 1 || conflicts[0].Key != "r1" {
		t.Fatalf("got %+v, want one conflict on r1", conflicts)
	}

	newVersion, confirmConflicts, err := s.Confirm(ctx, draftB.ID, author)
	if err != nil {
		t.Fatalf("Confirm B: %v", err)
	}
	if newVersion != 0 || len(confirmConflicts) != 1 {
		t.Fatalf("got version=%d conflicts=%+v, want a blocked confirm with 1 conflict", newVersion, confirmConflicts)
	}

	blocked, err := s.getDraft(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("getDraft: %v", err)
	}
	if blocked.Status != "conflict" {
		t.Fatalf("got draft status %q, want conflict", blocked.Status)
	}
}

func TestConfirmAllowsDisjointConcurrentDrafts(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	draftA, err := s.CreateDraft(ctx, author, "draft-a")
	if err != nil {
		t.Fatalf("CreateDraft A: %v", err)
	}
	draftB, err := s.CreateDraft(ctx, author, "draft-b")
	if err != nil {
		t.Fatalf("CreateDraft B: %v", err)
	}

	docA, revA, err := s.ReadDraft(ctx, draftA.ID)
	if err != nil {
		t.Fatalf("ReadDraft A: %v", err)
	}
	docA.Topology.Devices[0].Kind = "switch" // touches r1
	if _, err := s.WriteDraft(ctx, draftA.ID, docA, revA); err != nil {
		t.Fatalf("WriteDraft A: %v", err)
	}
	if _, _, err := s.Confirm(ctx, draftA.ID, author); err != nil {
		t.Fatalf("Confirm A: %v", err)
	}

	docB, revB, err := s.ReadDraft(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("ReadDraft B: %v", err)
	}
	docB.Topology.Devices[1].Kind = "firewall" // touches r2, disjoint from draft A
	if _, err := s.WriteDraft(ctx, draftB.ID, docB, revB); err != nil {
		t.Fatalf("WriteDraft B: %v", err)
	}

	newVersion, conflicts, err := s.Confirm(ctx, draftB.ID, author)
	if err != nil {
		t.Fatalf("Confirm B: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("got conflicts %+v, want none (disjoint entities)", conflicts)
	}
	if newVersion == 0 {
		t.Fatal("expected a new version")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pgstore/... -run 'TestConfirm'`
Expected: FAIL — `Conflicts`/`Confirm`/`EntityConflict` undefined.

- [ ] **Step 3: Write `internal/pgstore/confirm.go`**

```go
package pgstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/auth"
)

// ErrConfirmRace means another confirm landed between this Confirm
// call's conflict check and its write transaction; the caller should
// re-check conflicts and retry.
var ErrConfirmRace = errors.New("another confirm landed first; recheck conflicts and retry")

// EntityConflict is one entity a draft touched that also changed,
// independently, since the draft's base version.
type EntityConflict struct {
	Kind         string
	Key          string
	DraftValue   json.RawMessage // nil if the draft removed this entity
	CurrentValue json.RawMessage // nil if the entity doesn't exist in the current version
}

// Conflicts reports entities the draft has touched that also changed,
// independently, between the draft's base version and the current one.
// An entity the draft touched but nobody else changed is not a conflict.
func (s *Store) Conflicts(ctx context.Context, draftID string) ([]EntityConflict, error) {
	d, err := s.getDraft(ctx, draftID)
	if err != nil {
		return nil, err
	}
	current, err := s.CurrentVersion(ctx)
	if err != nil {
		return nil, err
	}
	if current == d.BaseVersionID {
		return nil, nil // nothing confirmed since the draft was based; nothing to conflict with
	}

	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return nil, err
	}
	currentSnap, err := s.entitySnapshotAt(ctx, current)
	if err != nil {
		return nil, err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return nil, err
	}

	var conflicts []EntityConflict
	for ref, ov := range overrides {
		baseRow, hadBase := base[ref]
		curRow, hasCurrent := currentSnap[ref]
		switch {
		case !hadBase && !hasCurrent:
			// The draft added a brand-new entity nobody else touched.
		case hadBase && hasCurrent && bytes.Equal(baseRow.Data, curRow.Data):
			// Untouched upstream since the draft's base.
		default:
			var draftValue json.RawMessage
			if ov.Change != "removed" {
				draftValue = ov.Data
			}
			var currentValue json.RawMessage
			if hasCurrent {
				currentValue = curRow.Data
			}
			conflicts = append(conflicts, EntityConflict{Kind: ref.Kind, Key: ref.Key, DraftValue: draftValue, CurrentValue: currentValue})
		}
	}
	sort.Slice(conflicts, func(i, j int) bool {
		if conflicts[i].Kind != conflicts[j].Kind {
			return conflicts[i].Kind < conflicts[j].Kind
		}
		return conflicts[i].Key < conflicts[j].Key
	})
	return conflicts, nil
}

// Confirm merges a draft into a new version if nothing it touched has
// changed independently since its base version. On conflict, no version
// is created and the draft is marked "conflict"; the caller (an admin)
// gets the conflicting entities back instead of an error.
func (s *Store) Confirm(ctx context.Context, draftID string, admin auth.User) (int64, []EntityConflict, error) {
	conflicts, err := s.Conflicts(ctx, draftID)
	if err != nil {
		return 0, nil, err
	}
	if len(conflicts) > 0 {
		if _, err := s.db.Exec(ctx, `UPDATE drafts SET status='conflict', updated_at=now() WHERE id=$1`, draftID); err != nil {
			return 0, nil, fmt.Errorf("mark draft conflicted: %w", err)
		}
		return 0, conflicts, nil
	}

	d, err := s.getDraft(ctx, draftID)
	if err != nil {
		return 0, nil, err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return 0, nil, err
	}
	observedCurrent, err := s.CurrentVersion(ctx)
	if err != nil {
		return 0, nil, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize confirms against each other, and re-verify nothing was
	// confirmed between the conflict check above and this lock.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('firenet_confirm'))`); err != nil {
		return 0, nil, fmt.Errorf("acquire confirm lock: %w", err)
	}
	var nowCurrent int64
	if err := tx.QueryRow(ctx, `SELECT id FROM versions ORDER BY id DESC LIMIT 1`).Scan(&nowCurrent); err != nil {
		return 0, nil, fmt.Errorf("recheck current version: %w", err)
	}
	if nowCurrent != observedCurrent {
		return 0, nil, ErrConfirmRace
	}

	var versionID int64
	err = tx.QueryRow(ctx, `INSERT INTO versions (confirmed_by, draft_id) VALUES ($1,$2) RETURNING id`, admin.ID, draftID).Scan(&versionID)
	if err != nil {
		return 0, nil, fmt.Errorf("insert version: %w", err)
	}
	for ref, row := range overrides {
		_, err := tx.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,$4,$5,$6)`,
			versionID, ref.Kind, ref.Key, row.Change, row.Data, d.Owner)
		if err != nil {
			return 0, nil, fmt.Errorf("insert entity_change: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE drafts SET status='merged', updated_at=now() WHERE id=$1`, draftID); err != nil {
		return 0, nil, fmt.Errorf("mark draft merged: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, fmt.Errorf("commit: %w", err)
	}
	return versionID, nil, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for every test in the package.

- [ ] **Step 5: Commit**

```bash
git add internal/pgstore/confirm.go internal/pgstore/confirm_test.go
git commit -m "feat(pgstore): add entity-level conflict detection and confirm"
```

---

### Task 8: `internal/pgstore` — restore and initial-version seeding

**Files:**
- Create: `internal/pgstore/restore.go`
- Create: `internal/pgstore/seed.go`
- Create: `internal/pgstore/restore_test.go`
- Create: `internal/pgstore/seed_test.go`

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces:
  - `func (s *Store) Restore(ctx, toVersion int64, actor auth.User) (newVersion int64, err error)`
  - `func (s *Store) SeedInitialVersion(ctx, doc projectdoc.ProjectDoc, actor auth.User) (version int64, err error)` — no-op (returns the existing version) if any version already exists.

- [ ] **Step 1: Write the failing tests**

`internal/pgstore/restore_test.go`:
```go
package pgstore

import (
	"context"
	"testing"
)

func TestRestoreRecreatesOldContentAsANewVersion(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "modified", Data: []byte(`{"name":"r1","kind":"switch"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	v3, err := s.Restore(ctx, v1, author)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if v3 <= v2 {
		t.Fatalf("got version %d, want > %d", v3, v2)
	}

	restored, err := s.ReadAt(ctx, v3)
	if err != nil {
		t.Fatalf("ReadAt(v3): %v", err)
	}
	if len(restored.Topology.Devices) != 1 || restored.Topology.Devices[0].Name != "r1" || restored.Topology.Devices[0].Kind != "router" {
		t.Fatalf("got %+v, want only r1/router restored from v1", restored.Topology.Devices)
	}

	history, err := s.History(ctx, 1)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(history) != 1 || history[0].Note == "" {
		t.Fatalf("got %+v, want the newest version to carry a restore note", history)
	}
}

func TestRestoreToCurrentIsANoOp(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
	})

	got, err := s.Restore(ctx, v1, author)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got != v1 {
		t.Fatalf("got %d, want %d (no new version needed)", got, v1)
	}
}
```

`internal/pgstore/seed_test.go`:
```go
package pgstore

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func TestSeedInitialVersionCreatesVersionOne(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	doc := projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{Devices: []projectdoc.DeviceDoc{{Name: "r1", Kind: "router"}}},
		Subnets:  projectdoc.SubnetsDoc{Subnets: []projectdoc.SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}},
		Rules:    projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{Name: "FIRENET-FWD", DefaultAction: "deny"}}},
	}

	v, err := s.SeedInitialVersion(ctx, doc, author)
	if err != nil {
		t.Fatalf("SeedInitialVersion: %v", err)
	}

	got, err := s.ReadAt(ctx, v)
	if err != nil {
		t.Fatalf("ReadAt: %v", err)
	}
	if len(got.Topology.Devices) != 1 || len(got.Subnets.Subnets) != 1 || len(got.Rules.Chains) != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestSeedInitialVersionIsANoOpIfAlreadySeeded(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	first := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
	})

	second, err := s.SeedInitialVersion(ctx, projectdoc.ProjectDoc{}, author)
	if err != nil {
		t.Fatalf("SeedInitialVersion: %v", err)
	}
	if second != first {
		t.Fatalf("got %d, want %d (should be a no-op)", second, first)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pgstore/... -run 'TestRestore|TestSeedInitialVersion'`
Expected: FAIL — `Restore`/`SeedInitialVersion` undefined.

- [ ] **Step 3: Write `internal/pgstore/restore.go`**

```go
package pgstore

import (
	"context"
	"fmt"

	"github.com/kudes1/firenet/internal/auth"
)

// Restore creates a new version whose content equals a past version's,
// by diffing the current state against the target and replaying that
// diff as fresh entity_changes rows (never rewriting history).
func (s *Store) Restore(ctx context.Context, toVersion int64, actor auth.User) (int64, error) {
	current, err := s.CurrentVersion(ctx)
	if err != nil {
		return 0, err
	}
	if toVersion == current {
		return current, nil
	}

	currentSnap, err := s.entitySnapshotAt(ctx, current)
	if err != nil {
		return 0, err
	}
	target, err := s.entitySnapshotAt(ctx, toVersion)
	if err != nil {
		return 0, err
	}
	diffs := diffSnapshots(currentSnap, target)
	if len(diffs) == 0 {
		return current, nil
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var versionID int64
	note := fmt.Sprintf("restored to v%d", toVersion)
	if err := tx.QueryRow(ctx, `INSERT INTO versions (confirmed_by, note) VALUES ($1,$2) RETURNING id`, actor.ID, note).Scan(&versionID); err != nil {
		return 0, fmt.Errorf("insert version: %w", err)
	}
	for _, d := range diffs {
		var data []byte
		if d.Change != "removed" {
			data = d.After
		}
		_, err := tx.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,$4,$5,$6)`,
			versionID, d.Kind, d.Key, d.Change, data, actor.ID)
		if err != nil {
			return 0, fmt.Errorf("insert entity_change: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return versionID, nil
}
```

- [ ] **Step 4: Write `internal/pgstore/seed.go`**

```go
package pgstore

import (
	"context"
	"errors"
	"fmt"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/projectdoc"
)

// SeedInitialVersion records doc as version 1 (author-attributed to
// actor, no draft) — used once, at first startup, to import whatever
// legacy topology.yaml/subnets.yaml/rules.yaml/layout the project had
// before this feature existed. A no-op (returns the existing version)
// once any version exists, so it's safe to call on every startup.
func (s *Store) SeedInitialVersion(ctx context.Context, doc projectdoc.ProjectDoc, actor auth.User) (int64, error) {
	existing, err := s.CurrentVersion(ctx)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, ErrNoVersions) {
		return 0, err
	}

	entities, err := toEntities(doc)
	if err != nil {
		return 0, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var versionID int64
	if err := tx.QueryRow(ctx, `INSERT INTO versions (confirmed_by, note) VALUES ($1,'initial import') RETURNING id`, actor.ID).Scan(&versionID); err != nil {
		return 0, fmt.Errorf("insert version: %w", err)
	}
	for ref, data := range entities {
		_, err := tx.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,'added',$4,$5)`,
			versionID, ref.Kind, ref.Key, data, actor.ID)
		if err != nil {
			return 0, fmt.Errorf("insert entity_change: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return versionID, nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for every test in the package — this closes out `internal/pgstore`.

- [ ] **Step 6: Commit**

```bash
git add internal/pgstore/restore.go internal/pgstore/seed.go internal/pgstore/restore_test.go internal/pgstore/seed_test.go
git commit -m "feat(pgstore): add version restore and one-time initial-version seeding"
```

---

### Task 9: Wire `pgstore` into `internal/httpapi` — topology/subnets/rules/layout

**Files:**
- Modify: `internal/pgstore/drafts.go:88` (export `getDraft` as `GetDraft` — httpapi needs `Draft.Owner`/`Status` for its ownership checks, and this is the only piece of draft metadata not already reachable through a public method)
- Modify: `internal/httpapi/store.go` (drop the `ProjectStore` interface; `FileProjectStore` stays, used only by Task 14's one-time import)
- Modify: `internal/httpapi/handlers.go` (rewrite: `handlers.store` becomes `*pgstore.Store`, topology/subnets/rules/layout handlers become draft- and current-version-aware)

**Interfaces:**
- Consumes: `pgstore.Store` methods from Tasks 5, 6 (`CurrentVersion`, `ReadAt`, `GetDraft`, `ReadDraft`, `WriteDraft`), `projectdoc.ProjectDoc`.
- Produces:
  - `type handlers struct { projects *pgstore.Store; users *auth.Store; log *slog.Logger }` (renamed from `store` — every reference in this file is being rewritten anyway)
  - `func (h *handlers) currentDoc(r *http.Request) (projectdoc.ProjectDoc, error)`
  - `func (h *handlers) canAccessDraft(r *http.Request, d pgstore.Draft) bool`
  - `func (h *handlers) resolveDraftForAccess(w, r) (pgstore.Draft, bool)` — 403s and returns `false` if the caller isn't the owner or an admin
  - `func (h *handlers) writeStoreError(w, err)` — maps `pgstore` sentinel errors to HTTP status
  - `getCurrentTopology/Subnets/Rules/Layout`, `getDraftTopology/Subnets/Rules/Layout`, `putDraftTopology/Subnets/Rules/Layout` handler methods (route wiring is Task 13)

This task has no isolated unit test of its own — `internal/httpapi` handler tests are entirely rewritten in Task 13 once routing exists to drive them through. Verify this task by `go build ./internal/httpapi/...` succeeding (it won't fully build until Task 10 supplies the remaining handlers server.go references, so build the package in isolation by temporarily commenting nothing — see Step 6).

- [ ] **Step 1: Export `GetDraft`**

In `internal/pgstore/drafts.go`, rename `getDraft` to `GetDraft` (its receiver, doc comment, and all six call sites within the file — `ReadDraft`, `WriteDraft`, `DiffDraft`, plus the three in `confirm.go`/`restore.go` that call `s.getDraft`):
```go
// GetDraft returns a draft's metadata (owner, status, base version,
// revision) without resolving its document — used by internal/httpapi
// for ownership checks before a full ReadDraft/WriteDraft.
func (s *Store) GetDraft(ctx context.Context, draftID string) (Draft, error) {
```
Update `internal/pgstore/confirm.go`'s two calls (`Conflicts`, `Confirm`) from `s.getDraft(` to `s.GetDraft(`.

Run: `go test ./internal/pgstore/... -v`
Expected: `PASS` for every test (pure rename, no behavior change).

- [ ] **Step 2: Trim `internal/httpapi/store.go`**

Delete the `ProjectStore` interface (`internal/httpapi/store.go:13-28`). Leave `FileProjectStore` and everything below it (`EnsureSeeded`, `emptyTopologyYAML`, etc.) untouched — Task 14 still needs them for the one-time legacy import.

- [ ] **Step 3: Rewrite the top of `internal/httpapi/handlers.go`**

Replace lines 1-226 (package doc through `loadTopology`) with:
```go
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/app"
	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

type handlers struct {
	projects *pgstore.Store
	users    *auth.Store
	log      *slog.Logger
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// writeStoreError maps pgstore's sentinel errors to the right HTTP
// status; anything else is a 500.
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgstore.ErrDraftNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, pgstore.ErrNoVersions):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, pgstore.ErrRevisionMismatch):
		writeError(w, http.StatusConflict, err)
	case errors.Is(err, pgstore.ErrDraftNameTaken):
		writeError(w, http.StatusConflict, err)
	case errors.Is(err, pgstore.ErrConfirmRace):
		writeError(w, http.StatusConflict, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

// currentDoc resolves the read-only current confirmed version.
func (h *handlers) currentDoc(r *http.Request) (projectdoc.ProjectDoc, error) {
	v, err := h.projects.CurrentVersion(r.Context())
	if err != nil {
		return projectdoc.ProjectDoc{}, err
	}
	return h.projects.ReadAt(r.Context(), v)
}

// canAccessDraft reports whether the request's caller may read/write
// draft d: its owner, or any admin.
func (h *handlers) canAccessDraft(r *http.Request, d pgstore.Draft) bool {
	user, _ := auth.UserFromContext(r.Context())
	return user.Role == auth.RoleAdmin || user.ID == d.Owner
}

// resolveDraftForAccess loads the {id} path draft and 403s if the caller
// may not access it. Callers stop (return) when ok is false.
func (h *handlers) resolveDraftForAccess(w http.ResponseWriter, r *http.Request) (pgstore.Draft, bool) {
	d, err := h.projects.GetDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return pgstore.Draft{}, false
	}
	if !h.canAccessDraft(r, d) {
		writeError(w, http.StatusForbidden, errors.New("not the owner of this draft"))
		return pgstore.Draft{}, false
	}
	return d, true
}

// deletionErrorsFromDocs diffs prev's topology+subnets against next's and
// reports removed objects still referenced by prev's rules. A broken
// prev/next or unparseable proposal yields no deletions here — full
// validation reports those instead.
func deletionErrorsFromDocs(prev, next projectdoc.ProjectDoc) []string {
	prevTopoYAML, err := yaml.Marshal(prev.Topology)
	if err != nil {
		return nil
	}
	prevSubnetsYAML, err := yaml.Marshal(prev.Subnets)
	if err != nil {
		return nil
	}
	prevTopo, err := app.LoadProject(prevTopoYAML, prevSubnetsYAML)
	if err != nil {
		return nil
	}

	nextTopoYAML, err := yaml.Marshal(next.Topology)
	if err != nil {
		return nil
	}
	nextSubnetsYAML, err := yaml.Marshal(next.Subnets)
	if err != nil {
		return nil
	}
	nextTopo, err := app.ParseProject(nextTopoYAML, nextSubnetsYAML)
	if err != nil {
		return nil
	}

	rulesYAML, err := yaml.Marshal(prev.Rules)
	if err != nil {
		return nil
	}
	pol, err := rules.Load(bytes.NewReader(rulesYAML))
	if err != nil {
		pol = nil // broken rules: topology-only checks; rules load reports the breakage elsewhere
	}
	return app.DeletionErrors(prevTopo, nextTopo, pol)
}

// loadTopologyDoc validates doc's topology+subnets as one merged,
// cross-referenced topology.Topology (mirrors the old loadTopology, now
// sourced from a ProjectDoc instead of the file store).
func loadTopologyDoc(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	topo, err := app.LoadProject(topoYAML, subnetsYAML)
	if err != nil {
		return nil, fmt.Errorf("project is invalid: %w", err)
	}
	return topo, nil
}
```

- [ ] **Step 4: Replace `getTopology`/`putTopology`/`getSubnets`/`putSubnets` (`internal/httpapi/handlers.go`, formerly lines 38-169)**

```go
func (h *handlers) getCurrentTopology(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Topology)
}

func (h *handlers) getDraftTopology(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Topology)
}

func (h *handlers) putDraftTopology(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var topo projectdoc.TopologyDoc
	if err := json.NewDecoder(r.Body).Decode(&topo); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Topology = topo

	if errs := deletionErrorsFromDocs(prev, next); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
		return
	}
	if _, err := loadTopologyDoc(next); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, topo)
}

// requestRevision prefers the client-supplied X-Draft-Revision (from its
// last GET) for the CAS check; falling back to the revision this handler
// itself just read is only a safety net for a client that omits the
// header, not the intended flow.
func requestRevision(r *http.Request, fallback string) string {
	if h := r.Header.Get("X-Draft-Revision"); h != "" {
		return h
	}
	return fallback
}

// getLinkExports serves the reachable export candidates for one side of a
// link: networks and subnets the side's device can reach when that very
// link is excluded from the graph (GET /api/drafts/{id}/link-exports?link=N&side=a|b,
// or the /api/versions/current/ equivalent).
func (h *handlers) getDraftLinkExports(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.writeLinkExports(w, r, doc)
}

func (h *handlers) getCurrentLinkExports(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.writeLinkExports(w, r, doc)
}

func (h *handlers) writeLinkExports(w http.ResponseWriter, r *http.Request, doc projectdoc.ProjectDoc) {
	q := r.URL.Query()
	idx, err := strconv.Atoi(q.Get("link"))
	side := q.Get("side")
	if err != nil || idx < 0 || (side != "a" && side != "b") {
		writeError(w, http.StatusUnprocessableEntity, errors.New("invalid link index or side"))
		return
	}
	topo, err := loadTopologyDoc(doc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if idx >= len(topo.Links) {
		writeError(w, http.StatusNotFound, fmt.Errorf("no link %d", idx))
		return
	}
	l := topo.Links[idx]
	dev := l.A.Device
	if side == "b" {
		dev = l.B.Device
	}
	names, err := graph.ReachableEntities(topo, dev, idx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	out := make([]projectdoc.EntityDoc, 0, len(names))
	for _, n := range names {
		cidr := ""
		if s, ok := topo.Subnets[n]; ok {
			cidr = s.CIDR.String()
		}
		out = append(out, projectdoc.EntityDoc{Name: n, CIDR: cidr})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entities": out})
}

func (h *handlers) getCurrentSubnets(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Subnets)
}

func (h *handlers) getDraftSubnets(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Subnets)
}

func (h *handlers) putDraftSubnets(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var subnets projectdoc.SubnetsDoc
	if err := json.NewDecoder(r.Body).Decode(&subnets); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Subnets = subnets

	if errs := deletionErrorsFromDocs(prev, next); len(errs) > 0 {
		writeError(w, http.StatusConflict, errors.New(strings.Join(errs, "; ")))
		return
	}
	if _, err := loadTopologyDoc(next); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, subnets)
}
```

- [ ] **Step 5: Replace `getRules`/`putRules`/`validateAndPersistRules`/`getLayout`/`putLayout` (formerly lines 228-278 and 461-486)**

```go
func (h *handlers) getCurrentRules(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Rules)
}

func (h *handlers) getDraftRules(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Rules)
}

func (h *handlers) putDraftRules(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var policy projectdoc.PolicyDoc
	if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Rules = policy

	topo, err := loadTopologyDoc(next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	pol := policy.ToPolicy()
	if err := pol.Validate(topo); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, policy)
}

func (h *handlers) getCurrentLayout(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Layout)
}

func (h *handlers) getDraftLayout(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, revision, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", revision)
	writeJSON(w, http.StatusOK, doc.Layout)
}

func (h *handlers) putDraftLayout(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	var layout projectdoc.LayoutDoc
	if err := json.NewDecoder(r.Body).Decode(&layout); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	id := r.PathValue("id")
	prev, revision, err := h.projects.ReadDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	next := prev
	next.Layout = layout

	newRevision, err := h.projects.WriteDraft(r.Context(), id, next, requestRevision(r, revision))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("X-Draft-Revision", newRevision)
	writeJSON(w, http.StatusOK, layout)
}
```

(Layout keeps its original behavior: no validation, pure passthrough —
only now typed as `projectdoc.LayoutDoc` instead of raw JSON, and routed
through a draft like everything else. The `Content-Type:
application/json` + raw-bytes write the old `getLayout`/`putLayout` did
is no longer needed: `writeJSON`/`json.Decode` on a typed `LayoutDoc`
round-trip the same wire shape.)

- [ ] **Step 6: Verify the package compiles in isolation**

`server.go` still references the old `NewServer(store ProjectStore, ...)` signature and the handlers this task removed (`compile`/`diagnose`/`validate`/`lint`, the old `getTopology` etc. names) — Task 10 finishes replacing those and Task 13 rewrites `server.go`. For now, confirm just the handlers you touched are consistent:

Run: `go vet ./internal/httpapi/... 2>&1 | grep -v "server.go\|handlers_test.go"`
Expected: no output referencing `handlers.go` — any remaining errors should only be from `server.go` (old `NewServer` call, old handler names) and `handlers_test.go` (old `newTestServer`), both addressed in later tasks. If `handlers.go` itself shows an error, fix it now — don't defer package-internal mistakes to Task 13.

- [ ] **Step 7: Commit**

```bash
git add internal/pgstore/drafts.go internal/pgstore/confirm.go internal/httpapi/store.go internal/httpapi/handlers.go
git commit -m "feat(httpapi): make topology/subnets/rules/layout draft- and version-aware"
```

---

### Task 10: `internal/httpapi` — validate/compile/diagnose/lint

**Files:**
- Modify: `internal/httpapi/handlers.go` (replace `validate`, `compile`, `diagnose`, `lint`, `validateAndPersistRules` — the last is now folded into Task 9's `putDraftRules`, so it's simply deleted)

**Interfaces:**
- Consumes: `loadTopologyDoc` (Task 9), `projectdoc.ProjectDoc`.
- Produces: `validateDoc`, `compileDoc`, `diagnoseDoc`, `lintDoc` (doc-taking core logic) plus `validateCurrent/validateDraft`, `compileCurrent/compileDraft`, `diagnoseCurrent/diagnoseDraft`, `lintCurrent/lintDraft` handler methods.

- [ ] **Step 1: Add the doc-taking core functions and their eight thin handlers**

Append to `internal/httpapi/handlers.go`:
```go
func validateDoc(doc projectdoc.ProjectDoc) []string {
	var errs []string
	topo, err := loadTopologyDoc(doc)
	if err != nil {
		return append(errs, err.Error())
	}
	pol := doc.Rules.ToPolicy()
	if err := pol.Validate(topo); err != nil {
		errs = append(errs, err.Error())
	}
	return errs
}

func (h *handlers) validateCurrent(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	errs := validateDoc(doc)
	writeJSON(w, http.StatusOK, map[string]any{"valid": len(errs) == 0, "errors": errs})
}

func (h *handlers) validateDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	errs := validateDoc(doc)
	writeJSON(w, http.StatusOK, map[string]any{"valid": len(errs) == 0, "errors": errs})
}

func (h *handlers) compileDoc(ctx context.Context, doc projectdoc.ProjectDoc) (any, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	rulesYAML, err := yaml.Marshal(doc.Rules)
	if err != nil {
		return nil, err
	}
	return app.Compile(ctx, h.log, app.CompileOptions{TopologyYAML: topoYAML, SubnetsYAML: subnetsYAML, RulesYAML: rulesYAML})
}

func (h *handlers) compileCurrent(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	devices, err := h.compileDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, devices)
}

func (h *handlers) compileDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	devices, err := h.compileDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, devices)
}

type diagnoseRequest struct {
	Src      string   `json:"src"`
	Dst      string   `json:"dst"`
	Proto    string   `json:"proto"`
	SrcPorts []string `json:"srcPorts"`
	DstPorts []string `json:"dstPorts"`
}

var diagnoseProtos = map[string]bool{"": true, "tcp": true, "udp": true, "icmp": true}

// validatePortSpec accepts a single port number or a "lo:hi" range,
// mirroring the compiled-rule port syntax MatchFlow compares against.
func validatePortSpec(spec string) error {
	loStr, hiStr, ranged := strings.Cut(spec, ":")
	if !ranged {
		hiStr = loStr
	}
	lo, err1 := strconv.Atoi(loStr)
	hi, err2 := strconv.Atoi(hiStr)
	switch {
	case err1 != nil || err2 != nil || lo < 1 || hi > 65535:
		return fmt.Errorf("invalid port spec %q", spec)
	case lo > hi:
		return fmt.Errorf("invalid port range %q: from must not exceed to", spec)
	}
	return nil
}

func validatePortList(ports []string) error {
	for _, p := range ports {
		if err := validatePortSpec(p); err != nil {
			return err
		}
	}
	return nil
}

// parseDiagnoseRequest decodes and validates the request body shared by
// both diagnose variants; the returned diagnose.Flow is ready to compile.
func parseDiagnoseRequest(r *http.Request) (diagnose.Flow, error) {
	var req diagnoseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return diagnose.Flow{}, fmt.Errorf("invalid body: %w", err)
	}
	if !diagnoseProtos[req.Proto] {
		return diagnose.Flow{}, fmt.Errorf("invalid proto %q", req.Proto)
	}
	src, err := netip.ParseAddr(req.Src)
	if err != nil {
		return diagnose.Flow{}, fmt.Errorf("invalid src IP: %w", err)
	}
	dst, err := netip.ParseAddr(req.Dst)
	if err != nil {
		return diagnose.Flow{}, fmt.Errorf("invalid dst IP: %w", err)
	}
	if err := validatePortList(req.SrcPorts); err != nil {
		return diagnose.Flow{}, err
	}
	if err := validatePortList(req.DstPorts); err != nil {
		return diagnose.Flow{}, err
	}
	return diagnose.Flow{Src: src, Dst: dst, Proto: rules.Proto(req.Proto), SrcPorts: req.SrcPorts, DstPorts: req.DstPorts}, nil
}

func (h *handlers) diagnoseDoc(ctx context.Context, doc projectdoc.ProjectDoc, flow diagnose.Flow) (any, error) {
	topoYAML, err := yaml.Marshal(doc.Topology)
	if err != nil {
		return nil, err
	}
	subnetsYAML, err := yaml.Marshal(doc.Subnets)
	if err != nil {
		return nil, err
	}
	rulesYAML, err := yaml.Marshal(doc.Rules)
	if err != nil {
		return nil, err
	}
	return app.Diagnose(ctx, h.log, app.DiagnoseOptions{TopologyYAML: topoYAML, SubnetsYAML: subnetsYAML, RulesYAML: rulesYAML, Flow: flow})
}

func (h *handlers) diagnoseCurrent(w http.ResponseWriter, r *http.Request) {
	flow, err := parseDiagnoseRequest(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rep, err := h.diagnoseDoc(r.Context(), doc, flow)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (h *handlers) diagnoseDraft(w http.ResponseWriter, r *http.Request) {
	flow, err := parseDiagnoseRequest(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rep, err := h.diagnoseDoc(r.Context(), doc, flow)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (h *handlers) lintDoc(ctx context.Context, doc projectdoc.ProjectDoc) (any, error) {
	topo, err := loadTopologyDoc(doc)
	if err != nil {
		return nil, err
	}
	pol := doc.Rules.ToPolicy()
	return app.Lint(ctx, h.log, topo, &pol)
}

func (h *handlers) lintCurrent(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	findings, err := h.lintDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": findings})
}

func (h *handlers) lintDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	doc, _, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	findings, err := h.lintDoc(r.Context(), doc)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"findings": findings})
}
```

Add `"context"` to `internal/httpapi/handlers.go`'s import block (`compileDoc`/`diagnoseDoc`/`lintDoc` take a `context.Context` param explicitly, unlike the rest of the file which uses `r.Context()` inline).

- [ ] **Step 2: Verify the package compiles in isolation**

Run: `go vet ./internal/httpapi/... 2>&1 | grep -v "server.go\|handlers_test.go"`
Expected: no output referencing `handlers.go`. Fix anything that does before moving on.

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/handlers.go
git commit -m "feat(httpapi): make validate/compile/diagnose/lint draft- and version-aware"
```

---

### Task 11: `internal/httpapi` — draft management endpoints

**Files:**
- Create: `internal/httpapi/draft_handlers.go`

**Interfaces:**
- Consumes: `pgstore.Store.{CreateDraft,ListDrafts,DeleteDraft,DiffDraft,Conflicts,Confirm}`, `resolveDraftForAccess`/`writeStoreError` (Task 9).
- Produces: `createDraft`, `listDrafts`, `deleteDraft`, `draftDiff`, `confirmDraft` handler methods; `draftResponse`, `entityDiffResponse`, `conflictResponse` JSON shapes.

- [ ] **Step 1: Write `internal/httpapi/draft_handlers.go`**

```go
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

type createDraftRequest struct {
	Name string `json:"name"`
}

type draftResponse struct {
	ID            string `json:"id"`
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	BaseVersionID int64  `json:"baseVersion"`
	Status        string `json:"status"`
}

func toDraftResponse(d pgstore.Draft) draftResponse {
	return draftResponse{ID: d.ID, Owner: d.Owner, Name: d.Name, BaseVersionID: d.BaseVersionID, Status: d.Status}
}

func (h *handlers) createDraft(w http.ResponseWriter, r *http.Request) {
	var req createDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, errors.New("name is required"))
		return
	}
	user, _ := auth.UserFromContext(r.Context())
	d, err := h.projects.CreateDraft(r.Context(), user, req.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toDraftResponse(d))
}

// listDrafts returns the caller's own drafts by default; admins may pass
// ?all=1 to review everyone's, per the spec's "виден ... всем admin для
// ревью".
func (h *handlers) listDrafts(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFromContext(r.Context())
	var owner *auth.User
	if r.URL.Query().Get("all") != "1" || user.Role != auth.RoleAdmin {
		owner = &user
	}
	drafts, err := h.projects.ListDrafts(r.Context(), owner)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	resp := make([]draftResponse, len(drafts))
	for i, d := range drafts {
		resp[i] = toDraftResponse(d)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) deleteDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	if err := h.projects.DeleteDraft(r.Context(), r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type entityDiffResponse struct {
	Kind   string          `json:"kind"`
	Key    string          `json:"key"`
	Change string          `json:"change"`
	Before json.RawMessage `json:"before,omitempty"`
	After  json.RawMessage `json:"after,omitempty"`
}

func toEntityDiffResponses(diffs []pgstore.EntityDiff) []entityDiffResponse {
	out := make([]entityDiffResponse, len(diffs))
	for i, d := range diffs {
		out[i] = entityDiffResponse{Kind: d.Kind, Key: d.Key, Change: d.Change, Before: d.Before, After: d.After}
	}
	return out
}

type draftDiffEntry struct {
	entityDiffResponse
	Conflict bool `json:"conflict"`
}

// draftDiff shows every entity the draft changed relative to its base
// version, each flagged with whether it also conflicts with the current
// version (someone else confirmed a change to the same entity).
func (h *handlers) draftDiff(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	id := r.PathValue("id")
	diffs, err := h.projects.DiffDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	conflicts, err := h.projects.Conflicts(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	conflictKeys := make(map[string]bool, len(conflicts))
	for _, c := range conflicts {
		conflictKeys[c.Kind+"|"+c.Key] = true
	}

	out := make([]draftDiffEntry, len(diffs))
	for i, d := range diffs {
		out[i] = draftDiffEntry{
			entityDiffResponse: entityDiffResponse{Kind: d.Kind, Key: d.Key, Change: d.Change, Before: d.Before, After: d.After},
			Conflict:           conflictKeys[d.Kind+"|"+d.Key],
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type conflictResponse struct {
	Kind         string          `json:"kind"`
	Key          string          `json:"key"`
	DraftValue   json.RawMessage `json:"draftValue,omitempty"`
	CurrentValue json.RawMessage `json:"currentValue,omitempty"`
}

// confirmDraft is admin-only (gated by auth.RequireAdmin at the route,
// Task 13). A clean merge answers 200 with the new version number; a
// conflict answers 409 with the conflicting entities instead of erroring
// — the draft's author resolves them and re-submits.
func (h *handlers) confirmDraft(w http.ResponseWriter, r *http.Request) {
	admin, _ := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	version, conflicts, err := h.projects.Confirm(r.Context(), id, admin)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if len(conflicts) > 0 {
		resp := make([]conflictResponse, len(conflicts))
		for i, c := range conflicts {
			resp[i] = conflictResponse{Kind: c.Kind, Key: c.Key, DraftValue: c.DraftValue, CurrentValue: c.CurrentValue}
		}
		writeJSON(w, http.StatusConflict, map[string]any{"conflicts": resp})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": version})
}
```

- [ ] **Step 2: Verify the package compiles in isolation**

Run: `go vet ./internal/httpapi/... 2>&1 | grep -v "server.go\|handlers_test.go"`
Expected: no output referencing `draft_handlers.go`.

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/draft_handlers.go
git commit -m "feat(httpapi): add draft create/list/delete/diff/confirm endpoints"
```

---

### Task 12: `internal/httpapi` — version history endpoints

**Files:**
- Create: `internal/httpapi/version_handlers.go`

**Interfaces:**
- Consumes: `pgstore.Store.{History,DiffVersions,Restore}` (Tasks 5, 8), `toEntityDiffResponses` (Task 11).
- Produces: `versionHistory`, `versionDiff`, `restoreVersion` handler methods; `versionInfoResponse`.

- [ ] **Step 1: Write `internal/httpapi/version_handlers.go`**

```go
package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

type versionInfoResponse struct {
	ID          int64  `json:"id"`
	CreatedAt   string `json:"createdAt"`
	ConfirmedBy string `json:"confirmedBy,omitempty"`
	DraftID     string `json:"draftId,omitempty"`
	Note        string `json:"note,omitempty"`
}

func toVersionInfoResponse(v pgstore.VersionInfo) versionInfoResponse {
	return versionInfoResponse{
		ID: v.ID, CreatedAt: v.CreatedAt.Format(time.RFC3339),
		ConfirmedBy: v.ConfirmedBy, DraftID: v.DraftID, Note: v.Note,
	}
}

func (h *handlers) versionHistory(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	history, err := h.projects.History(r.Context(), limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	resp := make([]versionInfoResponse, len(history))
	for i, v := range history {
		resp[i] = toVersionInfoResponse(v)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) versionDiff(w http.ResponseWriter, r *http.Request) {
	from, err1 := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	to, err2 := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusBadRequest, errors.New("from and to must be version numbers"))
		return
	}
	diffs, err := h.projects.DiffVersions(r.Context(), from, to)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toEntityDiffResponses(diffs))
}

// restoreVersion is admin-only (gated by auth.RequireAdmin at the route,
// Task 13).
func (h *handlers) restoreVersion(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid version number"))
		return
	}
	admin, _ := auth.UserFromContext(r.Context())
	newVersion, err := h.projects.Restore(r.Context(), n, admin)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": newVersion})
}
```

- [ ] **Step 2: Verify the package compiles in isolation**

Run: `go vet ./internal/httpapi/... 2>&1 | grep -v "server.go\|handlers_test.go"`
Expected: no output referencing `version_handlers.go`.

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/version_handlers.go
git commit -m "feat(httpapi): add version history/diff/restore endpoints"
```

---

### Task 13: Route rewrite and full `handlers_test.go` overhaul

**Files:**
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/compile_ui.go`
- Modify: `internal/httpapi/handlers_test.go` (full rewrite)
- Modify: `internal/httpapi/auth_handlers_test.go` (test-server helper + two URL literals)
- Modify: `internal/httpapi/server_test.go` (one call-site fix)

**Interfaces:**
- Consumes: every handler method from Tasks 9-12.
- Produces: `NewServer(projects *pgstore.Store, users *auth.Store, log *slog.Logger) http.Handler` (drops the `store ProjectStore` param entirely — nothing in the live serving path uses it anymore).

- [ ] **Step 1: Rewrite `internal/httpapi/server.go`**

```go
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

// NewServer builds the HTTP handler for firenet's web UI and JSON API.
// Every /api/ route requires a valid session (login/logout excepted).
// Project content lives entirely in projects (internal/pgstore): the
// current confirmed version is read-only everywhere, edits only ever
// happen inside a personal draft.
func NewServer(projects *pgstore.Store, users *auth.Store, log *slog.Logger) http.Handler {
	h := &handlers{projects: projects, users: users, log: log}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/me", h.me)
	apiMux.Handle("GET /api/users", auth.RequireAdmin(http.HandlerFunc(h.listUsers)))
	apiMux.Handle("POST /api/users", auth.RequireAdmin(http.HandlerFunc(h.createUser)))
	apiMux.Handle("DELETE /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.deleteUser)))

	apiMux.HandleFunc("GET /api/versions", h.versionHistory)
	apiMux.HandleFunc("GET /api/versions/diff", h.versionDiff)
	apiMux.Handle("POST /api/versions/{n}/restore", auth.RequireAdmin(http.HandlerFunc(h.restoreVersion)))
	apiMux.HandleFunc("GET /api/versions/current/topology", h.getCurrentTopology)
	apiMux.HandleFunc("GET /api/versions/current/subnets", h.getCurrentSubnets)
	apiMux.HandleFunc("GET /api/versions/current/rules", h.getCurrentRules)
	apiMux.HandleFunc("GET /api/versions/current/layout", h.getCurrentLayout)
	apiMux.HandleFunc("GET /api/versions/current/link-exports", h.getCurrentLinkExports)
	apiMux.HandleFunc("POST /api/versions/current/validate", h.validateCurrent)
	apiMux.HandleFunc("POST /api/versions/current/compile", h.compileCurrent)
	apiMux.HandleFunc("POST /api/versions/current/diagnose", h.diagnoseCurrent)
	apiMux.HandleFunc("GET /api/versions/current/lint", h.lintCurrent)

	apiMux.HandleFunc("POST /api/drafts", h.createDraft)
	apiMux.HandleFunc("GET /api/drafts", h.listDrafts)
	apiMux.HandleFunc("DELETE /api/drafts/{id}", h.deleteDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}/diff", h.draftDiff)
	apiMux.Handle("POST /api/drafts/{id}/confirm", auth.RequireAdmin(http.HandlerFunc(h.confirmDraft)))
	apiMux.HandleFunc("GET /api/drafts/{id}/topology", h.getDraftTopology)
	apiMux.HandleFunc("PUT /api/drafts/{id}/topology", h.putDraftTopology)
	apiMux.HandleFunc("GET /api/drafts/{id}/subnets", h.getDraftSubnets)
	apiMux.HandleFunc("PUT /api/drafts/{id}/subnets", h.putDraftSubnets)
	apiMux.HandleFunc("GET /api/drafts/{id}/rules", h.getDraftRules)
	apiMux.HandleFunc("PUT /api/drafts/{id}/rules", h.putDraftRules)
	apiMux.HandleFunc("GET /api/drafts/{id}/layout", h.getDraftLayout)
	apiMux.HandleFunc("PUT /api/drafts/{id}/layout", h.putDraftLayout)
	apiMux.HandleFunc("GET /api/drafts/{id}/link-exports", h.getDraftLinkExports)
	apiMux.HandleFunc("POST /api/drafts/{id}/validate", h.validateDraft)
	apiMux.HandleFunc("POST /api/drafts/{id}/compile", h.compileDraft)
	apiMux.HandleFunc("POST /api/drafts/{id}/diagnose", h.diagnoseDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}/lint", h.lintDraft)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", h.login)
	mux.HandleFunc("POST /api/logout", h.logout)
	mux.Handle("/api/", auth.RequireAuth(users)(apiMux))

	mux.HandleFunc("POST /ui/compile", h.uiCompile)

	// Standalone UI pages.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ui/topology", http.StatusFound)
	})
	mux.HandleFunc("GET /login", servePage("login.html"))
	mux.HandleFunc("GET /ui/topology", servePage("topology.html"))
	mux.HandleFunc("GET /ui/subnets", servePage("subnets.html"))
	mux.HandleFunc("GET /ui/networks", servePage("networks.html"))
	mux.HandleFunc("GET /ui/sets", servePage("sets.html"))
	mux.HandleFunc("GET /ui/unions", servePage("unions.html"))
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
	mux.HandleFunc("GET /ui/rules", servePage("rules.html"))
	mux.HandleFunc("GET /ui/compile", servePage("compile.html"))
	mux.HandleFunc("GET /ui/diagnose", servePage("diagnose.html"))
	mux.HandleFunc("GET /ui/users", servePage("users.html"))

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err) // embedded at build time; can't fail at runtime
	}
	mux.Handle("/", noCache(webRoot, http.FileServer(http.FS(webRoot))))

	return withLogging(log, mux)
}

// noCache lets browsers keep assets cached but forbids reuse without
// revalidation: the embed FS carries no modification times, so the file
// server has neither Last-Modified nor ETag, and browsers would otherwise
// heuristically serve stale JS after a rebuild. A content-hash ETag turns
// every revalidation into a cheap 304; a rebuild changes the hash and the
// fresh bytes are served.
func noCache(root fs.FS, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if b, err := fs.ReadFile(root, strings.TrimPrefix(path.Clean(r.URL.Path), "/")); err == nil {
				sum := sha256.Sum256(b)
				etag := `"` + hex.EncodeToString(sum[:8]) + `"`
				w.Header().Set("ETag", etag)
				w.Header().Set("Cache-Control", "no-cache")
				if r.Header.Get("If-None-Match") == etag {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// servePage renders one of the embedded static HTML pages.
func servePage(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := webFiles.ReadFile("web/" + name)
		if err != nil {
			http.Error(w, "page not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	}
}

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Debug("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
```

`/ui/compile` and `/api/link-exports`'s old bare route are gone: link
exports now lives at `/api/drafts/{id}/link-exports` and
`/api/versions/current/link-exports`, matching every other project-data
route's draft/current split.

- [ ] **Step 2: Fix `internal/httpapi/compile_ui.go`**

`/ui/compile` has no draft-selector UI yet (that's Plan 3's job — this
plan only builds the API layer); until then it compiles the read-only
current version, same as visiting `/api/versions/current/compile` would:

```go
package httpapi

import (
	"net/http"

	"github.com/kudes1/firenet/internal/app"
)

type compileView struct {
	Devices []app.CompiledDevice
	Error   string
}

func (h *handlers) uiCompile(w http.ResponseWriter, r *http.Request) {
	doc, err := h.currentDoc(r)
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка чтения проекта: " + err.Error()})
		return
	}
	devicesAny, err := h.compileDoc(r.Context(), doc)
	if err != nil {
		h.renderCompileResults(w, compileView{Error: "Ошибка компиляции: " + err.Error()})
		return
	}
	devices, ok := devicesAny.([]app.CompiledDevice)
	if !ok {
		h.renderCompileResults(w, compileView{Error: "Ошибка компиляции: unexpected result type"})
		return
	}
	h.renderCompileResults(w, compileView{Devices: devices})
}

func (h *handlers) renderCompileResults(w http.ResponseWriter, view compileView) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := rulesTmpl.ExecuteTemplate(w, "compile-results", view); err != nil {
		h.log.Error("render compile results", "err", err)
	}
}
```

(`compileDoc`'s `any` return type — needed so both JSON handlers in Task
10 and this HTML-rendering one can share it — costs one type assertion
here; `app.Compile` itself is still fully typed, so the assertion can't
fail in practice.)

- [ ] **Step 3: Verify the module builds outside the test file**

Run: `go build ./internal/httpapi/... 2>&1`
Expected: fails only on `handlers_test.go` (old `newTestServer`
signature, old URL literals) — fix any error that isn't in
`handlers_test.go` before continuing; `server.go`/`compile_ui.go`/every
non-test `handlers.go`-family file must compile clean on its own.

- [ ] **Step 4: Replace `internal/httpapi/handlers_test.go` in full**

Every test that used to inspect `store.ReadTopology()`/`ReadRules()`/
`ReadSubnets()` now inspects the draft directly through `projects`
(the `*pgstore.Store` `newTestServer` returns) via a new `readDraftDoc`
helper; byte/string assertions against raw stored YAML (a discarded
concept — there is no YAML file anymore) become struct-field checks or,
where the check was already redundant with an existing JSON-level
assertion in the same test, are dropped. `TestGetRulesNormalizesLegacyFile`
is deleted here — legacy flat-format normalization now happens once, in
the CLI's initial import (Task 14), which gets its own test there, not on
every `GET /api/.../rules`. `TestLintEndpoint`'s two subtests that used
to `store.WriteRules(...)` to inject rules content mid-test now write
through `projects.WriteDraft` directly (the one place bypassing the
`PUT` handler's own validation is legitimate — it simulates "already
persisted", the same intent the original test had).

```go
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/lint"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

const fixtureTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const fixtureSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
`

const fixtureRules = `
defaultAction: deny
rules:
  - {name: office-to-dmz, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// mustParseFixtureDoc builds the ProjectDoc newTestServer seeds as
// version 1, from the same YAML fixtures the file used to write directly
// to disk.
func mustParseFixtureDoc(t *testing.T) projectdoc.ProjectDoc {
	t.Helper()
	var doc projectdoc.ProjectDoc
	if err := yaml.Unmarshal([]byte(fixtureTopology), &doc.Topology); err != nil {
		t.Fatalf("parse fixture topology: %v", err)
	}
	if err := yaml.Unmarshal([]byte(fixtureSubnets), &doc.Subnets); err != nil {
		t.Fatalf("parse fixture subnets: %v", err)
	}
	pol, err := rules.Load(strings.NewReader(fixtureRules))
	if err != nil {
		t.Fatalf("parse fixture rules: %v", err)
	}
	doc.Rules = NewPolicyDoc(pol)
	return doc
}

// newTestServer seeds version 1 from the fixtures above and opens one
// draft ("test-draft") on top of it, owned by the bootstrapped admin.
// Returns the authenticated handler, the pgstore.Store for tests that
// need to inspect persisted state directly, and the draft's id.
func newTestServer(t *testing.T) (http.Handler, *pgstore.Store, string) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	ctx := context.Background()
	if err := users.BootstrapAdmin(ctx, "admin", "test-password-1"); err != nil {
		t.Fatalf("bootstrap admin: %v", err)
	}
	admin, err := users.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatalf("get admin: %v", err)
	}

	projects := pgstore.NewStore(pool)
	if _, err := projects.SeedInitialVersion(ctx, mustParseFixtureDoc(t), admin); err != nil {
		t.Fatalf("seed initial version: %v", err)
	}
	draft, err := projects.CreateDraft(ctx, admin, "test-draft")
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}

	srv := NewServer(projects, users, discardLogger())
	return authenticatedHandler(t, srv), projects, draft.ID
}

// authenticatedHandler logs in once and returns a handler that stamps
// every incoming test request with that session cookie first, so tests
// that build requests directly and call srv.ServeHTTP need no changes to
// stay authenticated.
func authenticatedHandler(t *testing.T, srv http.Handler) http.Handler {
	t.Helper()
	body, err := json.Marshal(loginRequest{Username: "admin", Password: "test-password-1"})
	if err != nil {
		t.Fatalf("marshal login body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("test login failed: status %d, body %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("test login did not set a session cookie")
	}
	sessionCookie := cookies[0]

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(sessionCookie)
		srv.ServeHTTP(w, r)
	})
}

// errorBody decodes the {"error": ...} envelope into the raw message.
func errorBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return out.Error
}

// draftPath builds a /api/drafts/{id}/... URL.
func draftPath(draftID, suffix string) string {
	return "/api/drafts/" + draftID + "/" + suffix
}

// readDraftDoc fetches a draft's current document straight from the
// store, bypassing HTTP — used where a test used to inspect the file
// store directly.
func readDraftDoc(t *testing.T, projects *pgstore.Store, draftID string) projectdoc.ProjectDoc {
	t.Helper()
	doc, _, err := projects.ReadDraft(context.Background(), draftID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	return doc
}

func marshalJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// doJSON issues a request with an optional JSON body against h. A PUT to
// a /api/drafts/{id}/... path first GETs that same path to pick up the
// fresh X-Draft-Revision, so individual tests never have to manage CAS
// revisions themselves.
func doJSON(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var revision string
	if method == http.MethodPut && strings.Contains(path, "/api/drafts/") {
		getRec := httptest.NewRecorder()
		h.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, path, nil))
		revision = getRec.Result().Header.Get("X-Draft-Revision")
	}

	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	if revision != "" {
		req.Header.Set("X-Draft-Revision", revision)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGetTopology(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var doc TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(doc.Devices) != 2 || len(doc.Networks) != 2 {
		t.Fatalf("unexpected doc: %+v", doc)
	}
}

func TestGetPutSubnets(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "subnets"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var doc SubnetsDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(doc.Subnets) != 2 {
		t.Fatalf("unexpected subnets: %+v", doc)
	}

	doc.Subnets = append(doc.Subnets, SubnetDoc{Name: "guest", CIDR: "10.0.2.0/24"})
	rec = doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestGetPutTopologyWithUnions(t *testing.T) {
	h, projects, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body)
	}
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Unions) != 0 {
		t.Fatalf("expected empty unions on fixture, got %+v", got.Unions)
	}

	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links:    []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		Networks: []NetworkDoc{{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}}},
		Sets:     []SetDoc{},
		Unions:   []UnionDoc{{Name: "office", Devices: []string{"r1", "r2"}, Networks: []string{"n-office"}, Description: "hq"}},
	}
	rec = doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	stored := readDraftDoc(t, projects, draftID).Topology
	if len(stored.Unions) != 1 || stored.Unions[0].Name != "office" || len(stored.Unions[0].Devices) != 2 {
		t.Fatalf("unexpected stored unions: %+v", stored.Unions)
	}

	// битая ссылка отклоняется
	doc.Unions[0].Devices = []string{"ghost"}
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown union member: status = %d, body = %s", rec.Code, rec.Body)
	}

	// двойное членство отклоняется
	doc.Unions[0].Devices = []string{"r1"}
	doc.Unions = append(doc.Unions, UnionDoc{Name: "second", Devices: []string{"r1"}})
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("double membership: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestDeletionGuardBlocksDeviceInUnion(t *testing.T) {
	h, _, draftID := newTestServer(t)
	base := func(devices []DeviceDoc, unions []UnionDoc) TopologyDoc {
		return TopologyDoc{
			Devices: devices,
			Links:   []LinkDoc{},
			Networks: []NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
			},
			Sets:   []SetDoc{},
			Unions: unions,
		}
	}
	all := base(
		[]DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}, {Name: "r3", Kind: "router"}},
		[]UnionDoc{{Name: "office", Devices: []string{"r3"}}},
	)
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), all); rec.Code != http.StatusOK {
		t.Fatalf("seed status = %d, body = %s", rec.Code, rec.Body)
	}
	// r3 ссылается только сайт — удаление блокируется с 409
	shrink := base(all.Devices[:2], []UnionDoc{{Name: "office", Devices: []string{"r3"}}})
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), shrink)
	if rec.Code != http.StatusConflict {
		t.Fatalf("device in union: status = %d, body = %s", rec.Code, rec.Body)
	}
	if msg := errorBody(t, rec); !strings.Contains(msg, `union "office"`) {
		t.Fatalf("want union dependency in error, got %s", msg)
	}
}

func TestPutSubnets_DescriptionRoundTrip(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24", Description: "офисный сегмент"},
		{Name: "dmz", CIDR: "10.0.1.0/24"},
	}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "subnets"), nil)
	var got SubnetsDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Subnets[0].Description != "офисный сегмент" {
		t.Fatalf("description lost: %+v", got.Subnets[0])
	}
	if got.Subnets[1].Description != "" {
		t.Fatalf("unexpected description: %+v", got.Subnets[1])
	}
}

func TestPutSubnets_RejectsOverlap(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24"},
		{Name: "dmz", CIDR: "10.0.0.128/25"},
	}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutSubnets_RejectsDeletingUsedSubnet(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Subnets)
	doc := SubnetsDoc{Subnets: []SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 (dmz still referenced), got status = %d, body = %s", rec.Code, rec.Body)
	}
	msg := errorBody(t, rec)
	for _, want := range []string{`subnet "dmz"`, `network "n-dmz"`, `rule "office-to-dmz"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q must mention %s", msg, want)
		}
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Subnets)
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected document must not be persisted")
	}
}

func TestPutSubnets_AllowsDeletingUnusedSubnet(t *testing.T) {
	h, _, draftID := newTestServer(t)
	withGuest := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24"},
		{Name: "dmz", CIDR: "10.0.1.0/24"},
		{Name: "guest", CIDR: "10.0.2.0/24"},
	}}
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), withGuest); rec.Code != http.StatusOK {
		t.Fatalf("add guest: status = %d, body = %s", rec.Code, rec.Body)
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), SubnetsDoc{Subnets: withGuest.Subnets[:2]})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete guest: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_RejectsDeletingUsedDevice(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r2", Kind: "router"}}, // r1 removed, its link/attach kept
		Links:   []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 (r1 still referenced), got status = %d, body = %s", rec.Code, rec.Body)
	}
	msg := errorBody(t, rec)
	for _, want := range []string{`device "r1"`, `link[0]`, `network "n-office"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q must mention %s", msg, want)
		}
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected document must not be persisted")
	}
}

func TestPutTopology_AllowsDeletingFreeDevice(t *testing.T) {
	h, _, draftID := newTestServer(t)
	base := func(devices []DeviceDoc) TopologyDoc {
		return TopologyDoc{
			Devices: devices,
			Links:   []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
			Networks: []NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
			},
		}
	}
	all := append([]DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}}, DeviceDoc{Name: "sw1", Kind: "switch"})
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), base(all)); rec.Code != http.StatusOK {
		t.Fatalf("add sw1: status = %d, body = %s", rec.Code, rec.Body)
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), base(all[:2]))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete sw1: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_RejectsUnknownSubnetInNetwork(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:    []LinkDoc{},
		Networks: []NetworkDoc{{Name: "n1", Subnets: []string{"ghost"}}},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_Valid(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	stored := readDraftDoc(t, projects, draftID).Topology
	found := false
	for _, d := range stored.Devices {
		if d.Name == "r1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stored topology missing device r1: %+v", stored.Devices)
	}
}

func TestPutTopology_RejectsSelfLoopLink(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)

	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links: []LinkDoc{
			{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r1"}},
		},
		Networks: []NetworkDoc{},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusBadRequest {
		t.Fatalf("expected rejection, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid topology must not be persisted")
	}
}

func TestPutTopology_SetRoundTrip(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
		},
		Sets: []SetDoc{
			{Name: "blocked", Subnets: []string{"office"}, Addresses: []string{"10.0.0.9"}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	stored := readDraftDoc(t, projects, draftID).Topology
	if len(stored.Sets) != 1 || stored.Sets[0].Name != "blocked" || len(stored.Sets[0].Addresses) != 1 || stored.Sets[0].Addresses[0] != "10.0.0.9" {
		t.Fatalf("stored sets = %+v", stored.Sets)
	}
}

func TestPutTopology_DescriptionRoundTrip(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}, Description: "офисная сеть"},
		},
		Sets: []SetDoc{{Name: "blocked", Subnets: []string{"office"}, Description: "блоклист"}},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	stored := readDraftDoc(t, projects, draftID).Topology
	if stored.Networks[0].Description != "офисная сеть" {
		t.Fatalf("network description lost: %+v", stored.Networks[0])
	}
	if stored.Sets[0].Description != "блоклист" {
		t.Fatalf("set description lost: %+v", stored.Sets[0])
	}

	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Networks[0].Description != "офисная сеть" || got.Sets[0].Description != "блоклист" {
		t.Fatalf("descriptions lost over GET: %+v %+v", got.Networks[0], got.Sets[0])
	}
}

func TestPutTopology_RejectsSetAddressOutsideSubnets(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:    []LinkDoc{},
		Networks: []NetworkDoc{{Name: "n1", Subnets: []string{"office"}}},
		Sets:     []SetDoc{{Name: "bad", Addresses: []string{"192.168.5.5"}}},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutRules_RejectsUnknownEndpoint(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)

	doc := PolicyDoc{Chains: []ChainDoc{{
		DefaultAction: "deny",
		Rules: []RuleDoc{
			{Name: "bad", Src: []string{"office"}, Dst: []string{"does-not-exist"}, Action: "allow"},
		},
	}}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "rules"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}

func TestPutRules_RejectsUnknownJumpTarget(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)
	doc := PolicyDoc{Chains: []ChainDoc{{
		Name: "FIRENET-FWD", DefaultAction: "deny",
		Rules: []RuleDoc{{Name: "r", Src: []string{"any"}, Dst: []string{"any"}, Action: "jump", JumpTo: "GHOST"}},
	}}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "rules"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422", rec.Code)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}

func TestValidateEndpoint(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "validate"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var out struct {
		Valid  bool     `json:"valid"`
		Errors []string `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.Valid {
		t.Fatalf("expected valid fixture, got errors: %v", out.Errors)
	}
}

func TestCompileEndpoint(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "compile"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var devices []struct {
		Name         string
		IPSetsScript string
		RulesScript  string
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &devices); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(devices))
	}
	for _, d := range devices {
		if d.RulesScript == "" || d.IPSetsScript == "" {
			t.Fatalf("%s: empty scripts", d.Name)
		}
	}
}

func TestLayoutRoundTrip(t *testing.T) {
	h, _, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "layout"), nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "{}" {
		t.Fatalf("expected empty layout, got status = %d, body = %s", rec.Code, rec.Body)
	}

	layout := map[string]any{"devices": map[string]any{"r1": map[string]float64{"x": 1, "y": 2}}}
	rec = doJSON(t, h, http.MethodPut, draftPath(draftID, "layout"), layout)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "layout"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"r1"`)) {
		t.Fatalf("layout not persisted: %s", rec.Body)
	}
}

func TestPutTopology_LinkFilterRoundTrip(t *testing.T) {
	h, _, draftID := newTestServer(t)

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
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc); rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	if got.Links[0].Filter == nil ||
		!slices.Equal(got.Links[0].Filter.AExports, []string{"n-office"}) ||
		!slices.Equal(got.Links[0].Filter.BExports, []string{"n-dmz"}) {
		t.Fatalf("filter did not survive round-trip: %+v", got.Links[0])
	}
}

func TestPutTopology_RejectsFilteredLinkWithSwitch(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}, {Name: "sw", Kind: "switch"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "sw"},
			Filter: &LinkFilterDoc{AExports: []string{"n-office"}, BExports: []string{"n-dmz"}},
		}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	res := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "two routers") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestPutTopology_RejectsUnknownExport(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"ghost"}, BExports: []string{"n2"}},
		}},
	}
	res := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "unknown export entity") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestGetLinkExports(t *testing.T) {
	h, _, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?link=0&side=a"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var got struct {
		Entities []EntityDoc `json:"entities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// The edited link itself is excluded from the graph: from r1 only its
	// own network stays in reach.
	want := []EntityDoc{{Name: "n-office"}, {Name: "office", CIDR: "10.0.0.0/24"}}
	if !slices.EqualFunc(got.Entities, want, func(a, b EntityDoc) bool { return a == b }) {
		t.Fatalf("entities = %+v, want %+v", got.Entities, want)
	}

	for _, q := range []string{"link=0&side=c", "link=x&side=a", "link=-1&side=a"} {
		if rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?"+q), nil); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: want 422, got %d", q, rec.Code)
		}
	}
	if rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?link=7&side=a"), nil); rec.Code != http.StatusNotFound {
		t.Fatalf("out-of-range link: want 404, got %d", rec.Code)
	}
}

func TestDiagnoseHandler(t *testing.T) {
	h, _, draftID := newTestServer(t)
	diagnosePath := draftPath(draftID, "diagnose")

	t.Run("allowed flow reports matched rule", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"443"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var rep diagnose.Report
		if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" || len(rep.Paths) != 1 {
			t.Fatalf("unexpected report: %+v", rep)
		}
		if rep.Paths[0].Verdict != rules.ActionAllow || rep.Paths[0].Routers[0].MatchedRule != "office-to-dmz" {
			t.Fatalf("unexpected verdict: %+v", rep.Paths[0])
		}
		if !strings.Contains(rec.Body.String(), `"kind":1,"name":"office"`) {
			t.Fatalf("path nodes must serialize with lowercase keys, got %s", rec.Body.String())
		}
	})

	t.Run("invalid IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath, map[string]any{"src": "nonsense", "dst": "10.0.1.7"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "src") {
			t.Fatalf("error should mention src, got %q", msg)
		}
	})

	t.Run("unknown IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath, map[string]any{"src": "10.0.0.5", "dst": "192.168.99.99"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "не принадлежит") {
			t.Fatalf("error should explain unknown IP, got %q", msg)
		}
	})

	t.Run("bad proto is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath, map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "sctp"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
	})

	t.Run("invalid port string is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"abc"}})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, `"abc"`) {
			t.Fatalf("error should mention the bad port, got %q", msg)
		}
	})

	t.Run("inverted port range is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "srcPorts": []string{"2000:1000"}})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("valid port range passes validation", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"443", "1024:65535"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}

// writeDraftRules bypasses the PUT handler's own validation, going
// straight through pgstore — used to simulate rules content that
// somehow already made it into storage without passing normal checks.
func writeDraftRules(t *testing.T, projects *pgstore.Store, draftID string, rawYAML string) {
	t.Helper()
	ctx := context.Background()
	var policy projectdoc.PolicyDoc
	if err := yaml.Unmarshal([]byte(rawYAML), &policy); err != nil {
		t.Fatalf("parse rules yaml: %v", err)
	}
	doc, revision, err := projects.ReadDraft(ctx, draftID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	doc.Rules = policy
	if _, err := projects.WriteDraft(ctx, draftID, doc, revision); err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}
}

func TestLintEndpoint(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	lintPath := draftPath(draftID, "lint")

	t.Run("clean policy has no findings", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodGet, lintPath, nil)
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
		writeDraftRules(t, projects, draftID, `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: allow-all, comment: "broad by design", src: [any], dst: [any], proto: any, action: allow}
      - {name: shadowed, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: deny}
`)
		rec := doJSON(t, h, http.MethodGet, lintPath, nil)
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
		writeDraftRules(t, projects, draftID, `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: bad, src: [no-such-subnet], dst: [any], proto: any, action: allow}
`)
		rec := doJSON(t, h, http.MethodGet, lintPath, nil)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}
```

- [ ] **Step 4.5: Fix `auth_handlers_test.go`'s own test-server helper**

`internal/httpapi/auth_handlers_test.go` (from the auth-foundation plan)
has its own server constructor, `newUnauthenticatedTestServer`, built on
the now-gone `FileProjectStore`/`EnsureSeeded`/old-`NewServer` combo —
not in this task's file list because it predates `pgstore` entirely.
Replace it:
```go
func newUnauthenticatedTestServer(t *testing.T) (http.Handler, *auth.Store) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	ctx := context.Background()
	if err := users.BootstrapAdmin(ctx, "admin", "test-password-1"); err != nil {
		t.Fatalf("bootstrap admin: %v", err)
	}
	admin, err := users.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatalf("get admin: %v", err)
	}

	projects := pgstore.NewStore(pool)
	if _, err := projects.SeedInitialVersion(ctx, projectdoc.ProjectDoc{}, admin); err != nil {
		t.Fatalf("seed initial version: %v", err)
	}

	return NewServer(projects, users, discardLogger()), users
}
```
Add `"github.com/kudes1/firenet/internal/pgstore"` and
`"github.com/kudes1/firenet/internal/projectdoc"` to this file's import
block; remove `"path/filepath"` — it was only used to build the deleted
`FileProjectStore` paths.

Two tests in this file also hit the now-gone bare `/api/topology`
route — `TestProtectedRouteWithoutSessionIs401` and
`TestLogoutClearsSession`. In both, change:
```go
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/topology", nil))
```
and
```go
	req2 := httptest.NewRequest(http.MethodGet, "/api/topology", nil)
```
to `"/api/versions/current/topology"` — any protected route works for
"was this request rejected before reaching a handler"; this is just the
nearest equivalent of the route that used to exist.

Run: `FIRENET_TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable go test ./internal/httpapi/... -run 'TestLogin|TestProtected|TestLogout|TestCreateAndListUsers|TestCreateUserAsNonAdmin|TestDeleteUser|TestDeleteLastAdmin' -v`
Expected: `PASS` for all of them.

- [ ] **Step 5: Fix `server_test.go`'s call to `newTestServer`**

`internal/httpapi/server_test.go`'s `TestStaticAssetsNoCache` calls
`srv, _ := newTestServer(t)` — `newTestServer` now returns three values.
Change that line to:
```go
	srv, _, _ := newTestServer(t)
```

- [ ] **Step 6: Run the full `internal/httpapi` test suite**

Run: `FIRENET_TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable go test ./internal/httpapi/... -v 2>&1 | tail -100`
Expected: `PASS` for every test — every rewritten `handlers_test.go` test,
every test in `auth_handlers_test.go` (unaffected by this task), and
`TestStaticAssetsNoCache`.

- [ ] **Step 7: Full module build/vet/format check**

Run: `go build ./... 2>&1` — expect exactly one remaining error, in
`internal/cli/serve.go` (still calling the old `httpapi.NewServer(store,
users, log)` three-arg form with a `FileProjectStore`) — Task 14 fixes
it next. Everything else must build clean:
```bash
go vet ./internal/pgstore/... ./internal/projectdoc/... ./internal/httpapi/...
gofmt -l internal/pgstore internal/projectdoc internal/httpapi
```
Expected: no output from either command.

- [ ] **Step 8: Commit**

```bash
git add internal/httpapi/server.go internal/httpapi/compile_ui.go internal/httpapi/handlers_test.go internal/httpapi/auth_handlers_test.go internal/httpapi/server_test.go
git commit -m "feat(httpapi): rewrite routing around drafts/versions, overhaul handler tests"
```

---

### Task 14: Wire the initial-version import into `firenet serve`

**Files:**
- Create: `internal/cli/legacy.go`
- Create: `internal/cli/legacy_test.go`
- Modify: `internal/cli/serve.go`

**Interfaces:**
- Consumes: `httpapi.FileProjectStore` (unchanged, still exported from `internal/httpapi/store.go`), `pgstore.Store.SeedInitialVersion` (Task 8), `httpapi.NewServer(projects, users, log)` (Task 13).
- Produces: `loadLegacyProjectDoc(store httpapi.FileProjectStore) (projectdoc.ProjectDoc, error)`.

This closes the loop the spec's "Миграция существующих данных" section
describes: on a project that already has `topology.yaml`/etc. on disk
from before this feature, `firenet serve`'s first run against a fresh
database imports them as version 1; a brand-new project gets the same
empty-but-valid defaults `EnsureSeeded` used to write to disk.

`TestGetRulesNormalizesLegacyFile` (deleted in Task 13) tested that a
legacy flat-format `rules.yaml` (no `chains:` key) got normalized on
read. That concern lives here now — the only remaining path that reads
a raw `rules.yaml` off disk — so its coverage moves here too.

- [ ] **Step 1: Write the failing test**

`internal/cli/legacy_test.go`:
```go
package cli

import (
	"path/filepath"
	"testing"

	"github.com/kudes1/firenet/internal/httpapi"
)

func testLegacyStore(t *testing.T) httpapi.FileProjectStore {
	t.Helper()
	dir := t.TempDir()
	return httpapi.FileProjectStore{
		TopologyPath: filepath.Join(dir, "topology.yaml"),
		SubnetsPath:  filepath.Join(dir, "subnets.yaml"),
		RulesPath:    filepath.Join(dir, "rules.yaml"),
		LayoutPath:   filepath.Join(dir, ".firenet-layout.json"),
	}
}

func TestLoadLegacyProjectDocMissingFilesYieldsDefaults(t *testing.T) {
	doc, err := loadLegacyProjectDoc(testLegacyStore(t))
	if err != nil {
		t.Fatalf("loadLegacyProjectDoc: %v", err)
	}
	if len(doc.Topology.Devices) != 0 || len(doc.Subnets.Subnets) != 0 {
		t.Fatalf("expected empty topology/subnets, got %+v / %+v", doc.Topology, doc.Subnets)
	}
	if len(doc.Rules.Chains) != 1 || doc.Rules.Chains[0].DefaultAction != "deny" {
		t.Fatalf("expected one default-deny chain, got %+v", doc.Rules.Chains)
	}
}

func TestLoadLegacyProjectDocReadsExistingFiles(t *testing.T) {
	store := testLegacyStore(t)
	if err := store.WriteTopology([]byte("devices:\n  - {name: r1, kind: router}\nlinks: []\nnetworks: []\nsets: []\nunions: []\n")); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteSubnets([]byte("subnets:\n  - {name: office, cidr: 10.0.0.0/24}\n")); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteRules([]byte("defaultAction: deny\nrules: []\n")); err != nil {
		t.Fatal(err)
	}

	doc, err := loadLegacyProjectDoc(store)
	if err != nil {
		t.Fatalf("loadLegacyProjectDoc: %v", err)
	}
	if len(doc.Topology.Devices) != 1 || doc.Topology.Devices[0].Name != "r1" {
		t.Fatalf("got devices %+v", doc.Topology.Devices)
	}
	if len(doc.Subnets.Subnets) != 1 || doc.Subnets.Subnets[0].Name != "office" {
		t.Fatalf("got subnets %+v", doc.Subnets.Subnets)
	}
}

func TestLoadLegacyProjectDocNormalizesFlatRulesFile(t *testing.T) {
	store := testLegacyStore(t)
	if err := store.WriteRules([]byte("defaultAction: deny\nchainName: OLD\nrules: []\n")); err != nil {
		t.Fatal(err)
	}

	doc, err := loadLegacyProjectDoc(store)
	if err != nil {
		t.Fatalf("loadLegacyProjectDoc: %v", err)
	}
	if len(doc.Rules.Chains) != 1 || doc.Rules.Chains[0].Name != "OLD" {
		t.Fatalf("legacy flat rules file not normalized: %+v", doc.Rules.Chains)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/cli/...`
Expected: FAIL — `loadLegacyProjectDoc` undefined.

- [ ] **Step 3: Write `internal/cli/legacy.go`**

```go
package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/httpapi"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

// loadLegacyProjectDoc reads whatever topology.yaml/subnets.yaml/rules.yaml
// a pre-multiuser project left on disk, for the one-time import into
// version 1 (internal/pgstore.Store.SeedInitialVersion). A missing file
// yields the same empty-but-valid default httpapi.FileProjectStore.
// EnsureSeeded used to write for a brand-new project — layout has no
// such fallback to preserve: an empty projectdoc.LayoutDoc already
// serializes to "no layout yet", matching the old GET /api/layout
// behavior for a fresh project.
func loadLegacyProjectDoc(store httpapi.FileProjectStore) (projectdoc.ProjectDoc, error) {
	var doc projectdoc.ProjectDoc

	if raw, err := store.ReadTopology(); err == nil {
		if err := yaml.Unmarshal(raw, &doc.Topology); err != nil {
			return doc, fmt.Errorf("parse legacy topology: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return doc, fmt.Errorf("read legacy topology: %w", err)
	}

	if raw, err := store.ReadSubnets(); err == nil {
		if err := yaml.Unmarshal(raw, &doc.Subnets); err != nil {
			return doc, fmt.Errorf("parse legacy subnets: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return doc, fmt.Errorf("read legacy subnets: %w", err)
	}

	if raw, err := store.ReadRules(); err == nil {
		pol, err := rules.Load(bytes.NewReader(raw))
		if err != nil {
			return doc, fmt.Errorf("parse legacy rules: %w", err)
		}
		doc.Rules = projectdoc.NewPolicyDoc(pol)
	} else if os.IsNotExist(err) {
		doc.Rules = defaultPolicyDoc()
	} else {
		return doc, fmt.Errorf("read legacy rules: %w", err)
	}

	if raw, err := store.ReadLayout(); err == nil && len(raw) > 0 {
		// .firenet-layout.json is genuinely JSON (unlike the other three
		// files), matching how the old getLayout/putLayout handled it.
		if err := json.Unmarshal(raw, &doc.Layout); err != nil {
			return doc, fmt.Errorf("parse legacy layout: %w", err)
		}
	} else if err != nil {
		return doc, fmt.Errorf("read legacy layout: %w", err)
	}

	return doc, nil
}

func defaultPolicyDoc() projectdoc.PolicyDoc {
	return projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
		Name:          rules.DefaultChainName,
		DefaultAction: "deny",
		ChainPosition: string(rules.ChainTop),
		Rules:         []projectdoc.RuleDoc{},
	}}}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/cli/... -v`
Expected: `PASS` for all three tests.

- [ ] **Step 5: Rewrite `internal/cli/serve.go`**

```go
package cli

import (
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/config"
	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/httpapi"
	"github.com/kudes1/firenet/internal/pgstore"
)

func newServeCmd() *cobra.Command {
	var topologyPath, subnetsPath, rulesPath, addr string
	var openBrowser bool

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Serve a local web UI for building topology, editing rules and compiling",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			log := loggerFromContext(ctx)

			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if cfg.DatabaseURL == "" {
				return fmt.Errorf("FIRENET_DATABASE_URL is required")
			}

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

			legacyStore := httpapi.FileProjectStore{
				TopologyPath: topologyPath,
				SubnetsPath:  subnetsPath,
				RulesPath:    rulesPath,
				LayoutPath:   filepath.Join(filepath.Dir(topologyPath), ".firenet-layout.json"),
			}
			legacyDoc, err := loadLegacyProjectDoc(legacyStore)
			if err != nil {
				return fmt.Errorf("read legacy project files: %w", err)
			}

			projects := pgstore.NewStore(pool)
			if _, err := projects.SeedInitialVersion(ctx, legacyDoc, actor); err != nil {
				return fmt.Errorf("seed initial version: %w", err)
			}

			srv := httpapi.NewServer(projects, users, log)
			log.Info("serving firenet web UI", "addr", addr)

			if openBrowser {
				go openURL("http://" + addr)
			}
			return http.ListenAndServe(addr, srv)
		},
	}

	cmd.Flags().StringVar(&topologyPath, "topology", "topology.yaml", "path to a legacy topology YAML file to import on first run")
	cmd.Flags().StringVar(&subnetsPath, "subnets", "subnets.yaml", "path to a legacy subnets YAML file to import on first run")
	cmd.Flags().StringVar(&rulesPath, "rules", "rules.yaml", "path to a legacy rules YAML file to import on first run")
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address to listen on")
	cmd.Flags().BoolVar(&openBrowser, "open", false, "open the UI in a browser on start")

	return cmd
}

// openURL best-effort launches the OS default browser; failures are silent
// since this is a convenience, not a requirement.
func openURL(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
```

The `--topology`/`--subnets`/`--rules` flags' meaning changes here: they
used to name the files `serve` reads and writes on every request; now
they only matter once, for the first-run import, and their help text
says so.

- [ ] **Step 6: Delete the now-dead `EnsureSeeded` from `internal/httpapi/store.go`**

`EnsureSeeded` (and the private helpers only it used —
`emptyTopologyYAML`, `emptySubnetsYAML`, `emptyPolicyYAML`,
`seedIfMissing`) had exactly one caller, `serve.go`'s old
`store.EnsureSeeded()` line, which Step 5 replaced with
`loadLegacyProjectDoc`'s inline fallback-to-defaults logic. Delete all
five from `internal/httpapi/store.go` (roughly lines 55-114 — the block
from the `EnsureSeeded` doc comment through the end of `seedIfMissing`,
stopping right before the `writeFileAtomic` doc comment). Leave
`FileProjectStore`'s `Read*`/`Write*` methods and `writeFileAtomic`
itself in place — `Read*` is `loadLegacyProjectDoc`'s only dependency,
and `Write*` is still used by `internal/cli/legacy_test.go` (this
task's Step 1) to set up on-disk fixtures.

Run: `go build ./... 2>&1 | grep -i "declared and not used\|store.go"`
Expected: no output (confirms nothing else referenced the deleted
functions).

- [ ] **Step 7: Full module build**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: builds clean, no vet/format issues — this is the point where
every package in the module compiles together for the first time since
Task 9 started.

- [ ] **Step 8: Manually verify `serve` imports a legacy project on first run**

```bash
mkdir -p /tmp/firenet-legacy-import
cat > /tmp/firenet-legacy-import/topology.yaml <<'EOF'
devices:
  - {name: r1, kind: router}
links: []
networks: []
sets: []
unions: []
EOF
cat > /tmp/firenet-legacy-import/subnets.yaml <<'EOF'
subnets: []
EOF
cat > /tmp/firenet-legacy-import/rules.yaml <<'EOF'
defaultAction: deny
rules: []
EOF
```
Then, with a **fresh** test database (drop and recreate `firenet_test`,
or point `FIRENET_DATABASE_URL` at a new one — reusing the one from
earlier tasks would skip the import, since `SeedInitialVersion` is a
no-op once any version exists):
```bash
export FIRENET_DATABASE_URL="postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable"
export FIRENET_ADMIN_USER=admin
export FIRENET_ADMIN_PASSWORD=change-me-1234
go run ./cmd/firenet serve \
  --topology /tmp/firenet-legacy-import/topology.yaml \
  --subnets /tmp/firenet-legacy-import/subnets.yaml \
  --rules /tmp/firenet-legacy-import/rules.yaml \
  --addr 127.0.0.1:8789 &
sleep 3
curl -s -c /tmp/firenet-cookie -X POST http://127.0.0.1:8789/api/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"change-me-1234"}' >/dev/null
curl -s -b /tmp/firenet-cookie http://127.0.0.1:8789/api/versions/current/topology
```
Expected: the last command prints JSON containing `"name":"r1"` — the
legacy device imported as version 1. Stop the server afterward (find its
PID with `ss -ltnp | grep 8789` and `kill` it, as in the Task 9-era
manual checks).

- [ ] **Step 9: Commit**

```bash
git add internal/cli/legacy.go internal/cli/legacy_test.go internal/cli/serve.go internal/httpapi/store.go
git commit -m "feat(cli): import a legacy project as version 1 on first serve"
```

---

### Task 15: Final full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Full Go test suite, with a fresh test database**

The advisory-lock serialization from the auth-foundation plan's
`dbtest` fix (and the migration-tracking `schema_migrations` table)
mean this is safe to run repeatedly against the same running Postgres
container from earlier tasks:
```bash
export FIRENET_TEST_DATABASE_URL="postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable"
go build ./... && go vet ./... && gofmt -l . && go test ./... -count=1
```
Expected: builds clean, no vet/format issues, every package `PASS` —
`internal/projectdoc`, `internal/pgstore`, `internal/httpapi`,
`internal/cli`, plus every already-passing package from before this
plan (`internal/auth`, `internal/db`, `internal/app`, `internal/rules`,
`internal/topology`, `internal/compiler`, `internal/graph`,
`internal/diagnose`, `internal/lint`, `internal/render`).

- [ ] **Step 2: Full Go test suite with no test database configured**

```bash
unset FIRENET_TEST_DATABASE_URL
go test ./...
```
Expected: still all `ok` — every Postgres-backed test skips cleanly
(the same guarantee `dbtest.Open` gave the auth-foundation plan).

- [ ] **Step 3: Full JS test suite**

```bash
node --test internal/httpapi/web/*.test.js
```
Expected: all tests pass — this plan didn't touch `internal/httpapi/web`,
so this just confirms nothing there silently broke.

- [ ] **Step 4: End-to-end manual smoke test against a fresh database**

```bash
export FIRENET_DATABASE_URL="postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable"
export FIRENET_ADMIN_USER=admin
export FIRENET_ADMIN_PASSWORD=change-me-1234
go run ./cmd/firenet serve --addr 127.0.0.1:8790 &
sleep 3

# Login, open a draft, edit topology, confirm it.
curl -s -c /tmp/firenet-e2e-cookie -X POST http://127.0.0.1:8790/api/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"change-me-1234"}' >/dev/null
DRAFT_ID=$(curl -s -b /tmp/firenet-e2e-cookie -X POST http://127.0.0.1:8790/api/drafts \
  -H 'Content-Type: application/json' -d '{"name":"smoke-test"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "draft: $DRAFT_ID"
curl -s -b /tmp/firenet-e2e-cookie -X PUT "http://127.0.0.1:8790/api/drafts/$DRAFT_ID/topology" \
  -H 'Content-Type: application/json' \
  -d '{"devices":[{"name":"r1","kind":"router"}],"links":[],"networks":[],"sets":[],"unions":[]}'
echo
curl -s -b /tmp/firenet-e2e-cookie -X POST "http://127.0.0.1:8790/api/drafts/$DRAFT_ID/confirm"
echo
curl -s -b /tmp/firenet-e2e-cookie http://127.0.0.1:8790/api/versions/current/topology
```
Expected: the draft creation returns a JSON object with an `id`; the
`PUT` returns `200` with the topology echoed back; `confirm` returns
`{"version":2}` (version 1 is the empty seed, version 2 is this
confirm); the final `GET .../current/topology` shows `"name":"r1"` —
proof the confirmed data is now visible outside the draft. Then stop the
server (`ss -ltnp | grep 8790`, `kill <pid>`).

- [ ] **Step 5: Update the plan's own status note** (no code change — just
confirms the plan is complete; nothing to commit for this step beyond
what Steps 1-4 already verified)

## Self-Review Notes

- **Spec coverage:** "Модель данных" (`versions`/`entity_changes`/
  `drafts`/`draft_entity_changes`) — Task 3. `internal/pgstore`'s full
  method list from the spec — Tasks 5-8 (all present:
  `CurrentVersion`, `ReadAt`, `History`, `DiffVersions`, `Restore`,
  `CreateDraft`, `ListDrafts`, `ReadDraft`, `WriteDraft`, `DeleteDraft`,
  `DiffDraft`, `Conflicts`, `Confirm`). "Request-флоу" — every route
  (`GET .../current/...`, `POST /api/drafts`, `GET/PUT
  /api/drafts/{id}/...`, `GET /api/drafts/{id}/diff`, `POST
  /api/drafts/{id}/confirm`, `GET /api/versions`, `GET
  /api/versions/diff`, `POST /api/versions/{n}/restore`) — Task 13's
  `server.go`. "Права и ошибки" table — `resolveDraftForAccess`/
  `canAccessDraft` (owner-or-admin) plus `auth.RequireAdmin` on
  confirm/restore/users (Task 9, Task 13). "Миграция существующих
  данных" — Task 14. The **Web UI** bullet in "Архитектура" (draft/
  version switcher, diff/conflict screens, history page) is explicitly
  out of scope here — that's the separate UI plan the three-plan split
  already called out.
- **Placeholder scan:** no TODO/TBD; every step has real code or a
  runnable command with a concrete expected result, including the two
  places an earlier draft of this plan had a placeholder that got fixed
  inline during writing (Task 6's stray test leftover).
- **Type consistency:** `pgstore.Store` method signatures introduced in
  Tasks 5-8 are used with those exact signatures in Tasks 9-13's
  `httpapi` handlers and Task 14's `serve.go` (`CurrentVersion() (int64,
  error)`, `ReadAt(int64) (projectdoc.ProjectDoc, error)`,
  `CreateDraft(User, string) (Draft, error)`, etc.). `projectdoc.ProjectDoc`
  and its nested types, introduced in Task 1, are the same types
  `pgstore` (Task 2 onward) and `httpapi` (Task 9 onward, via the
  `dto.go` aliases) both operate on — no duplicate/divergent
  definitions anywhere. `entityRef`/`entityRow` (Task 2) are used
  identically by every `pgstore` file that touches storage (Tasks 3-8).
  `Draft.Owner`/`Status`/`Revision`/`BaseVersionID` (Task 6) are the
  exact fields `canAccessDraft`/`resolveDraftForAccess` (Task 9) and
  `toDraftResponse` (Task 11) read.
