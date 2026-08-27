# Draft/Version UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web UI draft/version-aware — every existing page (topology, subnets, rules, networks, sets, unions, links, diagnose) reads/writes through the currently-selected draft (or the read-only current version), plus new pages to create/review/confirm drafts and browse version history.

**Architecture:** `common.js` gains a small draft-context layer (`currentDraftID`/`apiPath`/`isReadOnly`, backed by `sessionStorage` so each browser tab can hold a different draft) that every existing page's JS routes its `Api` calls through instead of the old flat `/api/topology`-style URLs, plus a persistent read-only banner with an "Open a draft" action. A small `GET /api/drafts/{id}` endpoint supplies active-draft metadata after reload. Two new pages, `drafts.html` and `history.html`, cover the rest of the spec's "Web UI" bullet: drafts list/create/delete/diff/confirm, and version history/diff/restore.

**Tech Stack:** Same vanilla JS + htmx/Alpine.js stack already in `internal/httpapi/web` — no new dependencies. Tests via `node --test` loading source through `vm.runInContext`, matching every existing `*_page.test.js`.

**Spec:** `docs/superpowers/specs/2026-08-26-multiuser-collab-design.md` ("Архитектура" → "Web UI" bullet: login page — done; "индикатор текущей версии в шапке (read-only, только 'Открыть черновик' для начала правок)", "страница черновиков с кнопкой «Отправить на подтверждение»", "страница истории версий (список + дифф)", "страница пользователей" — done). Implements the frontend half of `docs/superpowers/plans/2026-08-26-entity-versioning.md`'s API, which shipped with **no** frontend consumer — right now every existing page 404s against the old `/api/topology` etc. routes, since those routes no longer exist. This plan is what makes the web UI work again at all, not just a polish pass.

## Global Constraints

- Go 1.25. UI work is under `internal/httpapi/web`; `internal/httpapi/server.go` registers each standalone page by hand and Task 7 removes the obsolete HTMX compile adapter. Go-side changes are narrow and task-scoped: Task 0 adds `GET /api/drafts/{id}`, Task 7 removes `POST /ui/compile` and its handler/template, Tasks 8-9 each add one `GET /ui/...` route. Tasks 1-6 touch no Go code at all.
- Follow existing conventions: `Api.get/post/put` + `showBanner` for fetch/error handling, `Alpine.data(...)` component pattern for the six list-editor pages (subnets/networks/sets/unions/links/rules), plain DOM manipulation for the canvas/diagnose pages, `node --test` + `vm.runInContext` for tests (see `internal/httpapi/web/sidebar.test.js`). `drafts.html`/`history.html` follow `topology.js`/`diagnose.js`'s IIFE-returning-a-controller-object pattern rather than `users.html`/`users.js`'s bare closure — `users.js` exports nothing, so nothing in it is reachable from a test; Task 8 explains this in more detail.
- `sessionStorage`, not `localStorage`, holds the active draft id: it's tab-scoped by design (a user can have draft A open in one tab and draft B in another), unlike `localStorage`'s theme/sidebar-collapse state, which is deliberately shared across tabs.
- No backward-compat shims: every old `/api/topology`-style URL literal in production code is replaced, not left as a fallback.
- Per the project's `Общие правила`: automated tests only (`node --test`), no manual browser click-through required per change.

## File Structure

- `internal/httpapi/draft_handlers.go` supplies selected-draft metadata through existing access checks.
- `internal/httpapi/web/common.js` owns the selected draft, CAS token, errors, context banner, and navigation.
- Existing page scripts route project requests through `apiPath`; `compile.js`, `drafts.js`, and `history.js` are focused controllers for their standalone pages.
- `internal/httpapi/server.go` registers the new API and UI routes, while the obsolete HTMX compile handler/template are removed.
- Each controller has a co-located `node:test` file with DOM/storage/fetch stubs.

### Task 0: Expose active-draft metadata for the shared banner

**Files:**
- Modify: `internal/httpapi/draft_handlers.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/auth_handlers_test.go`

**Interfaces:**
- Produces `GET /api/drafts/{id}` returning the existing `draftResponse` (`id`, `owner`, `name`, `baseVersion`, `status`).
- The endpoint uses `resolveDraftForAccess`: only the owner or an admin receives `200`; an unrelated user gets `403`; an unknown ID gets `404`.

- [ ] **Step 1: Write the failing HTTP tests**

Add `TestGetDraft` beside the other auth/draft HTTP tests. Use the existing owner handler, a logged-in unrelated user, and an admin handler. Decode the success response and check the metadata:

```go
rec := doJSON(t, ownerHandler, http.MethodGet, "/api/drafts/"+draftID, nil)
if rec.Code != http.StatusOK {
	t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
}
var got draftResponse
if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
	t.Fatalf("decode response: %v", err)
}
if got.ID != draftID || got.Name != "work" || got.Status != "open" {
	t.Fatalf("draft = %+v", got)
}
```

