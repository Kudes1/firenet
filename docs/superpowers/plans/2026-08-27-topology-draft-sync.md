# Topology Draft Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the topology editor mutate the server draft operation-by-operation, eliminating divergence between the canvas and server-derived data.

**Architecture:** A draft-scoped operation endpoint applies one topology or layout command under the existing revision CAS and returns a canonical editor snapshot. A browser queue projects pending commands over the last confirmed snapshot and serializes requests; the canvas reads that projection only.

**Tech Stack:** Go 1.25, net/http, PostgreSQL-backed `pgstore`, embedded vanilla JavaScript, node:test.

**Spec:** `docs/superpowers/specs/2026-08-27-topology-draft-sync-design.md`

## Global Constraints

- Scope is `/ui/topology` only; other editor pages retain full-document `PUT`.
- The draft and `X-Draft-Revision` are authoritative; a link array index is never an API identifier.
- Every operation validates a complete `ProjectDoc` before persistence and responds with canonical topology and layout.
- No undo UI now; commands must remain granular enough for inverse commands later.
- Verify in Docker: Go build, vet, format, test; then all browserless JS tests.

---

### Task 1: Add pure topology-operation commands

**Files:**
- Create: `internal/httpapi/topology_operations.go`
- Create: `internal/httpapi/topology_operations_test.go`
- Modify: `internal/httpapi/dto.go`

**Interfaces:**
- Produces `topologyOperation` with `Kind`, `Device`, `Network`, `Link`, `Union`, `Filter`, names, attach endpoint, and layout payload.
- Produces `applyTopologyOperation(projectdoc.ProjectDoc, topologyOperation) (projectdoc.ProjectDoc, error)`.

- [x] **Step 1: Write failing tests for command application**

```go
func TestApplyTopologyOperation_CreateLinkAndSetFilter(t *testing.T) {
  doc := fixtureProjectDoc()
  next, err := applyTopologyOperation(doc, topologyOperation{
    Kind: "create-link", Link: &LinkDoc{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}},
  })
  if err != nil || len(next.Topology.Links) != 1 { t.Fatalf("next=%+v err=%v", next, err) }
  next, err = applyTopologyOperation(next, topologyOperation{
    Kind: "set-link-filter", Link: &LinkDoc{A: EndpointDoc{Device: "r2"}, B: EndpointDoc{Device: "r1"}},
    Filter: &LinkFilterDoc{AExports: []string{"office"}, BExports: []string{}},
  })
  if err != nil || next.Topology.Links[0].Filter == nil { t.Fatal("filter was not set") }
}
```

Cover device deletion cascading to links/attachments, attach/detach, union membership, clearing a filter, layout position, unknown kind, and unknown link.

- [x] **Step 2: Verify RED**

Run: `go test ./internal/httpapi -run '^TestApplyTopologyOperation_' -count=1`

- [x] **Step 3: Implement the minimal pure dispatcher**

```go
func canonicalLink(a, b string) (string, string) {
  if a > b { return b, a }
  return a, b
}
func linkIndex(links []LinkDoc, a, b string) int {
  a, b = canonicalLink(a, b)
  for i, l := range links {
    x, y := canonicalLink(l.A.Device, l.B.Device)
    if x == a && y == b { return i }
  }
  return -1
}
```

Each switch case changes only fields named by its command. Cross-document validation remains in the HTTP handler.

- [x] **Step 4: Verify GREEN**

Run: `go test ./internal/httpapi -run '^TestApplyTopologyOperation_' -count=1`

- [x] **Step 5: Commit**

```sh
git add internal/httpapi/dto.go internal/httpapi/topology_operations.go internal/httpapi/topology_operations_test.go
git commit -m "feat(httpapi): add topology draft operations"
```

### Task 2: Expose atomic operations and stable link identity

