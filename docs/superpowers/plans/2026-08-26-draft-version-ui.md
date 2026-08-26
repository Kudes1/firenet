# Draft/Version UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web UI draft/version-aware — every existing page (topology, subnets, rules, networks, sets, unions, links, diagnose) reads/writes through the currently-selected draft (or the read-only current version), plus new pages to create/review/confirm drafts and browse version history.

**Architecture:** `common.js` gains a small draft-context layer (`currentDraftID`/`apiPath`/`isReadOnly`, backed by `sessionStorage` so each browser tab can hold a different draft) that every existing page's JS routes its `Api` calls through instead of the old flat `/api/topology`-style URLs, plus a persistent read-only banner with an "Open a draft" action. A small `GET /api/drafts/{id}` endpoint supplies active-draft metadata after reload. Two new pages, `drafts.html` and `history.html`, cover the rest of the spec's "Web UI" bullet: drafts list/create/delete/diff/confirm, and version history/diff/restore.

**Tech Stack:** Same vanilla JS + htmx/Alpine.js stack already in `internal/httpapi/web` — no new dependencies. Tests via `node --test` loading source through `vm.runInContext`, matching every existing `*_page.test.js`.

**Spec:** `docs/superpowers/specs/2026-08-26-multiuser-collab-design.md` ("Архитектура" → "Web UI" bullet: login page — done; "индикатор текущей версии в шапке (read-only, только 'Открыть черновик' для начала правок)", "страница черновиков с кнопкой «Отправить на подтверждение»", "страница истории версий (список + дифф)", "страница пользователей" — done). Implements the frontend half of `docs/superpowers/plans/2026-08-26-entity-versioning.md`'s API, which shipped with **no** frontend consumer — right now every existing page 404s against the old `/api/topology` etc. routes, since those routes no longer exist. This plan is what makes the web UI work again at all, not just a polish pass.

## Global Constraints

- Go 1.25. UI work is under `internal/httpapi/web`; `internal/httpapi/server.go` registers each standalone page by hand, `draft_handlers.go` exposes the active-draft metadata, and Task 5 removes the obsolete HTMX compile adapter.
- Follow existing conventions: `Api.get/post/put` + `showBanner` for fetch/error handling, `Alpine.data(...)` component pattern for the six list-editor pages (subnets/networks/sets/unions/links/rules), plain DOM manipulation for the canvas/diagnose pages and admin-style pages (topology, diagnose, users — `drafts.html`/`history.html` follow the `users.html`/`users.js` pattern), `node --test` + `vm.runInContext` for tests (see `internal/httpapi/web/sidebar.test.js`).
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

**Modified `internal/httpapi/web/style.css`**: `.draft-banner` styles.

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
- Produces: `function renderDraftBanner()`; wired into the existing `DOMContentLoaded` auto-init, opting out via `<body data-no-draft-banner="true">` (used by Task 6's `drafts.html`, Task 7's `history.html`, and the already-existing `users.html` — those pages manage drafts/versions directly, so the generic "you're read-only, open a draft" banner would just be confusing noise on top of what they already show).

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

### Task 4: Complete the banner metadata and switch all project pages to `apiPath`

**Files:**
- Modify: `internal/httpapi/web/common.js`, `style.css`
- Modify: `internal/httpapi/web/topology.js`, `links.js`, `subnets.js`, `networks.js`, `sets.js`, `unions.js`, `rules.js`, `diagnose.js`
- Modify: `internal/httpapi/web/topology_render.test.js`, `topology_search.test.js`, `links_page.test.js`, `subnets_page.test.js`, `networks_page.test.js`, `sets_page.test.js`, `unions_page.test.js`, `rules_page.test.js`, `diagnose_page.test.js`

**Interfaces:**
- The banner obtains version metadata from `GET /api/versions?limit=1` and draft metadata from `GET /api/drafts/{id}`.
- Every project resource request is `Api.{get,put,post}(apiPath(suffix), ...)`; saves call `assertEditable()` first.

- [ ] **Step 1: Extend the failing tests for final banner state and page paths**

Replace the Task 2 banner fixtures with `GET /api/versions?limit=1` → `[{ id: 7 }]` and `GET /api/drafts/draft-1` → `{ id: "draft-1", name: "office", status: "open" }`. Assert the exact visible context:

```js
assert.match(banner.textContent, /Версия 7.*только чтение/);
assert.equal(openLink.href, "/ui/drafts");
assert.match(banner.textContent, /Черновик «office».*open/);
```

For every page loader, add `sessionStorage` with draft ID `d1`; change its fetch fixture paths to the matching draft endpoints. Add one save test per editable page with no draft ID that checks no `PUT` was made and the captured banner contains `Только чтение`.