Assert `403` for the unrelated-user request and `404` for `/api/drafts/missing`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/httpapi -run TestGetDraft -count=1`

Expected: FAIL with `404`, because the route is not registered.

- [ ] **Step 3: Add the handler and route**

Add this handler next to `deleteDraft`:

```go
func (h *handlers) getDraft(w http.ResponseWriter, r *http.Request) {
	d, ok := h.resolveDraftForAccess(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, toDraftResponse(d))
}
```

Register it before the `{id}/diff` route:

```go
apiMux.HandleFunc("GET /api/drafts/{id}", h.getDraft)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/httpapi -run TestGetDraft -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/draft_handlers.go internal/httpapi/server.go internal/httpapi/auth_handlers_test.go
git commit -m "feat(httpapi): expose draft metadata for the web UI"
```

## Detailed File Notes

**Modified `internal/httpapi/web/common.js`**: draft-context primitives (`currentDraftID`, `setCurrentDraftID`, `isReadOnly`, `apiPath`, `assertEditable`), `Api` gains CAS revision tracking, a persistent draft/read-only banner wired into the existing boot sequence, two new `NAV_STANDALONE` entries with icons.

**New `internal/httpapi/web/drafts.html` + `drafts.js`**: list your drafts (admins: everyone's, via a toggle), create/delete, per-draft diff with conflict highlighting, admin confirm. **Modified `internal/httpapi/server.go`**: one route, `GET /ui/drafts`.

**New `internal/httpapi/web/history.html` + `history.js`**: version list, diff against the previous (or a chosen) version, admin restore. **Modified `internal/httpapi/server.go`**: one route, `GET /ui/history`.

**Modified `internal/httpapi/web/{topology,links,networks,rules,sets,subnets,unions,diagnose}.js`**: every `/api/...` URL literal becomes an `apiPath(...)` call; every save path (all but `diagnose.js`, which has none) gets an `assertEditable()` guard.

**Modified test files**: `topology_render.test.js`, `topology_search.test.js`, `links_page.test.js`, `networks_page.test.js`, `rules_page.test.js`, `sets_page.test.js`, `subnets_page.test.js`, `unions_page.test.js`, `diagnose_page.test.js`, `sidebar.test.js` — sandboxes gain a `sessionStorage` stub, mocked URL literals move to the new scheme, one new "blocked while read-only" test per editable page.

**Modified `internal/httpapi/web/style.css`**: `.draft-banner`/`.draft-banner-readonly`/`.draft-banner-editing` styles, plus `.conflict-row` for the drafts diff table.

---

### Task 1: `common.js` — draft-context primitives and `Api` revision tracking

**Files:**
- Modify: `internal/httpapi/web/common.js`
- Create: `internal/httpapi/web/draft_context.test.js`

**Interfaces:**
- Produces (globals inside `common.js`, matching its existing top-level `const`/`function` style):
  - `function currentDraftID()` — reads `sessionStorage["firenet-draft-id"]`, `null` if unset
  - `function setCurrentDraftID(id)` — `id` truthy sets it, falsy clears it
  - `function isReadOnly()` — `!currentDraftID()`
- `function apiPath(suffix)` — `` `/api/drafts/${id}/${suffix}` `` when a draft is active, else `` `/api/versions/current/${suffix}` ``
- `class ReadOnlyError extends Error`
- `function assertEditable()` — throws `ReadOnlyError` when `isReadOnly()`
- `Api.get/post/put/delete` now track the draft's CAS revision from `X-Draft-Revision` response headers and attach it as a request header on every `put`; failed calls throw an error with `.status` and parsed `.data` so the drafts page can render confirmation conflicts.

This is pure logic — no DOM — so it gets its own focused test file rather than piggybacking on `sidebar.test.js`.

- [ ] **Step 1: Write the failing test**

`internal/httpapi/web/draft_context.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCommon(store = {}) {
  const sandbox = {
    document: { addEventListener() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  const names = vm.runInContext("({ currentDraftID, setCurrentDraftID, isReadOnly, apiPath, assertEditable, ReadOnlyError, Api })", sandbox);
  return { ...names, sandbox, store };
}

test("currentDraftID/setCurrentDraftID round-trip through sessionStorage", () => {
  const { currentDraftID, setCurrentDraftID, store } = loadCommon();
  assert.equal(currentDraftID(), null);
  setCurrentDraftID("draft-1");
  assert.equal(store["firenet-draft-id"], "draft-1");
  assert.equal(currentDraftID(), "draft-1");
  setCurrentDraftID(null);
  assert.equal(currentDraftID(), null);
});

test("isReadOnly reflects whether a draft is active", () => {
  const { isReadOnly, setCurrentDraftID } = loadCommon();
  assert.equal(isReadOnly(), true);
  setCurrentDraftID("draft-1");
  assert.equal(isReadOnly(), false);
});

test("apiPath routes to the active draft, or the current version otherwise", () => {
  const { apiPath, setCurrentDraftID } = loadCommon();
  assert.equal(apiPath("topology"), "/api/versions/current/topology");
  setCurrentDraftID("draft-1");
  assert.equal(apiPath("topology"), "/api/drafts/draft-1/topology");
  assert.equal(apiPath("link-exports?link=0&side=a"), "/api/drafts/draft-1/link-exports?link=0&side=a");
});

test("assertEditable throws ReadOnlyError only when read-only", () => {
  const { assertEditable, setCurrentDraftID, ReadOnlyError } = loadCommon();
  assert.throws(() => assertEditable(), ReadOnlyError);
  setCurrentDraftID("draft-1");
  assert.doesNotThrow(() => assertEditable());
});

test("Api.put sends the revision from the last Api.get and updates it from the response", async () => {
  const { Api, sandbox } = loadCommon({ "firenet-draft-id": "draft-1" });
  const requests = [];
  sandbox.fetch = async (url, opts) => {
    requests.push({ url, headers: opts?.headers || {} });
    if (!opts) {
      return { ok: true, status: 200, headers: { get: (h) => (h === "X-Draft-Revision" ? "3" : null) }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: (h) => (h === "X-Draft-Revision" ? "4" : null) }, json: async () => ({}) };
  };
  await Api.get("/api/drafts/draft-1/topology");
  await Api.put("/api/drafts/draft-1/topology", { devices: [] });
  assert.equal(requests[1].headers["X-Draft-Revision"], "3");

  await Api.put("/api/drafts/draft-1/topology", { devices: [] });
  assert.equal(requests[2].headers["X-Draft-Revision"], "4");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test internal/httpapi/web/draft_context.test.js`
Expected: every test fails — `currentDraftID`/`apiPath`/etc. undefined.

- [ ] **Step 3: Add the draft-context primitives to `common.js`**

Insert right after the `DirtyGuard` block (`internal/httpapi/web/common.js`, just before `const Api = {`):
```js
// --- draft context ---
// sessionStorage (not localStorage) so each browser tab can hold a
// different draft: a user editing draft A in one tab and draft B in
// another must not clobber each other's context.
const DRAFT_ID_KEY = "firenet-draft-id";

function currentDraftID() {
  return sessionStorage.getItem(DRAFT_ID_KEY) || null;
}

function setCurrentDraftID(id) {
  lastDraftRevision = null;
  if (id) sessionStorage.setItem(DRAFT_ID_KEY, id);
  else sessionStorage.removeItem(DRAFT_ID_KEY);
}

function isReadOnly() {
  return !currentDraftID();
}

// apiPath builds the URL for one project-data resource (e.g. "topology",
// or "link-exports?link=0&side=a"), routed through the active draft in
// this tab, or the read-only current version otherwise. Every page that
// reads/writes project data goes through this instead of a literal
// "/api/..." string, so there is exactly one place that knows the
// draft-vs-current routing rule.
function apiPath(suffix) {
  const draftID = currentDraftID();
  return draftID ? `/api/drafts/${draftID}/${suffix}` : `/api/versions/current/${suffix}`;
}

class ReadOnlyError extends Error {
  constructor() {
    super("Только чтение — откройте черновик, чтобы редактировать");
  }
}

// assertEditable is the one-line guard every save path calls first.
function assertEditable() {
  if (isReadOnly()) throw new ReadOnlyError();
}

// lastDraftRevision is the CAS token from the most recent draft response
// (GET or PUT) in this page load — attached to the next PUT automatically
// so callers never have to thread X-Draft-Revision through by hand.
let lastDraftRevision = null;
```

- [ ] **Step 4: Wire revision tracking into `Api`**

Replace the `const Api = { ... }` block:
```js
const Api = {
  async get(path) {
    const res = await fetch(path);
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    const rev = res.headers?.get("X-Draft-Revision");
    if (rev) lastDraftRevision = rev;
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
  async put(path, body) {
    const headers = { "Content-Type": "application/json" };
    if (lastDraftRevision) headers["X-Draft-Revision"] = lastDraftRevision;
    const res = await fetch(path, { method: "PUT", headers, body: JSON.stringify(body) });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    const rev = res.headers?.get("X-Draft-Revision");
    if (rev) lastDraftRevision = rev;
    return res.status === 204 ? null : res.json();
  },
  async delete(path) {
    const res = await fetch(path, { method: "DELETE" });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
};
```

Replace `apiError` so the status and decoded JSON survive for `confirm` handling:

```js
async function apiError(res) {
  let data = {};
  try { data = await res.json(); } catch {}
  const err = new Error(data.error || `HTTP ${res.status}`);
  err.status = res.status;
  err.data = data;
  return err;
}
```

(`Api.post` doesn't touch the revision: `/api/drafts` creation and `/api/drafts/{id}/confirm` aren't CAS-protected reads/writes of a draft's document.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test internal/httpapi/web/draft_context.test.js`
Expected: `pass 5`, `fail 0`.

- [ ] **Step 6: Run the common-JS regression tests**

Run: `node --test internal/httpapi/web/dirty_guard.test.js internal/httpapi/web/sidebar.test.js internal/httpapi/web/login_redirect.test.js`

Expected: all pass. `res.headers?.get(...)` intentionally supports the older minimal fetch stubs that have no `headers` object.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/draft_context.test.js internal/httpapi/web/dirty_guard.test.js internal/httpapi/web/sidebar.test.js
git commit -m "feat(web): add draft-context routing (apiPath/isReadOnly) and CAS revision tracking"
```

---

### Task 2: `common.js` — persistent draft/read-only banner

**Files:**
- Modify: `internal/httpapi/web/common.js`
- Modify: `internal/httpapi/web/style.css`
- Create: `internal/httpapi/web/draft_banner.test.js`

**Interfaces:**
- Consumes: `currentDraftID`, `setCurrentDraftID`, `Api` (Task 1).
- Produces: `function renderDraftBanner()`; wired into the existing `DOMContentLoaded` auto-init, opting out via `<body data-no-draft-banner="true">` (used later by Task 8's `drafts.html` and Task 9's `history.html` — those pages manage drafts/versions directly, so the generic "you're read-only, open a draft" banner would just be confusing noise on top of what they already show; `users.html` has nothing to do with drafts and keeps the generic banner, see Task 4).

- [ ] **Step 1: Write the failing test**

`internal/httpapi/web/draft_banner.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, className: "", _text: "",
    classList: {
      add(c) { if (!el.className.split(" ").includes(c)) el.className += (el.className ? " " : "") + c; },
    },
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    prepend(...cs) { cs.reverse().forEach((c) => { c.parent = this; this.children.unshift(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
  };
  return el;
}

function loadCommon(store, promptResult) {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = () => {};
  const posted = [];
  const sandbox = {
    document: doc,
    window: { prompt: () => promptResult, location: { reload() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, opts) => {
      posted.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new-draft" }) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  const { renderDraftBanner } = vm.runInContext("({ renderDraftBanner })", sandbox);
  return { renderDraftBanner, doc, posted, sandbox };
}

test("shows a read-only banner with an 'open draft' action when no draft is active", () => {
  const { renderDraftBanner, doc } = loadCommon({});
  renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-readonly");
  assert.equal(banner.children[0].textContent, "Только чтение — текущая подтверждённая версия.");
});

test("the open-draft button creates a draft and stores its id", async () => {
  const { renderDraftBanner, doc, posted, sandbox } = loadCommon({}, "my-changes");
  renderDraftBanner();
  const openBtn = doc.body.children[0].children[1];
  await openBtn.listeners.click[0]();
  assert.equal(posted[0].url, "/api/drafts");
  assert.equal(posted[0].body.name, "my-changes");
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), "new-draft");
});

test("shows an editing banner with a 'return to current' action when a draft is active", () => {
  const { renderDraftBanner, doc, sandbox } = loadCommon({ "firenet-draft-id": "draft-1" });
  renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-editing");
  banner.children[1].listeners.click[0]();
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test internal/httpapi/web/draft_banner.test.js`
Expected: FAIL — `renderDraftBanner` undefined.

- [ ] **Step 3: Add `renderDraftBanner` to `common.js`**

Append, after the draft-context block Task 1 added:
```js
// renderDraftBanner shows a persistent, page-wide indicator of whether
// this tab is viewing the read-only current version or editing inside a
// draft, with the action to switch.
function renderDraftBanner() {
  const banner = document.createElement("div");
  banner.className = "draft-banner";
  const draftID = currentDraftID();

  if (draftID) {
    banner.classList.add("draft-banner-editing");
    const text = document.createElement("span");
    text.textContent = "Черновик активен.";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Вернуться к текущей версии";
    closeBtn.addEventListener("click", () => {
      setCurrentDraftID(null);
      window.location.reload();
    });
    banner.append(text, closeBtn);
  } else {
    banner.classList.add("draft-banner-readonly");
    const text = document.createElement("span");
    text.textContent = "Только чтение — текущая подтверждённая версия.";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "Открыть черновик";
    openBtn.addEventListener("click", async () => {
      const name = window.prompt("Имя черновика:");
      if (!name) return;
      try {
        const draft = await Api.post("/api/drafts", { name });
        setCurrentDraftID(draft.id);
        window.location.reload();
      } catch (e) {
        showBanner("Не удалось создать черновик: " + e.message);
      }
    });
    banner.append(text, openBtn);
  }

  document.body.prepend(banner);
}
```

- [ ] **Step 4: Wire it into the auto-init block**

`internal/httpapi/web/common.js`'s existing bottom block:
```js
document.addEventListener("DOMContentLoaded", () => {
  const active = document.body.dataset.nav;
  if (active) buildNav(active);
});
```
becomes:
```js
document.addEventListener("DOMContentLoaded", () => {
  const active = document.body.dataset.nav;
  if (active) buildNav(active);
  if (!document.body.dataset.noDraftBanner) renderDraftBanner();
});
```
(`buildNav` runs first so its `prepend(aside)` lands the sidebar at the top; `renderDraftBanner`'s `prepend` then puts the banner above *that*, spanning the very top of the page.)

- [ ] **Step 5: Add banner CSS**

Append to `internal/httpapi/web/style.css`:
```css
.draft-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  font-size: 0.85em;
  border-bottom: 1px solid var(--border);
}
.draft-banner-readonly {
  background: var(--bg);
  color: var(--muted);
}
.draft-banner-editing {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--text);
}
.draft-banner button {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 0.9em;
  cursor: pointer;
}
.draft-banner button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test internal/httpapi/web/draft_banner.test.js`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 7: Run the full JS suite**

Run: `node --test internal/httpapi/web/*.test.js 2>&1 | tail -15`
Expected: all pass — `sidebar.test.js` boots `buildNav` directly (not through the `DOMContentLoaded` handler this task edited), so it's unaffected by `renderDraftBanner` being added to that handler.

- [ ] **Step 8: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/style.css internal/httpapi/web/draft_banner.test.js
git commit -m "feat(web): add a persistent read-only/draft banner to every page"
```

---

### Task 3: `common.js` — nav entries for the new drafts/history pages

**Files:**
- Modify: `internal/httpapi/web/common.js`
- Modify: `internal/httpapi/web/sidebar.test.js`

**Interfaces:**
- Produces: two new `NAV_STANDALONE` entries, `id: "drafts"` (`href: "/ui/drafts"`, `label: "Черновики"`) and `id: "history"` (`href: "/ui/history"`, `label: "История"`), plus matching `NAV_ICONS` entries — consumed by `<body data-nav="drafts">` / `<body data-nav="history">` in Tasks 4/5.

- [ ] **Step 1: Update the failing assertions in `sidebar.test.js`**

`internal/httpapi/web/sidebar.test.js` line 99:
```js
  assert.equal(navLinks.length, 10, "all sections are linked");
```
becomes:
```js
  assert.equal(navLinks.length, 12, "all sections are linked");
```

Lines 103-107:
```js
  assert.deepEqual(
    navLinks.slice(-2).map(label),
    ["Диагностика", "Пользователи"],
    "standalone links after the groups",
  );
```
becomes:
```js
  assert.deepEqual(
    navLinks.slice(-4).map(label),
    ["Диагностика", "Пользователи", "Черновики", "История"],
    "standalone links after the groups",
  );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test internal/httpapi/web/sidebar.test.js`
Expected: FAIL — `navLinks.length` is still 10, and the slice comes back `["Пользователи"]`-short of 4 entries.

- [ ] **Step 3: Add the nav entries and icons to `common.js`**

`internal/httpapi/web/common.js`'s `NAV_STANDALONE` (line 248-251):
```js
const NAV_STANDALONE = [
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика" },
  { id: "users", href: "/ui/users", label: "Пользователи" },
];
```
becomes:
```js
const NAV_STANDALONE = [
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика" },
  { id: "users", href: "/ui/users", label: "Пользователи" },
  { id: "drafts", href: "/ui/drafts", label: "Черновики" },
  { id: "history", href: "/ui/history", label: "История" },
];
```

And `NAV_ICONS` (line 254-265), add two entries before the closing `};`:
```js
  users: svgOpen + '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 8a3 3 0 1 1 0 6"/><path d="M21 20c0-2.5-1.6-4.6-4-5.5"/></svg>',
  drafts: svgOpen + '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  history: svgOpen + '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 3"/></svg>',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test internal/httpapi/web/sidebar.test.js`
Expected: `pass 6`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/sidebar.test.js
git commit -m "feat(web): add Черновики/История to the sidebar nav"
```

---

### Task 4: `common.js` — live version/draft metadata in the banner

**Files:**
- Modify: `internal/httpapi/web/common.js`
- Modify: `internal/httpapi/web/draft_banner.test.js`

**Interfaces:**
- Consumes: `GET /api/versions?limit=1` → `versionInfoResponse[]` (newest first, confirmed via `pgstore.History`'s `ORDER BY id DESC`), `GET /api/drafts/{id}` → `draftResponse` (added by Task 0).
- Produces: `renderDraftBanner()` becomes `async`; same `draft-banner-readonly`/`draft-banner-editing` classes and button-based interaction as Task 2, now showing the real current version number or the real draft name/status instead of static text.
- Only `drafts.html` (Task 8) and `history.html` (Task 9) opt out via `data-no-draft-banner="true"` — they show this information as part of their own UI. `users.html` keeps the generic banner: it has nothing to do with drafts, so hiding it there was never warranted.

- [ ] **Step 1: Extend the failing tests**

Replace all four tests in `internal/httpapi/web/draft_banner.test.js` (`loadCommon` through the end of the file) with:

```js
function loadCommon(store, opts = {}) {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = () => {};
  const posted = [];
  const sandbox = {
    document: doc,
    window: { prompt: () => opts.promptResult, location: { reload() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, fetchOpts) => {
      if (fetchOpts?.method === "POST" && url === "/api/drafts") {
        posted.push({ url, body: JSON.parse(fetchOpts.body) });
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new-draft" }) };
      }
      if (url === "/api/versions?limit=1") {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: opts.versionID ?? 7 }] };
      }
      if (url.startsWith("/api/drafts/")) {
        if (opts.draftMissing) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: "not found" }) };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: "draft-1", name: opts.draftName ?? "office", status: opts.draftStatus ?? "open" }) };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  const { renderDraftBanner } = vm.runInContext("({ renderDraftBanner })", sandbox);
  return { renderDraftBanner, doc, posted, sandbox };
}

test("shows a read-only banner with the current version and an 'open draft' action", async () => {
  const { renderDraftBanner, doc } = loadCommon({}, { versionID: 7 });
  await renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-readonly");
  assert.equal(banner.children[0].textContent, "Только чтение — версия 7.");
});

test("the open-draft button creates a draft and stores its id", async () => {
  const { renderDraftBanner, doc, posted, sandbox } = loadCommon({}, { versionID: 7, promptResult: "my-changes" });
  await renderDraftBanner();
  const openBtn = doc.body.children[0].children[1];
  await openBtn.listeners.click[0]();
  assert.equal(posted[0].url, "/api/drafts");
  assert.equal(posted[0].body.name, "my-changes");
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), "new-draft");
});

test("shows an editing banner with the draft's name and status, and a 'return to current' action", async () => {
  const { renderDraftBanner, doc, sandbox } = loadCommon({ "firenet-draft-id": "draft-1" }, { draftName: "office", draftStatus: "open" });
  await renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-editing");
  assert.equal(banner.children[0].textContent, "Черновик «office» (open).");
  banner.children[1].listeners.click[0]();
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
});

test("falls back to read-only if the active draft no longer exists", async () => {
  const { renderDraftBanner, sandbox } = loadCommon({ "firenet-draft-id": "gone" }, { draftMissing: true });
  let reloaded = false;
  sandbox.window.location.reload = () => { reloaded = true; };
  await renderDraftBanner();
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
  assert.ok(reloaded, "page reloads to pick up read-only state");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test internal/httpapi/web/draft_banner.test.js`
Expected: FAIL — `renderDraftBanner` is still synchronous and returns static text.

- [ ] **Step 3: Replace `renderDraftBanner` in `common.js`**

Replace the whole function Task 2 added:

```js
// renderDraftBanner shows a persistent, page-wide indicator of whether
// this tab is viewing the read-only current version or editing inside a
// draft, with the action to switch. If the active draft no longer exists
// (deleted or confirmed from another tab), the tab drops back to read-only.
async function renderDraftBanner() {
  const banner = document.createElement("div");
  banner.className = "draft-banner";
  const draftID = currentDraftID();

  if (draftID) {
    let draft;
    try {
      draft = await Api.get(`/api/drafts/${draftID}`);
    } catch {
      setCurrentDraftID(null);
      window.location.reload();
      return;
    }
    banner.classList.add("draft-banner-editing");
    const text = document.createElement("span");
    text.textContent = `Черновик «${draft.name}» (${draft.status}).`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Вернуться к текущей версии";
    closeBtn.addEventListener("click", () => {
      setCurrentDraftID(null);
      window.location.reload();
    });
    banner.append(text, closeBtn);
  } else {
    const [version] = await Api.get("/api/versions?limit=1");
    banner.classList.add("draft-banner-readonly");
    const text = document.createElement("span");
    text.textContent = `Только чтение — версия ${version ? version.id : "—"}.`;
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "Открыть черновик";
    openBtn.addEventListener("click", async () => {
      const name = window.prompt("Имя черновика:");
      if (!name) return;
      try {
        const draft = await Api.post("/api/drafts", { name });
        setCurrentDraftID(draft.id);
        window.location.reload();
      } catch (e) {
        showBanner("Не удалось создать черновик: " + e.message);
      }
    });
    banner.append(text, openBtn);
  }

  document.body.prepend(banner);
}
```

The `classList.add` calls are unchanged from Task 2 — only the content is now live, so the `.draft-banner-readonly`/`.draft-banner-editing` CSS Task 2 added keeps applying (the earlier draft of this task had accidentally dropped them; this version doesn't).

- [ ] **Step 4: Await it in the auto-init block**

`internal/httpapi/web/common.js`'s bottom block:
```js
document.addEventListener("DOMContentLoaded", () => {
  const active = document.body.dataset.nav;
  if (active) buildNav(active);
  if (!document.body.dataset.noDraftBanner) renderDraftBanner();
});
```
becomes:
```js
document.addEventListener("DOMContentLoaded", () => {
  const active = document.body.dataset.nav;
  if (active) buildNav(active);
  if (!document.body.dataset.noDraftBanner) {
    void renderDraftBanner().catch((e) => showBanner("Не удалось загрузить статус версии: " + e.message));
  }
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test internal/httpapi/web/draft_banner.test.js`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 6: Run the full JS suite**

Run: `node --test internal/httpapi/web/*.test.js 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/draft_banner.test.js
git commit -m "feat(web): show the live version/draft in the banner"
```

---

### Task 5: Route topology/links/networks/sets/unions through `apiPath`

These five pages share one editing surface: they all read `topology`+`subnets` and write the whole topology document via a single `PUT`. `topology.js` additionally owns `layout` (camera + node positions) and `link-exports`.

**Files:**
- Modify: `internal/httpapi/web/topology.js`, `links.js`, `networks.js`, `sets.js`, `unions.js`
- Modify: `internal/httpapi/web/topology_render.test.js`, `topology_search.test.js`, `links_page.test.js`, `networks_page.test.js`, `sets_page.test.js`, `unions_page.test.js`

**Interfaces:**
- Consumes: `apiPath(suffix)`, `assertEditable()`, `ReadOnlyError` (Task 1).
- No new production interfaces — this task only changes how these five files reach the same backend.

- [ ] **Step 1: Update `topology.js`**

`internal/httpapi/web/topology.js:86`:
```js
      fetchExports: (i, side) => Api.get(`/api/link-exports?link=${i}&side=${side}`).then((res) => res.entities || []),
```
becomes:
```js
      fetchExports: (i, side) => Api.get(apiPath(`link-exports?link=${i}&side=${side}`)).then((res) => res.entities || []),
```

`topology.js:95-102` (`scheduleLayoutSave`) — read-only tabs must not even attempt the write, since it would just throw:
```js
  function scheduleLayoutSave() {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      Api.put("/api/layout", { ...State.layout, camera: State.camera }).catch(() => {
        /* layout is best-effort presentation state */
      });
    }, 400);
  }
```
becomes:
```js
  function scheduleLayoutSave() {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      try {
        assertEditable();
      } catch {
        return; // read-only tab: nothing to persist
      }
      Api.put(apiPath("layout"), { ...State.layout, camera: State.camera }).catch(() => {
        /* layout is best-effort presentation state */
      });
    }, 400);
  }
```

`topology.js:900-912` (`setupForms`):
```js
  function setupForms() {
    DirtyGuard.arm(() => State.topology);
    document.getElementById("topo-save").addEventListener("click", async () => {
      try {
        State.topology = await Api.put("/api/topology", State.topology);
        showBanner("Топология сохранена", "ok");
        DirtyGuard.markClean();
        render();
      } catch (e) {
        showBanner("Ошибка сохранения топологии: " + e.message);
      }
    });
  }
```
becomes:
```js
  function setupForms() {
    DirtyGuard.arm(() => State.topology);
    document.getElementById("topo-save").addEventListener("click", async () => {
      try {
        assertEditable();
        State.topology = await Api.put(apiPath("topology"), State.topology);
        showBanner("Топология сохранена", "ok");
        DirtyGuard.markClean();
        render();
      } catch (e) {
        showBanner("Ошибка сохранения топологии: " + e.message);
      }
    });
  }
```

`topology.js:916` (`boot`):
```js
      const [topo, subnetsDoc] = await Promise.all([Api.get("/api/topology"), Api.get("/api/subnets")]);
```
becomes:
```js
      const [topo, subnetsDoc] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
```

`topology.js:923`:
```js
      const layout = await Api.get("/api/layout");
```
becomes:
```js
      const layout = await Api.get(apiPath("layout"));
```

- [ ] **Step 2: Update `links.js`, `networks.js`, `sets.js`, `unions.js`**

Each file has exactly two call sites: the `Promise.all([Api.get("/api/topology"), Api.get("/api/subnets")])` pair in `init()`, and the `Api.put("/api/topology", {...})` inside `persist(next)`.

In each of `links.js`, `networks.js`, `sets.js`, `unions.js`:
```js
        const [topo, subs] = await Promise.all([Api.get("/api/topology"), Api.get("/api/subnets")]);
```
(the destructured names differ slightly per file — `subs` in `links.js`, `doc` in `networks.js`/`sets.js`, `subnetsDoc` in `unions.js` — replace only the two `Api.get(...)` arguments, keep each file's own variable names)
becomes:
```js
        const [topo, subs] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
```

And in each file's `async persist(next) { try {` — add `assertEditable();` as the first line inside the `try`, and change the `Api.put` call:
```js
    async persist(next) {
      try {
        const doc = await Api.put("/api/topology", {
```
becomes:
```js
    async persist(next) {
      try {
        assertEditable();
        const doc = await Api.put(apiPath("topology"), {
```

- [ ] **Step 3: Update `topology_render.test.js` and `topology_search.test.js`**

Both files build their sandbox in `bootTopology(responses)`. In each file, add a `sessionStorage` stub and a `calls` tracker to the sandbox object (right after the `fetch:` line), and accept an optional draft id so tests can opt out:

`internal/httpapi/web/topology_render.test.js` and `internal/httpapi/web/topology_search.test.js`, change:
```js
function bootTopology(responses) {
```
to:
```js
function bootTopology(responses, draftID = "d1") {
  const draftStore = draftID ? { "firenet-draft-id": draftID } : {};
  const calls = [];
```

and change:
```js
    // clone: production mutates loaded state, responses must stay pristine
    fetch: async (p) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) }),
```
to:
```js
    sessionStorage: {
      getItem: (k) => (k in draftStore ? draftStore[k] : null),
      setItem: (k, v) => { draftStore[k] = v; },
      removeItem: (k) => { delete draftStore[k]; },
    },
    // clone: production mutates loaded state, responses must stay pristine
    fetch: async (p, opts) => {
      calls.push({ path: p, method: opts?.method || "GET" });
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) };
    },
```

(`topology_search.test.js` has the same two blocks at the same relative position — the destructuring at the bottom of its `bootTopology` is `return { canvas, ctx, doc, ids, get: ..., sandbox, pump() {...} };` rather than a separately-declared `get`; leave that shape as-is, just add `calls` to it.)

Then in both files' `bootTopology` return statement, add `calls` and `sandbox` (if not already present) to the returned object.

Then, in **both** files, replace every occurrence of the literal keys `"/api/topology"`, `"/api/subnets"`, `"/api/layout"` used inside `responses` object literals passed to `bootTopology(...)` with `"/api/drafts/d1/topology"`, `"/api/drafts/d1/subnets"`, `"/api/drafts/d1/layout"` respectively (`replace_all` for each of the three strings — every existing test in both files calls `bootTopology(responses)` with the default `draftID = "d1"`, so they keep exercising the same editable code path unchanged).

- [ ] **Step 4: Add a read-only guard test to `topology_render.test.js`**

Append:
```js
test("read-only (no active draft) blocks the topology save and the layout autosave", async () => {
  const responses = {
    "/api/versions/current/topology": { devices: [], links: [], networks: [], sets: [], unions: [] },
    "/api/versions/current/subnets": { subnets: [] },
    "/api/versions/current/layout": {},
  };
  const { ids, calls } = bootTopology(responses, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fire(ids["topo-save"], "click", {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!calls.some((c) => c.method === "PUT"), "read-only tab never writes the topology");
});
```

- [ ] **Step 5: Update `links_page.test.js`, `networks_page.test.js`, `sets_page.test.js`, `unions_page.test.js`**

Each file's `bootPage(...)` builds its own `sandbox`/`fetch`/`return`. In all four files:

1. Add a `sessionStorage` stub to the `sandbox` object (right after `localStorage: { getItem: () => null, setItem() {} },`):
```js
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
```
and declare `const store = { "firenet-draft-id": "d1" };` next to the existing `const calls = [];` / `const banners = [];` declarations at the top of `bootPage`.

2. Change the fetch handler's path checks from the flat form to the draft form, e.g. in `links_page.test.js`:
```js
      if (path_ === "/api/topology") {
```
becomes:
```js
      if (path_ === "/api/drafts/d1/topology") {
```
Same replacement for `"/api/subnets"` → `"/api/drafts/d1/subnets"` in all four files, and for `links_page.test.js`'s additional:
```js
      if (path_?.startsWith("/api/link-exports")) {
```
becomes:
```js
      if (path_?.startsWith("/api/drafts/d1/link-exports")) {
```

3. Add `store` to `bootPage`'s return statement: `return { page, calls, banners, store };`.

4. Append one read-only guard test per file. `links_page.test.js`:
```js
test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.openEdit(0);
  page.draft.aExports = ["NA"];
  await page.saveDraft();
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
```
`networks_page.test.js`:
```js
test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.draft = { index: 0, name: "office", subnets: ["a"], description: "офисная" };
  await page.saveDraft();
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
```
`sets_page.test.js`:
```js
test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.draft = { index: 0, name: "blocked", subnets: ["a"], addresses: ["10.0.0.9"], description: "блоклист" };
  await page.saveDraft();
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
```
`unions_page.test.js`:
```js
test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.draft = { index: 0, name: "hq", description: "" };
  await page.saveDraft();
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
```

- [ ] **Step 6: Run the tests to verify they fail, then implement**

Run: `node --test internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js internal/httpapi/web/links_page.test.js internal/httpapi/web/networks_page.test.js internal/httpapi/web/sets_page.test.js internal/httpapi/web/unions_page.test.js`
Expected: FAIL (production files still call flat `/api/...` paths, don't guard saves). Apply Steps 1-2 to make them pass.

- [ ] **Step 7: Run the tests to verify they pass**

Run the same command as Step 6.
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add internal/httpapi/web/topology.js internal/httpapi/web/links.js internal/httpapi/web/networks.js internal/httpapi/web/sets.js internal/httpapi/web/unions.js internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js internal/httpapi/web/links_page.test.js internal/httpapi/web/networks_page.test.js internal/httpapi/web/sets_page.test.js internal/httpapi/web/unions_page.test.js
git commit -m "feat(web): route topology/links/networks/sets/unions through the active draft"
```

---

### Task 6: Route subnets/rules/diagnose through `apiPath`

These three pages have their own resource shapes (`subnets`, `rules`, and a read-only `diagnose`/`layout` combination) rather than the shared `topology` document from Task 5, so they get their own task.

**Files:**
- Modify: `internal/httpapi/web/subnets.js`, `rules.js`, `diagnose.js`
- Modify: `internal/httpapi/web/subnets_page.test.js`, `rules_page.test.js`, `diagnose_page.test.js`

**Interfaces:**
- Consumes: `apiPath(suffix)`, `assertEditable()` (Task 1).

- [ ] **Step 1: Update `subnets.js`**

`internal/httpapi/web/subnets.js:20`:
```js
        const [doc, topo] = await Promise.all([Api.get("/api/subnets"), Api.get("/api/topology")]);
```
becomes:
```js
        const [doc, topo] = await Promise.all([Api.get(apiPath("subnets")), Api.get(apiPath("topology"))]);
```

`subnets.js:98-108` (`persist`):
```js
    async persist(next) {
      try {
        const doc = await Api.put("/api/subnets", { subnets: next.map(({ name, cidr, description }) => ({ name, cidr, ...(description ? { description } : {}) })) });
        const owner = {};
        const topo = await Api.get("/api/topology");
        (topo.networks || []).forEach((n) => (n.subnets || []).forEach((s) => (owner[s] = n.name)));
        this.rows = doc.subnets.map((s) => ({ name: s.name, cidr: s.cidr, description: s.description || "", owner: owner[s.name] || "" }));
        showBanner("Подсети сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
```
becomes:
```js
    async persist(next) {
      try {
        assertEditable();
        const doc = await Api.put(apiPath("subnets"), { subnets: next.map(({ name, cidr, description }) => ({ name, cidr, ...(description ? { description } : {}) })) });
        const owner = {};
        const topo = await Api.get(apiPath("topology"));
        (topo.networks || []).forEach((n) => (n.subnets || []).forEach((s) => (owner[s] = n.name)));
        this.rows = doc.subnets.map((s) => ({ name: s.name, cidr: s.cidr, description: s.description || "", owner: owner[s.name] || "" }));
        showBanner("Подсети сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
```

- [ ] **Step 2: Update `rules.js`**

`internal/httpapi/web/rules.js:72`:
```js
        const [doc, topo, subnets] = await Promise.all([Api.get("/api/rules"), Api.get("/api/topology"), Api.get("/api/subnets")]);
```
becomes:
```js
        const [doc, topo, subnets] = await Promise.all([Api.get(apiPath("rules")), Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
```

`rules.js:413-417` (`persist` — no internal try/catch; every caller already has one, so `assertEditable()`'s throw propagates exactly like today's save errors do):
```js
    async persist(next) {
      const doc = await Api.put("/api/rules", { chains: next.chains });
      this._applyDoc(doc);
      showBanner("Правила сохранены", "ok");
    },
```
becomes:
```js
    async persist(next) {
      assertEditable();
      const doc = await Api.put(apiPath("rules"), { chains: next.chains });
      this._applyDoc(doc);
      showBanner("Правила сохранены", "ok");
    },
```

`rules.js:424` (`runLint` — read-only, valid against whichever project state is active, no guard):
```js
        const res = await Api.get("/api/lint");
```
becomes:
```js
        const res = await Api.get(apiPath("lint"));
```

- [ ] **Step 3: Update `diagnose.js`**

`internal/httpapi/web/diagnose.js:650-652` (`boot`):
```js
      const [topo, subnetsDoc, layout] = await Promise.all([
        Api.get("/api/topology"), Api.get("/api/subnets"), Api.get("/api/layout"),
      ]);
```
becomes:
```js
      const [topo, subnetsDoc, layout] = await Promise.all([
        Api.get(apiPath("topology")), Api.get(apiPath("subnets")), Api.get(apiPath("layout")),
      ]);
```

`diagnose.js:552` (`run`):
```js
      const report = await Api.post("/api/diagnose", {
```
becomes:
```js
      const report = await Api.post(apiPath("diagnose"), {
```

`diagnose.js:601` (`runSpread`):
```js
        pairs.map(({ src, dstName }) => Api.post("/api/diagnose", { src: src.ip, dst: dstIp(dstName), proto: "", dstPorts: [] })),
```
becomes:
```js
        pairs.map(({ src, dstName }) => Api.post(apiPath("diagnose"), { src: src.ip, dst: dstIp(dstName), proto: "", dstPorts: [] })),
```

No `assertEditable()` calls in this file: diagnose never writes project data (`/api/layout` is read-only here too, per the existing "camera changes are not persisted" test), so nothing needs to be blocked while read-only.

- [ ] **Step 4: Update `subnets_page.test.js`**

Add a `sessionStorage` stub and `store` to `bootPage()` (`internal/httpapi/web/subnets_page.test.js`), same shape as Task 5's Alpine-page changes:
```js
  const store = { "firenet-draft-id": "d1" };
```
next to the existing `const calls = [];` / `const banners = [];`, and:
```js
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
```
into `sandbox`, right after `localStorage: { getItem: () => null, setItem() {} },`.

Change the fetch handler's path checks:
```js
      if (path_ === "/api/subnets") {
```
becomes:
```js
      if (path_ === "/api/drafts/d1/subnets") {
```
and:
```js
      if (path_ === "/api/topology") {
```
becomes:
```js
      if (path_ === "/api/drafts/d1/topology") {
```

Add `store` to `bootPage`'s return: `return { page, calls, banners, store };`.

Append:
```js
test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = bootPage();
  delete store["firenet-draft-id"];
  page.rows = [];
  page.draft = { index: -1, name: "b", cidr: "10.0.1.0/24", description: "гостевая" };

  await page.saveDraft();

  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
```
(`subnets_page.test.js`'s `bootPage()` is synchronous — no `init()` call needed, unlike the other five Alpine pages — matching the existing tests in this file.)

- [ ] **Step 5: Update `rules_page.test.js`**

Same `sessionStorage`/`store` addition to `bootPage({ failPut, lintFindings } = {})`. Change:
```js
      if (path_ === "/api/rules" && opts?.method === "PUT" && failPut) {
```
stays as-is (still keyed by the literal used below), but the two `path_ === "/api/rules"` checks below it become `path_ === "/api/drafts/d1/rules"`:
```js
      if (path_ === "/api/rules") {
        return { ok: true, status: 200, json: async () => calls.findLast((c) => c.method === "PUT")?.body || rulesFixture };
      }
```
becomes (both this and the `failPut` check above it):
```js
      if (path_ === "/api/drafts/d1/rules" && opts?.method === "PUT" && failPut) {
        return { ok: false, status: 422, json: async () => ({ error: failPut }) };
      }
      if (path_ === "/api/drafts/d1/rules") {
        return { ok: true, status: 200, json: async () => calls.findLast((c) => c.method === "PUT")?.body || rulesFixture };
      }
```
and:
```js
      if (path_ === "/api/topology") {
```
→ `path_ === "/api/drafts/d1/topology"`,
```js
      if (path_ === "/api/subnets") {
```
→ `path_ === "/api/drafts/d1/subnets"`,
```js
      if (path_ === "/api/lint") {
```
→ `path_ === "/api/drafts/d1/lint"`.

Add `store` to the return statement.

Append:
```js
test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.openAdd();
  Object.assign(page.draft, { name: "dns", src: ["any"], dst: ["any"], proto: "udp", dstPorts: "53" });

  await page.saveDraft();

  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  assert.match(page.modalError, /Только чтение/);
});
```

- [ ] **Step 6: Update `diagnose_page.test.js`**

`internal/httpapi/web/diagnose_page.test.js`'s `bootDiagnose(responses, savedStore)` gains a third, optional `draftID` parameter (its existing `savedStore`/`store` pair backs `localStorage` for panel-position persistence — unrelated, keep that as-is):
```js
function bootDiagnose(responses, savedStore) {
```
becomes:
```js
function bootDiagnose(responses, savedStore, draftID = "d1") {
  const draftStore = draftID ? { "firenet-draft-id": draftID } : {};
```

Add, right after the existing `localStorage: {...}` block inside `sandbox`:
```js
    sessionStorage: {
      getItem: (k) => (k in draftStore ? draftStore[k] : null),
      setItem: (k, v) => { draftStore[k] = v; },
      removeItem: (k) => { delete draftStore[k]; },
    },
```

Then replace every occurrence of the object keys `"/api/topology"`, `"/api/subnets"`, `"/api/layout"`, `"/api/diagnose"` in this file (the `responses` object at line 176-180, and any per-test `responses` overrides/spreads further down) with `"/api/drafts/d1/topology"`, `"/api/drafts/d1/subnets"`, `"/api/drafts/d1/layout"`, `"/api/drafts/d1/diagnose"` respectively (`replace_all` for each of the four strings — every existing call site uses `bootDiagnose(responses, ...)` with the default `draftID = "d1"`, so all existing tests keep exercising the same code path). No new test is needed here: `diagnose.js` has no save path (Step 3 confirmed this), so there is nothing for a read-only tab to be blocked from — the existing "camera changes are not persisted to /api/layout" test (line 273) already proves the map never writes, in either mode.

- [ ] **Step 7: Run the tests to verify they fail, then implement**

Run: `node --test internal/httpapi/web/subnets_page.test.js internal/httpapi/web/rules_page.test.js internal/httpapi/web/diagnose_page.test.js`
Expected: FAIL. Apply Steps 1-3 to make them pass.

- [ ] **Step 8: Run the tests to verify they pass**

Run the same command as Step 7.
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add internal/httpapi/web/subnets.js internal/httpapi/web/rules.js internal/httpapi/web/diagnose.js internal/httpapi/web/subnets_page.test.js internal/httpapi/web/rules_page.test.js internal/httpapi/web/diagnose_page.test.js
git commit -m "feat(web): route subnets/rules/diagnose through the active draft"
```

---

### Task 7: Make compilation draft-aware

`compile.html` currently posts through HTMX (`hx-post="/ui/compile"`) to a server-rendered fragment (`internal/httpapi/compile_ui.go` + `internal/httpapi/templates/compile.gohtml`). That handler already reads through `pgstore` (`h.currentDoc` → `CurrentVersion`/`ReadAt`), so — unlike the other seven pages — it never 404s; it just always compiles the confirmed current version and can't preview a draft's in-progress changes. This task gives it the same `apiPath`-routed JSON flow as everything else, so compiling a draft is possible, and retires the now-redundant HTMX/template path in favor of the JSON compile endpoints Plan 2 already shipped (`POST /api/versions/current/compile`, `POST /api/drafts/{id}/compile` — confirmed present in `internal/httpapi/server.go`).

**Files:**
- Create: `internal/httpapi/web/compile.js`, `internal/httpapi/web/compile.test.js`
- Modify: `internal/httpapi/web/compile.html`
- Delete: `internal/httpapi/compile_ui.go`, `internal/httpapi/compile_ui_test.go`, `internal/httpapi/templates/compile.gohtml`
- Modify: `internal/httpapi/server.go`

**Interfaces:**
- Consumes: `apiPath(suffix)` (Task 1); `POST apiPath("compile")` → `[]{Name, IPSetsScript, RulesScript}` (confirmed field names from `internal/app/compile.go`'s `CompiledDevice` struct, serialized with no `json:` tags, so PascalCase).
- `POST /ui/compile` and its handler/template are removed — nothing references them after this task.

- [ ] **Step 1: Write the failing test**

`internal/httpapi/web/compile.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, _text: "",
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent || "").join(""); },
  };
  return el;
}

function bootCompile(devicesResponse, draftID = "d1") {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  const ids = { "compile-run": makeEl("button"), "compile-output": makeEl("div") };
  doc.getElementById = (id) => ids[id];
  doc.createElement = (tag) => makeEl(tag);
  doc.listeners = {};
  doc.addEventListener = (t, fn) => (doc.listeners[t] ||= []).push(fn);
  const store = draftID ? { "firenet-draft-id": draftID } : {};
  const calls = [];
  const banners = [];
  const sandbox = {
    document: doc,
    window: { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    URL: { createObjectURL: () => "blob:stub" },
    Blob: class { constructor(parts) { this.parts = parts; } },
    fetch: async (url, opts) => {
      calls.push({ path: url, method: opts?.method });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => devicesResponse };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "compile.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  return { ids, calls, banners };
}

const devices = [{ Name: "r1", IPSetsScript: "ipset restore r1", RulesScript: "iptables r1" }];

test("compiles the active draft and renders per-device scripts", async () => {
  const { ids, calls } = bootCompile(devices, "d1");
  await ids["compile-run"].listeners.click[0]();
  assert.equal(calls[0].path, "/api/drafts/d1/compile");
  assert.equal(calls[0].method, "POST");
  assert.match(ids["compile-output"].textContent, /r1\.ipsets\.restore/);
  assert.match(ids["compile-output"].textContent, /r1\.rules\.sh/);
});

test("compiles the current version when read-only (no active draft)", async () => {
  const { ids, calls } = bootCompile(devices, null);
  await ids["compile-run"].listeners.click[0]();
  assert.equal(calls[0].path, "/api/versions/current/compile");
});

test("a compile error shows a banner instead of throwing", async () => {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  const ids = { "compile-run": makeEl("button"), "compile-output": makeEl("div") };
  doc.getElementById = (id) => ids[id];
  doc.createElement = (tag) => makeEl(tag);
  doc.listeners = {};
  doc.addEventListener = (t, fn) => (doc.listeners[t] ||= []).push(fn);
  const banners = [];
  const sandbox = {
    document: doc,
    window: { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k === "firenet-draft-id" ? "d1" : null),
      setItem() {},
      removeItem() {},
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    fetch: async () => ({ ok: false, status: 422, headers: { get: () => null }, json: async () => ({ error: "правило x: неизвестный src" }) }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "compile.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());

  await ids["compile-run"].listeners.click[0]();

  assert.ok(banners.some((b) => b.message.includes("неизвестный src")), "compile error surfaces as a banner");
  assert.equal(ids["compile-output"].children.length, 0, "output stays empty on failure");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/httpapi/web/compile.test.js`
Expected: FAIL — `compile.js` doesn't exist yet.

- [ ] **Step 3: Write `compile.js`**

```js
"use strict";

// renderDevice builds one device's scripts as text nodes (never innerHTML —
// compiler output is untrusted-ish generated text, not markup) plus a
// download link per script, built from a Blob so no server round-trip is
// needed just to save a file.
function renderDevice(device) {
  const section = document.createElement("section");
  section.className = "compile-device";
  const h2 = document.createElement("h2");
  h2.textContent = device.Name;
  section.append(h2);

  const addScript = (label, filename, content) => {
    const h3 = document.createElement("h3");
    h3.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = content;
    const link = document.createElement("a");
    link.textContent = "Скачать " + filename;
    link.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    link.download = filename;
    section.append(h3, pre, link);
  };
  addScript("ipset", `${device.Name}.ipsets.restore`, device.IPSetsScript);
  addScript("iptables", `${device.Name}.rules.sh`, device.RulesScript);
  return section;
}

async function runCompile() {
  const output = document.getElementById("compile-output");
  try {
    const devices = await Api.post(apiPath("compile"), {});
    output.replaceChildren(...devices.map(renderDevice));
  } catch (err) {
    showBanner(err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("compile-run").addEventListener("click", runCompile);
});
```

- [ ] **Step 4: Rewrite `compile.html`**

`internal/httpapi/web/compile.html`:
```html
<div style="margin-bottom: var(--space-3);">
    <button class="primary" hx-post="/ui/compile" hx-target="#compile-output" hx-swap="innerHTML">Скомпилировать</button>
  </div>
  <div id="compile-output"></div>
</main>

<script src="/htmx.min.js"></script>
<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
</body>
</html>
```
becomes:
```html
<div style="margin-bottom: var(--space-3);">
    <button id="compile-run" class="primary">Скомпилировать</button>
  </div>
  <div id="compile-output"></div>
</main>

<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
<script src="/compile.js"></script>
</body>
</html>
```
(The `<body data-nav="compile" x-data="appData()" @notify.window="showBanner(...)">` line is unchanged — `showBanner` still needs that Alpine scope to actually render, same as every other page.)

- [ ] **Step 5: Remove the HTMX adapter**

```bash
git rm internal/httpapi/compile_ui.go internal/httpapi/compile_ui_test.go internal/httpapi/templates/compile.gohtml
```

`internal/httpapi/server.go`:
```go
	mux.HandleFunc("POST /ui/compile", h.uiCompile)

```
is deleted entirely (the line and its blank line).

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test internal/httpapi/web/compile.test.js`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 7: Run the Go and full JS suites**

Run: `go build ./... && go test ./internal/httpapi -count=1 && node --test internal/httpapi/web/*.test.js 2>&1 | tail -15`
Expected: PASS; no source or test references `/ui/compile`, `compile_ui.go`, or `compile.gohtml`.

- [ ] **Step 8: Commit**

```bash
git add internal/httpapi/web/compile.js internal/httpapi/web/compile.test.js internal/httpapi/web/compile.html internal/httpapi/server.go
git commit -m "feat(web): compile the active draft or current version"
```

---

### Task 8: Draft list, diff, and confirm UI

**Architecture note:** the spec's "страница черновиков" needs assertions like "the confirm button is hidden for a non-admin" and "confirming a conflicting draft keeps it selected" — that requires a test to reach into the page's live state, which the `users.html`/`users.js` closure-only pattern (referenced as the model in this plan's Global Constraints) cannot support: nothing is exported from it, so there is nothing a test could call or read. `topology.js`/`diagnose.js` solve exactly this already, in this same codebase: an IIFE that returns a controller object (`const Topology = { render, boot }; return Topology;`), which `topology_render.test.js` drives directly (`get("Topology.render")` etc). `drafts.js` follows that pattern instead — plain DOM, no framework, but testable.

**Files:**
- Modify: `internal/httpapi/web/common.js`
- Create: `internal/httpapi/web/drafts.html`, `drafts.js`, `drafts.test.js`
- Modify: `internal/httpapi/server.go`, `internal/httpapi/web/style.css`

**Interfaces:**
- Consumes: `Api.get/post`, `setCurrentDraftID`, `currentDraftID`, `showBanner`, `loginRedirectURL` (all existing); raw `fetch` for `DELETE /api/drafts/{id}` and `POST /api/drafts/{id}/confirm` (the same "drop to raw fetch for a status code `Api` doesn't special-case" move `users.js` already makes for its own admin-only `DELETE`, and needed here again because a 409 confirm response carries a `{conflicts: [...]}` body, not the `{error: "..."}` shape `Api`'s generic error path expects).
- Produces: `const Drafts = {...}` (global, IIFE-returned) with `boot()`, `refresh()`, `selectDraft(draft)`, `loadDiff(draft)`, `deleteDraft(id)`, `createDraft(name)`, `confirmSelected()`, and read-only getters `me`, `drafts`, `selected`, `diffs`.
- `/ui/drafts` has `data-nav="drafts" data-no-draft-banner="true"`.

- [ ] **Step 1: Write the failing tests**

`internal/httpapi/web/drafts.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, attrs: {}, className: "", hidden: false, _text: "",
    classList: { add(c) { if (!el.className.split(" ").filter(Boolean).includes(c)) el.className = (el.className + " " + c).trim(); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent || "").join(""); },
  };
  return el;
}

function bootDrafts(fixture = {}) {
  const drafts = fixture.drafts ?? [{ id: "d1", owner: "alice", name: "office", baseVersion: 5, status: "open" }];
  const me = fixture.me ?? { username: "alice", role: "user" };
  const diffs = fixture.diffs ?? [{ kind: "subnet", key: "a", change: "modified", conflict: false }];
  const confirmStatus = fixture.confirmStatus ?? 200;

  const tbody = makeEl("tbody");
  const ids = {
    "drafts-table": Object.assign(makeEl("table"), { querySelector: () => tbody }),
    "all-toggle": makeEl("label"),
    "all-checkbox": makeEl("input"),
    "create-draft-form": Object.assign(makeEl("form"), { name: { value: "" }, reset() { this.name.value = ""; } }),
    "diff-panel": makeEl("section"),
    "diff-draft-name": makeEl("span"),
    "diff-body": makeEl("tbody"),
    "confirm-btn": makeEl("button"),
  };

  const doc = {
    listeners: {},
    getElementById: (id) => ids[id],
    createElement: (tag) => makeEl(tag),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
  };
  const store = {};
  const calls = [];
  const banners = [];
  const location = { href: "" };
  const sandbox = {
    document: doc,
    window: { location, dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    fetch: async (url, opts) => {
      calls.push({ path: url, method: opts?.method || "GET" });
      if (url === "/api/me") return { ok: true, status: 200, headers: { get: () => null }, json: async () => me };
      if (url.startsWith("/api/drafts/") && url.endsWith("/diff")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => diffs };
      }
      if (url.startsWith("/api/drafts/") && url.endsWith("/confirm")) {
        if (confirmStatus === 409) {
          return { ok: false, status: 409, headers: { get: () => null }, json: async () => ({ conflicts: [{ kind: "subnet", key: "a" }] }) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: 6 }) };
      }
      if (opts?.method === "DELETE") {
        return { ok: true, status: 204, headers: { get: () => null }, json: async () => null };
      }
      if (opts?.method === "POST" && url === "/api/drafts") {
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new", owner: "alice", name: JSON.parse(opts.body).name, baseVersion: 5, status: "open" }) };
      }
      if (url.startsWith("/api/drafts")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => drafts };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "drafts.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  return { get: (expr) => vm.runInContext(expr, sandbox), ids, calls, banners, store, location };
}

test("boot loads the user and the drafts list", async () => {
  const { get } = bootDrafts();
  await get("Drafts.boot()");
  assert.equal(get("Drafts.me").role, "user");
  assert.equal(get("Drafts.drafts").length, 1);
});

test("the all-drafts toggle is hidden for a non-admin, shown for an admin", async () => {
  const nonAdmin = bootDrafts({ me: { username: "alice", role: "user" } });
  await nonAdmin.get("Drafts.boot()");
  assert.equal(nonAdmin.ids["all-toggle"].hidden, true);

  const admin = bootDrafts({ me: { username: "root", role: "admin" } });
  await admin.get("Drafts.boot()");
  assert.equal(admin.ids["all-toggle"].hidden, false);
});

test("selectDraft stores the draft id in session storage and navigates to topology", () => {
  const { get, store, location } = bootDrafts();
  get(`Drafts.selectDraft({ id: "d1", name: "office", status: "open" })`);
  assert.equal(store["firenet-draft-id"], "d1");
  assert.equal(location.href, "/ui/topology");
});

test("loadDiff fetches the draft's diff and hides confirm for a non-admin", async () => {
  const { get, ids } = bootDrafts();
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  assert.equal(get("Drafts.diffs").length, 1);
  assert.equal(get("Drafts.diffs")[0].key, "a");
  assert.equal(ids["confirm-btn"].hidden, true, "confirm hidden without an admin boot");
});

test("confirmSelected on success clears the selection and shows the new version", async () => {
  const { get, banners } = bootDrafts({ confirmStatus: 200 });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(get("Drafts.selected"), null);
  assert.ok(banners.some((b) => b.message.includes("версия 6")));
});

test("confirmSelected on a 409 keeps the diff open and reloads it", async () => {
  const { get, banners } = bootDrafts({ confirmStatus: 409 });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(get("Drafts.selected").id, "d1");
  assert.ok(banners.some((b) => b.message.includes("конфликт")));
});

test("deleteDraft clears a matching active draft id and refreshes", async () => {
  const { get, store } = bootDrafts();
  store["firenet-draft-id"] = "d1";
  await get(`Drafts.deleteDraft("d1")`);
  assert.equal(store["firenet-draft-id"], undefined);
});

test("createDraft posts the name and refreshes the list", async () => {
  const { get, calls } = bootDrafts();
  await get(`Drafts.createDraft("new-work")`);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/api/drafts"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/httpapi/web/drafts.test.js`
Expected: FAIL — `drafts.js` doesn't exist yet.

- [ ] **Step 3: Write `drafts.js`**

```js
"use strict";

// Drafts page: list your own drafts (or everyone's, for an admin), create,
// delete, review a draft's diff against its base version (with conflicts
// highlighted), and — admin only — confirm one into a new version.
const Drafts = (() => {
  let me = null;
  let drafts = [];
  let all = false;
  let selected = null;
  let diffs = [];

  const CHANGE_LABELS = { added: "добавлено", modified: "изменено", removed: "удалено" };

  function renderTable() {
    const tbody = document.getElementById("drafts-table").querySelector("tbody");
    tbody.innerHTML = "";
    drafts.forEach((d) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = d.name;
      const owner = document.createElement("td");
      owner.textContent = d.owner;
      const base = document.createElement("td");
      base.textContent = d.baseVersion;
      const status = document.createElement("td");
      status.textContent = d.status;
      const actions = document.createElement("td");

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "Открыть";
      openBtn.addEventListener("click", () => selectDraft(d));

      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.textContent = "Изменения";
      diffBtn.addEventListener("click", () => loadDiff(d));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "Удалить";
      delBtn.addEventListener("click", () => deleteDraft(d.id));

      actions.append(openBtn, diffBtn, delBtn);
      tr.append(name, owner, base, status, actions);
      tbody.append(tr);
    });
  }

  function renderDiff() {
    const panel = document.getElementById("diff-panel");
    if (!selected) { panel.hidden = true; return; }
    document.getElementById("diff-draft-name").textContent = "— " + selected.name;
    const body = document.getElementById("diff-body");
    body.innerHTML = "";
    diffs.forEach((e) => {
      const tr = document.createElement("tr");
      if (e.conflict) tr.className = "conflict-row";
      const kind = document.createElement("td");
      kind.textContent = e.kind;
      const key = document.createElement("td");
      key.textContent = e.key;
      const change = document.createElement("td");
      change.textContent = (CHANGE_LABELS[e.change] || e.change) + (e.conflict ? " (конфликт)" : "");
      tr.append(kind, key, change);
      body.append(tr);
    });
    document.getElementById("confirm-btn").hidden = !(me && me.role === "admin");
    panel.hidden = false;
  }

  async function refresh() {
    drafts = await Api.get("/api/drafts" + (all ? "?all=1" : ""));
    renderTable();
  }

  function selectDraft(draft) {
    setCurrentDraftID(draft.id);
    window.location.href = "/ui/topology";
  }

  async function loadDiff(draft) {
    selected = draft;
    try {
      diffs = await Api.get(`/api/drafts/${draft.id}/diff`);
      renderDiff();
    } catch (e) {
      showBanner("Не удалось загрузить изменения: " + e.message);
    }
  }

  // deleteDraft/confirmSelected use a raw fetch instead of Api: DELETE has
  // no request body to route through Api.post/put, and a 409 confirm
  // response carries {conflicts: [...]}, not Api's generic {error: "..."}
  // shape — the same move users.js already makes for its admin-only DELETE.
  async function deleteDraft(id) {
    const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
    if (res.status === 401) {
      window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
      return;
    }
    if (!res.ok) {
      showBanner("Не удалось удалить черновик: " + ((await res.json()).error || `HTTP ${res.status}`));
      return;
    }
    if (currentDraftID() === id) setCurrentDraftID(null);
    if (selected && selected.id === id) { selected = null; renderDiff(); }
    await refresh();
  }

  async function createDraft(name) {
    try {
      await Api.post("/api/drafts", { name });
      await refresh();
    } catch (e) {
      showBanner("Не удалось создать черновик: " + e.message);
    }
  }

  // confirmSelected submits the currently open diff's draft for admin
  // confirmation. A 409 means someone else confirmed a conflicting change
  // since the diff was loaded — re-fetch it so the now-current conflict
  // flags show, rather than building a second rendering path for the
  // (structurally different) conflict list the 409 body carries.
  async function confirmSelected() {
    if (!selected) return;
    const res = await fetch(`/api/drafts/${selected.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
      return;
    }
    if (res.status === 409) {
      showBanner("В черновике есть конфликты — проверьте их перед подтверждением.", "error");
      await loadDiff(selected);
      return;
    }
    if (!res.ok) {
      showBanner("Не удалось подтвердить черновик: " + ((await res.json()).error || `HTTP ${res.status}`));
      return;
    }
    const { version } = await res.json();
    showBanner(`Черновик подтверждён как версия ${version}`, "ok");
    selected = null;
    renderDiff();
    await refresh();
  }

  function wireForm() {
    const form = document.getElementById("create-draft-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = form.name.value.trim();
      if (!name) return;
      await createDraft(name);
      form.reset();
    });
    document.getElementById("all-checkbox").addEventListener("change", (e) => {
      all = e.target.checked;
      refresh();
    });
    document.getElementById("confirm-btn").addEventListener("click", confirmSelected);
  }

  async function boot() {
    wireForm();
    try {
      me = await Api.get("/api/me");
    } catch (e) {
      showBanner("Не удалось определить пользователя: " + e.message);
      return;
    }
    document.getElementById("all-toggle").hidden = me.role !== "admin";
    await refresh();
  }

  return {
    boot, refresh, selectDraft, loadDiff, deleteDraft, createDraft, confirmSelected,
    get me() { return me; },
    get drafts() { return drafts; },
    get selected() { return selected; },
    get diffs() { return diffs; },
  };
})();

document.addEventListener("DOMContentLoaded", Drafts.boot);
```

- [ ] **Step 4: Write `drafts.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firenet — черновики</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="drafts" data-no-draft-banner="true" x-data="appData()" @notify.window="showBanner($event.detail.message, $event.detail.kind)">
<main class="page">
  <h1>Черновики</h1>

  <label id="all-toggle" hidden><input type="checkbox" id="all-checkbox"> Показать черновики всех пользователей</label>

  <table id="drafts-table" class="data-table">
    <thead><tr><th>Название</th><th>Автор</th><th>База</th><th>Статус</th><th></th></tr></thead>
    <tbody></tbody>
  </table>

  <form id="create-draft-form">
    <label>Название <input type="text" name="name" required></label>
    <button type="submit">Создать черновик</button>
  </form>

  <section id="diff-panel" hidden>
    <h2>Изменения <span id="diff-draft-name"></span></h2>
    <table class="data-table">
      <thead><tr><th>Тип</th><th>Ключ</th><th>Изменение</th></tr></thead>
      <tbody id="diff-body"></tbody>
    </table>
    <button type="button" id="confirm-btn" hidden>Подтвердить</button>
  </section>
</main>
<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
<script src="/drafts.js"></script>
</body>
</html>
```

- [ ] **Step 5: Register the route and add conflict-row CSS**

`internal/httpapi/server.go`, next to the other `GET /ui/...` lines:
```go
	mux.HandleFunc("GET /ui/drafts", servePage("drafts.html"))
```

`internal/httpapi/web/style.css`, appended (the rest of the table styling comes from the existing `.data-table` class, already used by `users.html`):
```css
.conflict-row {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test internal/httpapi/web/drafts.test.js`
Expected: `pass 9`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/web/drafts.html internal/httpapi/web/drafts.js internal/httpapi/web/drafts.test.js internal/httpapi/web/style.css internal/httpapi/server.go
git commit -m "feat(web): add draft list, diff, and confirm UI"
```

---

### Task 9: Version history, diff, and restore UI

**Files:**
- Create: `internal/httpapi/web/history.html`, `history.js`, `history.test.js`
- Modify: `internal/httpapi/server.go`

**Interfaces:**
- Consumes: `Api.get/post`, `setCurrentDraftID`, `showBanner`, `confirm` (window) — all existing; `GET /api/versions?limit=50`, `GET /api/versions/diff?from={id}&to={id}`, `POST /api/versions/{id}/restore` (admin-gated route, confirmed in `server.go`).
- Produces: `const History = {...}` (same IIFE-controller pattern as Task 8's `Drafts`), with `boot()`, `refresh()`, `showDiff(id)`, `restore(id)`, and read-only getters `me`, `versions`, `selectedID`, `diffs`.
- `/ui/history` has `data-nav="history" data-no-draft-banner="true"`.

- [ ] **Step 1: Write the failing tests**

`internal/httpapi/web/history.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, hidden: false, _text: "",
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent || "").join(""); },
  };
  return el;
}

function bootHistory(fixture = {}) {
  const versions = fixture.versions ?? [
    { id: 5, createdAt: "2026-08-27T00:00:00Z", confirmedBy: "alice", note: "" },
    { id: 4, createdAt: "2026-08-26T00:00:00Z", confirmedBy: "alice", note: "" },
    { id: 3, createdAt: "2026-08-25T00:00:00Z", confirmedBy: "alice", note: "" },
  ];
  const me = fixture.me ?? { username: "root", role: "admin" };
  const diffs = fixture.diffs ?? [{ kind: "subnet", key: "a", change: "modified" }];
  const restoreVersion = fixture.restoreVersion ?? 6;

  const tbody = makeEl("tbody");
  const ids = {
    "history-table": Object.assign(makeEl("table"), { querySelector: () => tbody }),
    "diff-panel": makeEl("section"),
    "diff-version-label": makeEl("span"),
    "diff-body": makeEl("tbody"),
  };
  const doc = {
    listeners: {},
    getElementById: (id) => ids[id],
    createElement: (tag) => makeEl(tag),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
  };
  const store = {};
  const calls = [];
  const banners = [];
  const sandbox = {
    document: doc,
    window: { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    confirm: () => fixture.confirmResult ?? true,
    fetch: async (url, opts) => {
      calls.push({ path: url, method: opts?.method || "GET" });
      if (url === "/api/me") return { ok: true, status: 200, headers: { get: () => null }, json: async () => me };
      if (url === "/api/versions?limit=50") return { ok: true, status: 200, headers: { get: () => null }, json: async () => versions };
      if (url.startsWith("/api/versions/diff")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => diffs };
      if (/^\/api\/versions\/\d+\/restore$/.test(url)) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: restoreVersion }) };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "history.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  return { get: (expr) => vm.runInContext(expr, sandbox), ids, calls, banners, store };
}

test("boot loads the user and the version list", async () => {
  const { get } = bootHistory();
  await get("History.boot()");
  assert.equal(get("History.me").role, "admin");
  assert.equal(get("History.versions").length, 3);
});

test("showDiff compares a version to the immediately older one in the list", async () => {
  const { get, calls } = bootHistory();
  await get("History.boot()");
  await get("History.showDiff(4)");
  assert.ok(calls.some((c) => c.path === "/api/versions/diff?from=3&to=4"));
  assert.equal(get("History.diffs").length, 1);
});

test("showDiff on the oldest listed version diffs it against itself (nothing older known)", async () => {
  const { get, calls } = bootHistory();
  await get("History.boot()");
  await get("History.showDiff(3)");
  assert.ok(calls.some((c) => c.path === "/api/versions/diff?from=3&to=3"));
});

test("restore controls render only for an admin", async () => {
  const nonAdmin = bootHistory({ me: { username: "alice", role: "user" } });
  await nonAdmin.get("History.boot()");
  const naRow = nonAdmin.ids["history-table"].querySelector().children[0];
  assert.equal(naRow.children[4].children.length, 1, "non-admin sees only the diff button");

  const admin = bootHistory({ me: { username: "root", role: "admin" } });
  await admin.get("History.boot()");
  const adminRow = admin.ids["history-table"].querySelector().children[0];
  assert.equal(adminRow.children[4].children.length, 2, "admin sees diff + restore buttons");
});

test("restore posts to /api/versions/{id}/restore, clears the active draft, and refreshes", async () => {
  const { get, store, banners, calls } = bootHistory({ restoreVersion: 6 });
  store["firenet-draft-id"] = "d1";
  await get("History.boot()");
  await get("History.restore(3)");
  assert.ok(calls.some((c) => c.path === "/api/versions/3/restore" && c.method === "POST"));
  assert.equal(store["firenet-draft-id"], undefined);
  assert.ok(banners.some((b) => b.message.includes("версия 6")));
});

test("restore is a no-op when the confirmation dialog is declined", async () => {
  const { get, calls } = bootHistory({ confirmResult: false });
  await get("History.boot()");
  await get("History.restore(3)");
  assert.ok(!calls.some((c) => c.path === "/api/versions/3/restore"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/httpapi/web/history.test.js`
Expected: FAIL — `history.js` doesn't exist yet.

- [ ] **Step 3: Write `history.js`**

```js
"use strict";

// Version history: the confirmed-version list, a diff of any entry against
// the one immediately before it, and — admin only — restoring an older
// version (which creates a new version on top, never rewrites history).
const History = (() => {
  let me = null;
  let versions = [];
  let selectedID = null;
  let diffs = [];

  const CHANGE_LABELS = { added: "добавлено", modified: "изменено", removed: "удалено" };

  function renderList() {
    const tbody = document.getElementById("history-table").querySelector("tbody");
    tbody.innerHTML = "";
    versions.forEach((v) => {
      const tr = document.createElement("tr");
      const id = document.createElement("td");
      id.textContent = v.id;
      const created = document.createElement("td");
      created.textContent = v.createdAt;
      const confirmedBy = document.createElement("td");
      confirmedBy.textContent = v.confirmedBy || "";
      const note = document.createElement("td");
      note.textContent = v.note || "";
      const actions = document.createElement("td");

      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.textContent = "Дифф";
      diffBtn.addEventListener("click", () => showDiff(v.id));
      actions.append(diffBtn);

      if (me && me.role === "admin") {
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.textContent = "Восстановить";
        restoreBtn.addEventListener("click", () => restore(v.id));
        actions.append(restoreBtn);
      }

      tr.append(id, created, confirmedBy, note, actions);
      tbody.append(tr);
    });
  }

  function renderDiff() {
    const panel = document.getElementById("diff-panel");
    if (selectedID === null) { panel.hidden = true; return; }
    document.getElementById("diff-version-label").textContent = "— версия " + selectedID;
    const body = document.getElementById("diff-body");
    body.innerHTML = "";
    diffs.forEach((e) => {
      const tr = document.createElement("tr");
      const kind = document.createElement("td");
      kind.textContent = e.kind;
      const key = document.createElement("td");
      key.textContent = e.key;
      const change = document.createElement("td");
      change.textContent = CHANGE_LABELS[e.change] || e.change;
      tr.append(kind, key, change);
      body.append(tr);
    });
    panel.hidden = false;
  }

  async function refresh() {
    versions = await Api.get("/api/versions?limit=50");
    renderList();
  }

  // showDiff compares a version to the one immediately before it in this
  // (newest-first) list — the version's own predecessor isn't known to the
  // caller beyond what this list already shows. The oldest listed entry has
  // no older neighbor here, so it diffs against itself (an empty diff).
  async function showDiff(id) {
    const idx = versions.findIndex((v) => v.id === id);
    const from = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1].id : id;
    selectedID = id;
    try {
      diffs = await Api.get(`/api/versions/diff?from=${from}&to=${id}`);
      renderDiff();
    } catch (e) {
      showBanner("Не удалось загрузить изменения: " + e.message);
    }
  }

  async function restore(id) {
    if (!confirm(`Восстановить версию ${id}? Будет создана новая версия.`)) return;
    try {
      const result = await Api.post(`/api/versions/${id}/restore`, {});
      setCurrentDraftID(null);
      showBanner(`Создана версия ${result.version}`, "ok");
      await refresh();
    } catch (e) {
      showBanner("Не удалось восстановить версию: " + e.message);
    }
  }

  async function boot() {
    try {
      me = await Api.get("/api/me");
    } catch (e) {
      showBanner("Не удалось определить пользователя: " + e.message);
      return;
    }
    await refresh();
  }

  return {
    boot, refresh, showDiff, restore,
    get me() { return me; },
    get versions() { return versions; },
    get selectedID() { return selectedID; },
    get diffs() { return diffs; },
  };
})();

document.addEventListener("DOMContentLoaded", History.boot);
```

- [ ] **Step 4: Write `history.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firenet — история версий</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="history" data-no-draft-banner="true" x-data="appData()" @notify.window="showBanner($event.detail.message, $event.detail.kind)">
<main class="page">
  <h1>История версий</h1>

  <table id="history-table" class="data-table">
    <thead><tr><th>Версия</th><th>Дата</th><th>Подтвердил</th><th>Заметка</th><th></th></tr></thead>
    <tbody></tbody>
  </table>

  <section id="diff-panel" hidden>
    <h2>Изменения <span id="diff-version-label"></span></h2>
    <table class="data-table">
      <thead><tr><th>Тип</th><th>Ключ</th><th>Изменение</th></tr></thead>
      <tbody id="diff-body"></tbody>
    </table>
  </section>
</main>
<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
<script src="/history.js"></script>
</body>
</html>
```

- [ ] **Step 5: Register the route**

`internal/httpapi/server.go`, next to `GET /ui/drafts`:
```go
	mux.HandleFunc("GET /ui/history", servePage("history.html"))
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test internal/httpapi/web/history.test.js`
Expected: `pass 6`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/web/history.html internal/httpapi/web/history.js internal/httpapi/web/history.test.js internal/httpapi/server.go
git commit -m "feat(web): add version history, diff, and restore UI"
```

---

### Task 10: Verify the complete third part

**Files:**
- Modify only if a verification command identifies a concrete remaining defect.

- [ ] **Step 1: Scan for stale production URL literals**

Run:
```bash
rg -n '"/api/(topology|subnets|rules|layout|lint|diagnose|link-exports|compile)"' internal/httpapi/web --glob '!*.test.js'
```
Expected: no output — every production call site now goes through `apiPath(...)`.

```bash
rg -n '/ui/compile|compile_ui|compile\.gohtml' internal/httpapi internal/httpapi/web
```
Expected: no output.

- [ ] **Step 2: Run the full JavaScript suite**

Run: `node --test internal/httpapi/web/*.test.js 2>&1 | tail -20`
Expected: all tests pass, across every file touched by Tasks 0-9.

- [ ] **Step 3: Run mandatory Go verification in order**

Run each command separately:
```bash
go build ./...
go vet ./...
gofmt -l .
go test ./...
```
Expected: build, vet, and tests pass; `gofmt -l .` prints nothing. Postgres-backed tests skip cleanly if `FIRENET_TEST_DATABASE_URL` is unset (existing behavior from Plans 1-2, unchanged here).

- [ ] **Step 4: Manual smoke check (once, not per-change — per the project's `Общие правила`)**

```bash
go run . serve &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/ui/drafts
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/ui/history
kill %1
```
Expected: both print `200` (or `302`/`401` redirecting to `/login` if no session cookie is set — either is fine, it proves the routes exist and are wired, not 404).

- [ ] **Step 5: Commit only if a verification step required a fix**

```bash
git add internal/httpapi internal/httpapi/web
git commit -m "fix(web): address issues found during draft/version UI verification"
```

Create this commit only if Steps 1-4 required a correction; otherwise the preceding per-task commits are the final history.

## Self-Review Notes

- Tasks 0-3: API metadata for one draft (`GET /api/drafts/{id}`), the `sessionStorage`-backed draft-context primitives and CAS revision tracking, the read-only/draft banner shell, and the two new nav entries.
- Task 4: the banner shows the real current version number or the real active draft's name/status, reusing Task 2's classes and falling back to read-only if the draft has vanished.
- Tasks 5-6: every pre-existing page (topology, links, networks, sets, unions, subnets, rules, diagnose) is moved off the flat `/api/...` URLs Plan 2 removed, and every save path is guarded by `assertEditable()`.
- Task 7: compilation becomes draft-aware and the obsolete HTMX/template path is retired in favor of the JSON compile endpoints Plan 2 already shipped.
- Tasks 8-9: the drafts and history pages — both built as a testable IIFE-controller (matching `topology.js`/`diagnose.js`'s existing pattern, not the untestable `users.js` closure style) — cover the rest of the spec's "Web UI" bullet: create/delete/diff/confirm a draft, and browse/diff/restore version history.
- Task 10: enforces the project's required Go and Node verification order and confirms no old endpoint or HTMX reference survives.