**Files:**
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/handlers.go`
- Modify: `internal/httpapi/handlers_test.go`
- Modify: `internal/httpapi/topology_operations.go`

**Interfaces:**
- Produces `POST /api/drafts/{id}/topology/operations`.
- Produces `editorSnapshot{Topology TopologyDoc; Layout projectdoc.LayoutDoc}` with `X-Draft-Revision`.
- Changes link candidates to `GET link-exports?a=<device>&b=<device>&side=a|b`.

- [x] **Step 1: Write failing HTTP tests**

```go
func TestPostTopologyOperation_ReturnsCanonicalSnapshot(t *testing.T) {
  h, _, id := newTestServer(t)
  rec := doJSON(t, h, http.MethodPost, draftPath(id, "topology/operations"), map[string]any{
    "kind": "create-link", "link": map[string]any{"a": map[string]string{"device": "r2"}, "b": map[string]string{"device": "r1"}},
  })
  if rec.Code != http.StatusOK || rec.Header().Get("X-Draft-Revision") == "" { t.Fatalf("status=%d header=%q", rec.Code, rec.Header()) }
}
```

Add literal tests for 409 on stale revision without a draft change, 422 on an invalid filtered link, shared topology/layout revision, and candidates resolved by endpoints after sorted storage round-trip.

- [ ] **Step 2: Verify RED in an isolated Docker test database** — исторический шаг: после реализации его нельзя воспроизвести без временного отката кода.

Run: `go test ./internal/httpapi -run '^(TestPostTopologyOperation_|TestGetLinkExports_)' -count=1`.

- [x] **Step 3: Implement the handler**

```go
func (h *handlers) postDraftTopologyOperation(w http.ResponseWriter, r *http.Request) {
  if _, ok := h.resolveDraftForAccess(w, r); !ok { return }
  var op topologyOperation
  if err := json.NewDecoder(r.Body).Decode(&op); err != nil { writeError(w, 400, err); return }
  prev, rev, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
  if err != nil { writeStoreError(w, err); return }
  next, err := applyTopologyOperation(prev, op)
  if err != nil { writeError(w, http.StatusUnprocessableEntity, err); return }
  if errs := deletionErrorsFromDocs(prev, next); len(errs) > 0 { writeError(w, 409, errors.New(strings.Join(errs, "; "))); return }
  if _, err := loadTopologyDoc(next); err != nil { writeError(w, 422, err); return }
  if _, err = h.projects.WriteDraft(r.Context(), r.PathValue("id"), next, requestRevision(r, rev)); err != nil { writeStoreError(w, err); return }
  saved, savedRev, err := h.projects.ReadDraft(r.Context(), r.PathValue("id"))
  if err != nil { writeStoreError(w, err); return }
  w.Header().Set("X-Draft-Revision", savedRev)
  writeJSON(w, http.StatusOK, editorSnapshot{Topology: saved.Topology, Layout: saved.Layout})
}
```

Resolve the candidate link with `linkIndex`; never accept an array offset. Use the post-read revision because it matches the response even if another write committed meanwhile.

- [x] **Step 4: Verify GREEN**

Run: `go test ./internal/httpapi -run '^(TestPostTopologyOperation_|TestGetLinkExports|TestPutTopology_)' -count=1`

- [x] **Step 5: Commit**

```sh
git add internal/httpapi/server.go internal/httpapi/handlers.go internal/httpapi/handlers_test.go internal/httpapi/topology_operations.go
git commit -m "feat(httpapi): synchronize topology operations in drafts"
```

### Task 3: Create the browser queue and revision-aware POST

**Files:**
- Create: `internal/httpapi/web/topology_sync.js`
- Create: `internal/httpapi/web/topology_sync.test.js`
- Modify: `internal/httpapi/web/common.js`
- Modify: `internal/httpapi/web/topology.html`

**Interfaces:**
- Produces `TopologySync.create({read, write, apply, onState, onStatus, reload})`.
- Methods: `seed(snapshot)`, `enqueue(operation)`, `idle()`, `pending()`.

- [x] **Step 1: Write failing node tests**

```js
test("queue serializes commands and projects later pending commands over a canonical response", async () => {
  const sent = [];
  const sync = TopologySync.create({
    read: () => ({ value: 0 }), apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => { sent.push(op.delta); return { topology: { value: sent.reduce((a, b) => a + b, 0) }, layout: {} }; },
    onState() {}, onStatus() {}, reload: async () => ({ topology: { value: 0 }, layout: {} }),
  });
  sync.seed({ topology: { value: 0 }, layout: {} });
  sync.enqueue({ delta: 1 }); sync.enqueue({ delta: 2 });
  await sync.idle();
  assert.deepEqual(sent, [1, 2]);
});
```

Add cases for coalesced queued layout commands, 409 reload and pending discard, 422 rollback, network-error status, and `Api.post` sending/updating the revision header.

- [x] **Step 2: Verify RED**

Run: `node --test 'internal/httpapi/web/topology_sync.test.js' 'internal/httpapi/web/draft_context.test.js'`

- [x] **Step 3: Implement queue and API header support**

```js
function enqueue(op) { pending = coalesce(pending, op); publish(); if (!inFlight) void drain(); }
async function drain() {
  inFlight = true;
  while (pending.length) {
    try { confirmed = await write(pending[0]); pending.shift(); publish(); }
    catch (e) { await reconcile(e); return; }
  }
  inFlight = false; onStatus("saved");
}
```

`publish()` applies every pending command over the confirmed snapshot. `reconcile()` reloads topology/layout, clears pending, and reports the failure without replaying a potentially invalid action.

- [x] **Step 4: Verify GREEN and commit**

Run: `node --test 'internal/httpapi/web/topology_sync.test.js' 'internal/httpapi/web/draft_context.test.js'`

```sh
git add internal/httpapi/web/common.js internal/httpapi/web/topology_sync.js internal/httpapi/web/topology_sync.test.js internal/httpapi/web/topology.html
git commit -m "feat(web): add topology draft operation queue"
```

### Task 4: Migrate every canvas edit to commands

**Files:**
- Modify: `internal/httpapi/web/topology.html`
- Modify: `internal/httpapi/web/topology.js`
- Modify: `internal/httpapi/web/link_panel.js`
- Modify: `internal/httpapi/web/topology_render.test.js`
- Modify: `internal/httpapi/web/link_panel.test.js`

**Interfaces:**
- Consumes: `TopologySync`, operation endpoint, endpoint-pair candidate API.
- Produces: UI state projected by the queue and immediate sync status instead of a bulk Save button.

- [x] **Step 1: Write failing canvas regressions**

```js
test("creating a link persists it before filter candidates are requested", async () => {
  const page = bootTopology(operationResponses);
  await tick();
  // connect r1-r2; wait for POST; then open its panel
  assert.ok(page.calls.some((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST"));
  assert.ok(page.calls.some((c) => /link-exports\?a=r1&b=r2&side=a/.test(c.path)));
});
```

Add response-reordering, set/clear filter, delete, attach, union membership, coalesced node/waypoint drag, and no unsaved-navigation prompt after a confirmed command.

- [x] **Step 2: Verify RED**

Run: `node --test 'internal/httpapi/web/topology_render.test.js' 'internal/httpapi/web/link_panel.test.js'`

- [x] **Step 3: Refactor the canvas**

Seed the queue after initial topology/layout load. Make `onState` replace `State.topology`, `State.layout`, and camera, then rebuild the scene and remove selections whose objects disappeared. Replace direct writes in `createNode`, connects, attachments, `setUnion`, `deleteSelection`, filter application, node drag, waypoint editing, and camera callbacks with `enqueue`; enqueue layout only on drag end. Replace index-based `LinkPanel` data with `{a, b}`. Remove `DirtyGuard.arm` and `topo-save` behavior; render an accessible sync status.

- [x] **Step 4: Verify GREEN and commit**

Run: `node --test 'internal/httpapi/web/topology_render.test.js' 'internal/httpapi/web/link_panel.test.js' 'internal/httpapi/web/topology_sync.test.js'`

```sh
git add internal/httpapi/web/topology.html internal/httpapi/web/topology.js internal/httpapi/web/link_panel.js internal/httpapi/web/topology_render.test.js internal/httpapi/web/link_panel.test.js
git commit -m "feat(web): persist topology canvas operations immediately"
```

### Task 5: Verify the complete system in Docker

**Files:**
- Modify: `README.md` only if it tells users to save topology manually.

- [x] **Step 1: Create and use an isolated test database**

Check that `firenet_test_topology_sync` does not exist, create it in Compose service `db`, and point `FIRENET_TEST_DATABASE_URL` to it. Never use the running `firenet` database because `dbtest.Open` truncates tables.

- [x] **Step 2: Run Go verification in order**

Run in one-off Docker containers: `go build ./...`; `go vet ./...`; `gofmt -l .`; `go test ./...` with the isolated database over `firenet_default`.

- [x] **Step 3: Run JS verification and remove temporary state**

Run: `docker run --rm -v /home/kudes/repos/firenet:/src -w /src node:22-alpine node --test 'internal/httpapi/web/*.test.js'`. Drop `firenet_test_topology_sync`, run `git diff --check`, and confirm only task files changed.

- [x] **Step 4: Commit documentation only if it changed** — README не менялся.

```sh
git add README.md
git commit -m "docs: describe topology auto-save"
```