| Script | Required suffixes |
|---|---|
| `topology.js` | `topology`, `subnets`, `layout`, `link-exports?link=${i}&side=${side}` |
| `links.js` | `topology`, `subnets`, `link-exports?link=${i}&side=a`, `link-exports?link=${i}&side=b` |
| `subnets.js` | `subnets`, `topology` |
| `networks.js`, `sets.js`, `unions.js` | `topology`, `subnets` |
| `rules.js` | `rules`, `topology`, `subnets`, `lint` |
| `diagnose.js` | `topology`, `subnets`, `layout`, `diagnose` |

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/httpapi/web/topology_render.test.js internal/httpapi/web/links_page.test.js internal/httpapi/web/rules_page.test.js internal/httpapi/web/diagnose_page.test.js`

Expected: FAIL because scripts still call flat `/api/...` paths and do not guard saves.

- [ ] **Step 3: Implement final banner metadata**

Replace Task 2's `renderDraftBanner` body with this asynchronous behavior; the `DOMContentLoaded` callback calls it with `void renderDraftBanner().catch((err) => showBanner(err.message, "error"))` after `buildNav`:

```js
async function renderDraftBanner() {
  if (document.body.dataset.noDraftBanner === "true") return;
  const banner = document.createElement("div");
  banner.className = "draft-banner";
  const id = currentDraftID();
  if (!id) {
    const [version] = await Api.get("/api/versions?limit=1");
    banner.textContent = `Версия ${version?.id ?? "—"} · только чтение`;
    const open = document.createElement("a");
    open.href = "/ui/drafts";
    open.textContent = "Открыть черновик";
    banner.append(" ", open);
  } else {
    const draft = await Api.get(`/api/drafts/${id}`);
    banner.textContent = `Черновик «${draft.name}» · ${draft.status}`;
    const leave = document.createElement("button");
    leave.type = "button";
    leave.textContent = "К текущей версии";
    leave.addEventListener("click", () => { setCurrentDraftID(null); window.location.reload(); });
    banner.append(" ", leave);
  }
  document.body.prepend(banner);
}
```

Add `data-no-draft-banner="true"` to `users.html` and preserve the same marker on the management pages from Tasks 6–7.

- [ ] **Step 4: Make the URL and edit-guard changes**

For every entry in the table, replace each literal request with `apiPath`. A representative save becomes:

```js
assertEditable();
const doc = await Api.put(apiPath("topology"), next);
```

Put `assertEditable()` at the beginning of every save/mutating callback, including topology's debounced layout save, before state mutation. Catch `ReadOnlyError` in each page's existing error path and pass `err.message` to `showBanner`. Do not guard initial reads, lint, validation, link exports, or diagnose, because they are valid for the confirmed version.

- [ ] **Step 5: Run the converted page tests**

Run: `node --test internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js internal/httpapi/web/links_page.test.js internal/httpapi/web/subnets_page.test.js internal/httpapi/web/networks_page.test.js internal/httpapi/web/sets_page.test.js internal/httpapi/web/unions_page.test.js internal/httpapi/web/rules_page.test.js internal/httpapi/web/diagnose_page.test.js internal/httpapi/web/draft_banner.test.js`

Expected: PASS. Requests in editable fixtures start `/api/drafts/d1/`; read-only fixtures do not issue `PUT`.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/style.css internal/httpapi/web/users.html internal/httpapi/web/topology.js internal/httpapi/web/links.js internal/httpapi/web/subnets.js internal/httpapi/web/networks.js internal/httpapi/web/sets.js internal/httpapi/web/unions.js internal/httpapi/web/rules.js internal/httpapi/web/diagnose.js internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js internal/httpapi/web/links_page.test.js internal/httpapi/web/subnets_page.test.js internal/httpapi/web/networks_page.test.js internal/httpapi/web/sets_page.test.js internal/httpapi/web/unions_page.test.js internal/httpapi/web/rules_page.test.js internal/httpapi/web/diagnose_page.test.js internal/httpapi/web/draft_banner.test.js
git commit -m "feat(web): route editors through the active draft"
```

---

### Task 5: Make compilation context-aware and remove the obsolete HTMX adapter

**Files:**
- Create: `internal/httpapi/web/compile.js`, `internal/httpapi/web/compile.test.js`
- Modify: `internal/httpapi/web/compile.html`, `internal/httpapi/server.go`
- Delete: `internal/httpapi/compile_ui.go`, `internal/httpapi/compile_ui_test.go`, `internal/httpapi/templates/compile.gohtml`

**Interfaces:**
- Compile posts `Api.post(apiPath("compile"), {})` and renders the current Go JSON shape `{ Name, IPSetsScript, RulesScript }` into `#compile-output`.
- `POST /ui/compile` is removed; no production UI uses HTMX for compilation.

- [ ] **Step 1: Write the failing compile test**

Create a DOM/fetch loader equivalent to the existing page tests. It sets active draft `d1`, clicks `#compile-run`, and asserts:

```js
assert.equal(calls[0].path, "/api/drafts/d1/compile");
assert.equal(calls[0].method, "POST");
assert.match(output.textContent, /r1\.ipsets\.restore/);
assert.match(output.textContent, /r1\.rules\.sh/);
```

Add a second case without a draft ID expecting `/api/versions/current/compile`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/httpapi/web/compile.test.js`

Expected: FAIL because `compile.js` is absent.

- [ ] **Step 3: Replace the HTMX form with a JSON renderer**

In `compile.html`, replace `hx-post` with `<button id="compile-run" class="primary">Скомпилировать</button>`, remove `htmx.min.js`, and load `compile.js` after `common.js`. Implement:

```js
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

`renderDevice` creates headings, `pre` nodes with `textContent`, and Blob download links named `${device.Name}.ipsets.restore` and `${device.Name}.rules.sh`; it must not interpolate compiler output through `innerHTML`.

Remove `mux.HandleFunc("POST /ui/compile", h.uiCompile)`, then remove its handler, test, and template.

- [ ] **Step 4: Verify and commit**

Run: `node --test internal/httpapi/web/compile.test.js && go test ./internal/httpapi -count=1`

Expected: PASS; no source or test references `/ui/compile`.

```bash
git add internal/httpapi/web/compile.js internal/httpapi/web/compile.test.js internal/httpapi/web/compile.html internal/httpapi/server.go
git rm internal/httpapi/compile_ui.go internal/httpapi/compile_ui_test.go internal/httpapi/templates/compile.gohtml
git commit -m "feat(web): compile the selected project context"
```

---

### Task 6: Add draft creation, review, and confirmation UI

**Files:**
- Create: `internal/httpapi/web/drafts.html`, `drafts.js`, `drafts.test.js`
- Modify: `internal/httpapi/server.go`, `internal/httpapi/web/style.css`

**Interfaces:**
- `/ui/drafts` has `data-nav="drafts" data-no-draft-banner="true"`.
- It consumes `GET /api/me`, `GET /api/drafts[?all=1]`, `POST /api/drafts`, `DELETE /api/drafts/{id}`, `GET /api/drafts/{id}/diff`, and `POST /api/drafts/{id}/confirm`.

- [ ] **Step 1: Write failing controller tests**

Use the `users.js` DOM style and test the three essential flows:

```js
test("selecting a draft persists its id only in session storage", async () => {
  const { page, store, location } = await bootDrafts();
  page.selectDraft({ id: "d1", name: "office", status: "open" });
  assert.equal(store["firenet-draft-id"], "d1");
  assert.equal(location.href, "/ui/topology");
});

test("admin confirm renders 409 conflicts without changing selection", async () => {
  const { page } = await bootDrafts({ confirmStatus: 409 });
  await page.confirmDraft({ id: "d1" });
  assert.equal(page.selected.id, "d1");
  assert.equal(page.conflicts[0].key, "r1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/httpapi/web/drafts.test.js`

Expected: FAIL because the page controller is absent.

- [ ] **Step 3: Implement the page**

The HTML contains a create form, an own/all toggle, a drafts table, a selected-draft diff table, and a conflicts panel. The controller maintains `me`, `drafts`, `selected`, `diffs`, `conflicts`, and `all`. Its core operations are:

```js
async function refresh() { state.drafts = await Api.get("/api/drafts" + (state.all ? "?all=1" : "")); }
function selectDraft(draft) { setCurrentDraftID(draft.id); window.location.href = "/ui/topology"; }
async function loadDiff(draft) { state.selected = draft; state.diffs = await Api.get(`/api/drafts/${draft.id}/diff`); state.conflicts = []; }
```

Show the all toggle and confirm button only if `me.role === "admin"`. On successful confirmation, clear a matching active draft ID, show `version`, and refresh. On `err.status === 409`, retain `selected` and assign `state.conflicts = err.data.conflicts || []`; other failures use `showBanner(err.message, "error")`. Diff and conflict JSON use `JSON.stringify(value, null, 2)` through `textContent`.

Register `mux.HandleFunc("GET /ui/drafts", servePage("drafts.html"))`. Add `.management-grid`, `.diff-json`, `.conflict-row`, `.status-badge`, and narrow-screen table overflow styles using existing CSS variables.

- [ ] **Step 4: Verify and commit**

Run: `node --test internal/httpapi/web/drafts.test.js`

Expected: PASS.

```bash
git add internal/httpapi/web/drafts.html internal/httpapi/web/drafts.js internal/httpapi/web/drafts.test.js internal/httpapi/web/style.css internal/httpapi/server.go
git commit -m "feat(web): add draft creation and review UI"
```

---

### Task 7: Add version history, diff, and restore UI

**Files:**
- Create: `internal/httpapi/web/history.html`, `history.js`, `history.test.js`
- Modify: `internal/httpapi/server.go`, `internal/httpapi/web/style.css`

**Interfaces:**
- `/ui/history` has `data-nav="history" data-no-draft-banner="true"`.
- It consumes `GET /api/me`, `GET /api/versions?limit=50`, `GET /api/versions/diff?from={id}&to={id}`, and `POST /api/versions/{id}/restore`.

- [ ] **Step 1: Write failing history tests**

```js
test("a selected version is compared to the immediately older version", async () => {
  const { page, calls } = await bootHistory([{ id: 5 }, { id: 4 }, { id: 3 }]);
  await page.showDiff(4);
  assert.equal(calls.at(-1).path, "/api/versions/diff?from=3&to=4");
});

test("admin restore clears the active draft and refreshes history", async () => {
  const { page, store } = await bootHistory([{ id: 2 }], { role: "admin", activeDraft: "d1" });
  await page.restore(2);
  assert.equal(store["firenet-draft-id"], undefined);
  assert.ok(page.versions.length > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test internal/httpapi/web/history.test.js`

Expected: FAIL because the page controller is absent.

- [ ] **Step 3: Implement the page and admin restore flow**

Load `me` and history in parallel. `showDiff(to)` picks the next element in the newest-first array as `from`, shows a hint for the oldest entry, and supports a two-version selector for non-adjacent comparison. Render JSON diff values through `textContent`. Restore uses:

```js
async function restore(id) {
  if (!confirm(`Восстановить версию ${id}? Будет создана новая версия.`)) return;
  try {
    const result = await Api.post(`/api/versions/${id}/restore`, {});
    setCurrentDraftID(null);
    showBanner(`Создана версия ${result.version}`, "ok");
    await refresh();
  } catch (err) { showBanner(err.message, "error"); }
}
```

Only an admin sees restore controls; all authenticated users can view history and diffs. Register `mux.HandleFunc("GET /ui/history", servePage("history.html"))` and reuse Task 6's management/diff styles.

- [ ] **Step 4: Verify and commit**

Run: `node --test internal/httpapi/web/history.test.js`

Expected: PASS.

```bash
git add internal/httpapi/web/history.html internal/httpapi/web/history.js internal/httpapi/web/history.test.js internal/httpapi/web/style.css internal/httpapi/server.go
git commit -m "feat(web): add version history and restore UI"
```

---

### Task 8: Verify the complete third part

**Files:**
- Modify only if a verification command identifies a concrete remaining defect.

- [ ] **Step 1: Scan for stale production routes**

Run:

```bash
rg -n '/api/(topology|subnets|rules|layout|lint|diagnose|link-exports)|/ui/compile' internal/httpapi/web internal/httpapi --glob '!*.test.js'
```

Expected: no output.

- [ ] **Step 2: Run the full JavaScript suite**

Run: `node --test 'internal/httpapi/web/*.test.js'`

Expected: all tests pass, including draft context, banner, compile, drafts, and history.

- [ ] **Step 3: Run mandatory Go verification in order**

Run each command separately:

```bash
go build ./...
go vet ./...
gofmt -l .
go test ./...
```

Expected: build, vet, and tests pass; `gofmt -l .` prints nothing. Database tests may skip if `FIRENET_TEST_DATABASE_URL` is absent.

- [ ] **Step 4: Commit only any verification corrections**

```bash
git add internal/httpapi
git commit -m "test(web): verify draft and version UI integration"
```

Create this commit only if Steps 1–3 required a correction; otherwise keep the preceding feature commits as the final history.

## Self-Review Notes

- Tasks 0–3 establish API metadata, tab state, CAS, the context banner, and navigation.
- Task 4 moves every pre-existing working page to the implemented backend contract and blocks writes outside a draft.
- Task 5 removes the last incompatible HTMX route; Tasks 6–7 deliver the requested draft and version workflows.
- Task 8 enforces the project's required Go and Node verification order and ensures no old endpoint survives as a compatibility path.
