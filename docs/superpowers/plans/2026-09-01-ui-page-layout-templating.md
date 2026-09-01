# Shared UI Page-Layout Templating (subnets/unions pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the byte-for-byte-duplicated head/body/footer boilerplate in `web/subnets.html` and `web/unions.html` with a shared Go `html/template` layout, without changing rendered output or the sidebar mechanism.

**Architecture:** A second `embed.FS` (`templateFiles`) roots a new `internal/httpapi/templates/` directory that is never mounted on the static file server. `templates/layout.html` defines the shared `{{define "layout"}}` shell (head, `<body data-nav>`, footer scripts) with a `{{template "content" .}}` hole. Each pilot page gets its own `templates/{page}.html` defining `{{define "content"}}`, holding its old `<main>` block verbatim. `parsePageTemplates()` avoids Go's template-namespace collision (all `{{define "content"}}` blocks sharing one namespace if parsed together) by parsing `layout.html` once into a base template and `Clone()`-ing it per page before parsing that page's own content file into the clone. `serveTemplatedPage(tmpl, pageData)` replaces `servePage("subnets.html")`/`servePage("unions.html")` for exactly these two routes; every other page keeps using the existing `servePage`.

**Tech Stack:** Go 1.25 `html/template`, `embed.FS`, `net/http` (stdlib only — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-01-ui-page-layout-templating-design.md`

## Reuse analysis

- **Existing:** `internal/httpapi/embed.go` embeds one `embed.FS` (`webFiles`, root `web`). `internal/httpapi/server.go` has `servePage(name string) http.HandlerFunc` (reads one embedded file, writes it verbatim as `text/html`) and `noCache(root fs.FS, next http.Handler)` (ETag/no-cache wrapper applied only to the `mux.Handle("/", ...)` static-file-server mount). Test helpers `newTestServer(t)` and `doJSON(t, h, method, path, body)` already exist in `internal/httpapi/handlers_test.go` and are used by the existing `TestStaticAssetsNoCache` in `internal/httpapi/server_test.go`. A project-wide grep for `html/template`/`text/template` found zero hits — there is genuinely no server-side templating anywhere in this codebase today, confirming the spec's premise.
- **Reuse:** `newTestServer(t)` and `doJSON(...)` for the new HTTP-level test (Task 2) — no new test scaffolding needed. `TestStaticAssetsNoCache`'s request/assert shape is followed as the pattern for the new test's style (table-free, direct assertions), without copying its ETag-specific logic (irrelevant here — see Keep separate).
- **Extend:** None — `servePage` and `noCache` are not modified. The spec explicitly keeps `servePage` serving every non-pilot page unchanged and adds `serveTemplatedPage` alongside it, not in place of it, because the two have different jobs (verbatim byte passthrough of a static file vs. executing a template against per-route data).
- **New:** The second `embed.FS` (`templateFiles`), the `templates/` directory and its three files, `pageData`, `pageTemplateFiles`, `parsePageTemplates()`, `serveTemplatedPage()` — none of this exists yet.
- **Keep separate:** The sidebar (`buildNav()` in `common.js`) already lives in exactly one place — it is built client-side from `<body data-nav="...">` and injected into every page identically (`document.addEventListener("DOMContentLoaded", ...)` in `common.js`); there is no per-page sidebar markup to deduplicate, so this plan does not touch `common.js`. The `noCache`/ETag wrapper is deliberately not extended to `serveTemplatedPage`: it wraps only the static-file-server mount (`mux.Handle("/", noCache(webRoot, ...))`), keyed off reading the exact file from `webRoot` by URL path — templated pages have no corresponding on-disk file to hash, and the spec doesn't ask for this. Flagged here rather than silently decided: after this migration, `GET /ui/subnets` and `GET /ui/unions` will no longer send `ETag`/`Cache-Control: no-cache` (they didn't get it from `servePage` either — `servePage` predates and is separate from the `noCache` wrapper, which only wraps the `mux.Handle("/", ...)` file-server mount, not the `mux.HandleFunc("GET /ui/...", servePage(...))` routes) — so this is a no-op on caching behavior, not a regression.

## Global Constraints

- `internal/httpapi/templates/` must never be reachable over HTTP — it is a separate `embed.FS` from `webFiles` and must not be passed to `fs.Sub`/`http.FileServer`/`mux.Handle("/", ...)`.
- `parsePageTemplates()` must panic on a parse error via `template.Must`, matching the existing `fs.Sub(webFiles, "web")` panic-at-startup pattern in `NewServer` — build-time-embedded content fails at server boot/test-boot, never on a live request.
- Rendered output for `/ui/subnets` and `/ui/unions` must stay byte-for-byte equivalent to the current `web/subnets.html`/`web/unions.html` (same `<title>`, `data-nav`, `<main>` markup) — this is a pure server-side deduplication, no visual change.
- Automated tests only (per `CLAUDE.md`): no Playwright/manual-browser pass for this change.
- Out of scope (do not touch in this plan): the `<dialog class="modal">` skeleton extraction, any of the other 11 application pages (`networks`, `devices`, `sets`, `links`, `rules`, `users`, `topology`, `diagnose`, `compile`, `drafts`, `history`), and `login.html`/`invite.html` (different, simpler shell).

---

### Task 1: Shared layout/content templates + `parsePageTemplates()`

**Files:**
- Create: `internal/httpapi/templates/layout.html`
- Create: `internal/httpapi/templates/subnets.html`
- Create: `internal/httpapi/templates/unions.html`
- Modify: `internal/httpapi/embed.go`
- Modify: `internal/httpapi/server.go` (add `pageData`, `pageTemplateFiles`, `parsePageTemplates` — not wired into `NewServer` yet, that's Task 2)
- Test: `internal/httpapi/server_test.go`

**Interfaces:**
- Produces: `type pageData struct { Title, Nav, Script string }`; `func parsePageTemplates() map[string]*template.Template` returning a map keyed `"subnets"`/`"unions"`, each value executable via `tmpl.ExecuteTemplate(w, "layout", data)`. Task 2 consumes both.

- [x] **Step 1: Write the failing test**

Add to `internal/httpapi/server_test.go`:

```go
func TestParsePageTemplatesRenderDistinctContent(t *testing.T) {
	pages := parsePageTemplates()
	if _, ok := pages["subnets"]; !ok {
		t.Fatal(`parsePageTemplates()["subnets"] missing`)
	}
	if _, ok := pages["unions"]; !ok {
		t.Fatal(`parsePageTemplates()["unions"] missing`)
	}

	var subnetsOut, unionsOut bytes.Buffer
	if err := pages["subnets"].ExecuteTemplate(&subnetsOut, "layout", pageData{
		Title: "firenet — подсети", Nav: "subnets", Script: "subnets.js",
	}); err != nil {
		t.Fatalf("execute subnets template: %v", err)
	}
	if err := pages["unions"].ExecuteTemplate(&unionsOut, "layout", pageData{
		Title: "firenet — объединения", Nav: "unions", Script: "unions.js",
	}); err != nil {
		t.Fatalf("execute unions template: %v", err)
	}

	subnets, unions := subnetsOut.String(), unionsOut.String()

	// Regression guard for the shared-namespace pitfall: if layout.html and
	// both content files were parsed into one shared *template.Template,
	// the last-parsed "content" block would silently win for every page.
	if !strings.Contains(subnets, `x-data="subnetsPage"`) {
		t.Error("subnets render missing x-data=\"subnetsPage\"")
	}
	if strings.Contains(subnets, `x-data="unionsPage"`) {
		t.Error("subnets render leaked unions content block")
	}
	if !strings.Contains(unions, `x-data="unionsPage"`) {
		t.Error("unions render missing x-data=\"unionsPage\"")
	}
	if strings.Contains(unions, `x-data="subnetsPage"`) {
		t.Error("unions render leaked subnets content block")
	}

	if !strings.Contains(subnets, "<title>firenet — подсети</title>") {
		t.Error("subnets render missing expected <title>")
	}
	if !strings.Contains(subnets, `data-nav="subnets"`) {
		t.Error("subnets render missing data-nav=\"subnets\"")
	}
	if !strings.Contains(unions, "<title>firenet — объединения</title>") {
		t.Error("unions render missing expected <title>")
	}
	if !strings.Contains(unions, `data-nav="unions"`) {
		t.Error("unions render missing data-nav=\"unions\"")
	}
}
```

Add `"bytes"` and `"strings"` to the import block at the top of `internal/httpapi/server_test.go` (currently `"net/http"`, `"net/http/httptest"`, `"testing"`).

- [x] **Step 2: Run test to verify it fails**

Run: `go test ./internal/httpapi/... -run TestParsePageTemplatesRenderDistinctContent -v`
Expected: FAIL — compile error, `undefined: parsePageTemplates` (and `undefined: pageData`).

- [x] **Step 3: Create the layout template**

Create `internal/httpapi/templates/layout.html`:

```html
{{define "layout"}}<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>{{.Title}}</title>
<script>
  try {
    var saved = localStorage.getItem("firenet-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="{{.Nav}}" x-data="appData()" @notify.window="showBanner($event.detail.message, $event.detail.kind)">

{{template "content" .}}

<script type="module" src="/common.js"></script>
<script type="module" src="/{{.Script}}"></script>
<script src="/alpine.min.js" defer></script>
</body>
</html>
{{end}}
```

- [x] **Step 4: Create the subnets content template**

Create `internal/httpapi/templates/subnets.html` — the exact `<main>` block currently in `internal/httpapi/web/subnets.html` (lines 17–89), wrapped in `{{define "content"}}...{{end}}`:

```html
{{define "content"}}<main x-data="subnetsPage">
  <div class="table-toolbar">
    <div class="toolbar-text">
      <h3>Подсети</h3>
      <p class="hint">Подсеть — именованный CIDR-блок. Привязка к устройствам задаётся на странице «Топология» через сеть, в которую входит подсеть.</p>
    </div>
    <div class="toolbar-actions">
      <button type="button" class="secondary btn-search" @click="searchOpen = !searchOpen" title="Поиск по подсетям"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.25"/><path d="m13.2 13.2-4.3-4.3"/></svg></button>
      <button type="button" class="primary" @click="openAdd()">+ подсеть</button>
    </div>
  </div>
  <div class="table-wrap" x-show="loaded" x-cloak>
    <table class="data-table" x-ref="table">
      <colgroup>
        <col data-default-width="240" data-min-width="120">
        <col data-default-width="240" data-min-width="140">
        <col data-default-width="280" data-min-width="140">
        <col data-default-width="280" data-min-width="160">
        <col data-default-width="100" data-min-width="80">
      </colgroup>
      <thead>
        <tr><th>Имя</th><th>CIDR</th><th>Сеть</th><th>Описание</th><th></th></tr>
        <tr class="search-row" x-show="searchOpen" x-cloak>
          <th><input x-model.trim="filters.name" placeholder="поиск..."></th>
          <th><input x-model.trim="filters.cidr" placeholder="поиск..."></th>
          <th><input x-model.trim="filters.owner" placeholder="поиск..."></th>
          <th><input x-model.trim="filters.description" placeholder="поиск..."></th>
          <th><button type="button" class="icon-btn reset-search" title="Сбросить фильтры" @click="resetFilters()">&#10005;</button></th>
        </tr>
      </thead>
      <tbody>
        <template x-for="row in filteredRows" :key="row.row.name">
          <tr>
            <td x-text="row.row.name"></td>
            <td x-text="row.row.cidr"></td>
            <td>
              <span class="owner-badge" x-show="row.row.owner" x-text="row.row.owner"></span>
              <span class="hint" x-show="!row.row.owner">не входит ни в одну сеть</span>
            </td>
            <td>
              <span x-show="row.row.description" x-text="row.row.description"></span>
              <span class="hint" x-show="!row.row.description">—</span>
            </td>
            <td>
              <button type="button" class="icon-btn edit" title="Изменить" @click="openEdit(row.index)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.1a1.6 1.6 0 0 1 2.3 2.3L5.4 12.6l-3.1.8.8-3.1z"/></svg></button>
              <button type="button" class="icon-btn delete" title="Удалить" @click="removeRow(row.index)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11"/><path d="M5.5 4V2.7c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V4"/><path d="M3.5 4l.6 9.3c0 .4.4.7.8.7h6.2c.4 0 .8-.3.8-.7L12.5 4"/><path d="M6.5 6.8v4.4"/><path d="M9.5 6.8v4.4"/></svg></button>
            </td>
          </tr>
        </template>
        <tr x-show="loaded && !rows.length"><td colspan="5" class="empty-cell">Подсетей нет — добавьте первую</td></tr>
        <tr x-show="loaded && rows.length && !filteredRows.length"><td colspan="5" class="empty-cell">Ничего не найдено</td></tr>
      </tbody>
    </table>
  </div>

  <dialog x-ref="dialog" class="modal">
    <h3 x-text="draft.index >= 0 ? 'Изменить подсеть' : 'Новая подсеть'"></h3>
    <label>Имя
      <input x-model.trim="draft.name" placeholder="office-lan">
    </label>
    <label>CIDR
      <input x-model.trim="draft.cidr" placeholder="10.0.0.0/24">
    </label>
    <label>Описание
      <textarea x-model.trim="draft.description" rows="3" placeholder="Заметка о подсети"></textarea>
    </label>
    <p class="cell-hint" x-show="draftHint" x-text="draftHint"></p>
    <div class="modal-actions">
      <button type="button" @click="closeModal()">Отмена</button>
      <button type="button" class="primary" :disabled="!!draftHint || saving" @click="saveDraft()">Сохранить</button>
    </div>
  </dialog>
</main>{{end}}
```

- [x] **Step 5: Create the unions content template**

Create `internal/httpapi/templates/unions.html` — the exact `<main>` block currently in `internal/httpapi/web/unions.html` (lines 17–94), wrapped in `{{define "content"}}...{{end}}`:

```html
{{define "content"}}<main x-data="unionsPage">
  <div class="table-toolbar">
    <div class="toolbar-text">
      <h3>Объединения</h3>
      <p class="hint">Объединение — визуальная группировка устройств и сетей на холсте топологии: рамка с подписью вокруг членов группы. Здесь создаются, переименовываются и удаляются сами объединения; назначить объекты в объединение или исключить их можно в контекстном меню на холсте топологии.</p>
    </div>
    <div class="toolbar-actions">
      <button type="button" class="secondary btn-search" @click="searchOpen = !searchOpen" title="Поиск по объединениям"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.25"/><path d="m13.2 13.2-4.3-4.3"/></svg></button>
      <button type="button" class="primary" @click="openAdd()">+ объединение</button>
    </div>
  </div>
  <div class="table-wrap" x-show="loaded" x-cloak>
    <table class="data-table" x-ref="table">
      <colgroup>
        <col data-default-width="200" data-min-width="120">
        <col data-default-width="320" data-min-width="140">
        <col data-default-width="320" data-min-width="140">
        <col data-default-width="320" data-min-width="140">
        <col data-default-width="100" data-min-width="80">
      </colgroup>
      <thead>
        <tr><th>Имя</th><th>Устройства</th><th>Сети</th><th>Описание</th><th></th></tr>
        <tr class="search-row" x-show="searchOpen" x-cloak>
          <th><input x-model.trim="filters.name" placeholder="поиск..."></th>
          <th><input x-model.trim="filters.devices" placeholder="имя устройства"></th>
          <th><input x-model.trim="filters.networks" placeholder="имя сети или IP/CIDR" title="Имя сети, IP, CIDR или частичный адрес (10.0.) внутри её подсетей"></th>
          <th><input x-model.trim="filters.description" placeholder="поиск..."></th>
          <th><button type="button" class="icon-btn reset-search" title="Сбросить фильтры" @click="resetFilters()">&#10005;</button></th>
        </tr>
      </thead>
      <tbody>
        <template x-for="row in filteredUnions" :key="row.union.name">
          <tr>
            <td x-text="row.union.name"></td>
            <td>
              <template x-for="d in row.union.devices" :key="d">
                <span class="owner-badge" x-text="d"></span>
              </template>
              <span class="hint" x-show="!row.union.devices.length">нет устройств</span>
            </td>
            <td>
              <template x-for="n in row.union.networks" :key="n">
                <span class="owner-badge" x-text="n"></span>
              </template>
              <span class="hint" x-show="!row.union.networks.length">нет сетей</span>
            </td>
            <td>
              <span x-show="row.union.description" x-text="row.union.description"></span>
              <span class="hint" x-show="!row.union.description">—</span>
            </td>
            <td>
              <button type="button" class="icon-btn edit" title="Изменить" @click="openEdit(row.index)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.1a1.6 1.6 0 0 1 2.3 2.3L5.4 12.6l-3.1.8.8-3.1z"/></svg></button>
              <button type="button" class="icon-btn delete" title="Удалить" @click="removeUnion(row.index)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11"/><path d="M5.5 4V2.7c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V4"/><path d="M3.5 4l.6 9.3c0 .4.4.7.8.7h6.2c.4 0 .8-.3.8-.7L12.5 4"/><path d="M6.5 6.8v4.4"/><path d="M9.5 6.8v4.4"/></svg></button>
            </td>
          </tr>
        </template>
        <tr x-show="loaded && !unions.length"><td colspan="5" class="empty-cell">Объединений нет — добавьте первое</td></tr>
        <tr x-show="loaded && unions.length && !filteredUnions.length"><td colspan="5" class="empty-cell">Ничего не найдено</td></tr>
      </tbody>
    </table>
  </div>

  <dialog x-ref="dialog" class="modal">
    <h3 x-text="draft.index >= 0 ? 'Изменить объединение' : 'Новое объединение'"></h3>
    <label>Имя
      <input x-model.trim="draft.name" placeholder="office">
    </label>
    <label>Описание
      <textarea x-model.trim="draft.description" rows="3" placeholder="Заметка об объединении"></textarea>
    </label>
    <p class="cell-hint">Состав устройств и сетей назначается на холсте топологии через контекстное меню.</p>
    <p class="cell-hint" x-show="draftHint" x-text="draftHint"></p>
    <div class="modal-actions">
      <button type="button" @click="closeModal()">Отмена</button>
      <button type="button" class="primary" :disabled="!!draftHint || saving" @click="saveDraft()">Сохранить</button>
    </div>
  </dialog>
</main>{{end}}
```

- [x] **Step 6: Add the second `embed.FS`**

Modify `internal/httpapi/embed.go`:

```go
package httpapi

import "embed"

//go:embed web
var webFiles embed.FS

//go:embed templates
var templateFiles embed.FS
```

- [x] **Step 7: Add `pageData`, `pageTemplateFiles`, `parsePageTemplates`**

Modify `internal/httpapi/server.go` — add `"html/template"` to the import block, and add near `servePage`:

```go
var pageTemplateFiles = map[string]string{
	"subnets": "templates/subnets.html",
	"unions":  "templates/unions.html",
}

type pageData struct {
	Title  string
	Nav    string
	Script string
}

// parsePageTemplates parses layout.html once and Clone()s it per page before
// parsing that page's own content file into the clone. Parsing layout.html
// and every content file into one shared *template.Template would collide:
// every file's {{define "content"}} lands in the same namespace (Go
// template blocks aren't scoped per source file), so the last one parsed
// would silently win for every page's {{template "content" .}} call.
func parsePageTemplates() map[string]*template.Template {
	base := template.Must(template.ParseFS(templateFiles, "templates/layout.html"))
	pages := make(map[string]*template.Template, len(pageTemplateFiles))
	for name, file := range pageTemplateFiles {
		clone := template.Must(base.Clone())
		pages[name] = template.Must(clone.ParseFS(templateFiles, file))
	}
	return pages
}

// serveTemplatedPage renders a page parsed by parsePageTemplates. It
// replaces servePage only for routes migrated onto the shared layout;
// every other page keeps using servePage unchanged.
func serveTemplatedPage(tmpl *template.Template, data pageData) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := tmpl.ExecuteTemplate(w, "layout", data); err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
		}
	}
}
```

- [x] **Step 8: Run test to verify it passes**

Run: `go test ./internal/httpapi/... -run TestParsePageTemplatesRenderDistinctContent -v`
Expected: PASS

- [x] **Step 9: Run the full package test suite to check for regressions**

Run: `go test ./internal/httpapi/...`
Expected: PASS (all existing tests still green; `serveTemplatedPage` and the new routes aren't wired yet, so `web/subnets.html`/`web/unions.html` still serve `/ui/subnets`/`/ui/unions` unchanged)

- [x] **Step 10: Commit**

```bash
git add internal/httpapi/templates/ internal/httpapi/embed.go internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "feat(web): add shared page-layout templates for subnets/unions (not yet wired)"
```

---

### Task 2: Wire routes to `serveTemplatedPage`, delete standalone HTML, end-to-end test

**Files:**
- Modify: `internal/httpapi/server.go:81` (`GET /ui/subnets` route), `internal/httpapi/server.go:85` (`GET /ui/unions` route)
- Delete: `internal/httpapi/web/subnets.html`
- Delete: `internal/httpapi/web/unions.html`
- Test: `internal/httpapi/server_test.go`

**Interfaces:**
- Consumes: `parsePageTemplates() map[string]*template.Template`, `pageData{Title, Nav, Script string}`, `serveTemplatedPage(tmpl *template.Template, data pageData) http.HandlerFunc` — all from Task 1.

- [x] **Step 1: Write the failing test**

Add to `internal/httpapi/server_test.go`:

```go
func TestTemplatedPages(t *testing.T) {
	srv, _, _ := newTestServer(t)

	cases := []struct {
		path      string
		title     string
		nav       string
		xDataMark string
	}{
		{"/ui/subnets", "firenet — подсети", "subnets", `x-data="subnetsPage"`},
		{"/ui/unions", "firenet — объединения", "unions", `x-data="unionsPage"`},
	}

	for _, c := range cases {
		rec := doJSON(t, srv, http.MethodGet, c.path, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", c.path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Errorf("GET %s: Content-Type = %q, want \"text/html; charset=utf-8\"", c.path, ct)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "<title>"+c.title+"</title>") {
			t.Errorf("GET %s: body missing <title>%s</title>", c.path, c.title)
		}
		if !strings.Contains(body, `data-nav="`+c.nav+`"`) {
			t.Errorf("GET %s: body missing data-nav=%q", c.path, c.nav)
		}
		if !strings.Contains(body, c.xDataMark) {
			t.Errorf("GET %s: body missing %s", c.path, c.xDataMark)
		}
	}
}
```

(`"strings"` is already imported from Task 1's test; `doJSON`/`newTestServer` come from `internal/httpapi/handlers_test.go`.)

- [x] **Step 2: Run test to verify it fails**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: FAIL — `/ui/subnets`/`/ui/unions` still serve the old static `web/*.html` files verbatim, so this specific test should actually already pass on content assertions (the old files render the same markup). Confirm this by checking the failure reason if any is unexpected before proceeding; if it already passes unexpectedly, that's fine — proceed to Step 3, which changes *how* the page is served, not what it renders, and Step 4 will re-run this same test as the pass/regression check.

- [x] **Step 3: Wire the routes and delete the standalone HTML files**

Modify `internal/httpapi/server.go`: in `NewServer`, before the route registrations, call `parsePageTemplates()` once and replace the two `servePage` calls:

```go
	pages := parsePageTemplates()

	// Standalone UI pages.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ui/topology", http.StatusFound)
	})
	mux.HandleFunc("GET /login", servePage("login.html"))
	mux.HandleFunc("GET /invite/{token}", servePage("invite.html"))
	mux.HandleFunc("GET /ui/topology", servePage("topology.html"))
	mux.HandleFunc("GET /ui/subnets", serveTemplatedPage(pages["subnets"], pageData{
		Title: "firenet — подсети", Nav: "subnets", Script: "subnets.js",
	}))
	mux.HandleFunc("GET /ui/networks", servePage("networks.html"))
	mux.HandleFunc("GET /ui/devices", servePage("devices.html"))
	mux.HandleFunc("GET /ui/sets", servePage("sets.html"))
	mux.HandleFunc("GET /ui/unions", serveTemplatedPage(pages["unions"], pageData{
		Title: "firenet — объединения", Nav: "unions", Script: "unions.js",
	}))
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
	mux.HandleFunc("GET /ui/rules", servePage("rules.html"))
	mux.HandleFunc("GET /ui/compile", servePage("compile.html"))
	mux.HandleFunc("GET /ui/diagnose", servePage("diagnose.html"))
	mux.HandleFunc("GET /ui/users", servePage("users.html"))
	mux.HandleFunc("GET /ui/drafts", servePage("drafts.html"))
	mux.HandleFunc("GET /ui/history", servePage("history.html"))
```

Delete the now-unused standalone files:

```bash
git rm internal/httpapi/web/subnets.html internal/httpapi/web/unions.html
```

- [x] **Step 4: Run test to verify it passes**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: PASS

- [x] **Step 5: Run the full package test suite**

Run: `go test ./internal/httpapi/...`
Expected: PASS — including `TestStaticAssetsNoCache` (unaffected: it only requests `/common.js`, `/rules.js`, `/style.css`, `/favicon.svg`, none of which moved) and `TestParsePageTemplatesRenderDistinctContent` from Task 1.

- [x] **Step 6: Run the whole module's test suite**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: PASS — confirms nothing outside `internal/httpapi` referenced the deleted `web/subnets.html`/`web/unions.html` (the reuse analysis above already found no such references via grep, this is the final confirmation).

- [x] **Step 7: Commit**

```bash
git add internal/httpapi/server.go internal/httpapi/server_test.go
git add internal/httpapi/web/subnets.html internal/httpapi/web/unions.html
git commit -m "refactor(web): serve subnets/unions through the shared page-layout template"
```

---

## Self-review notes

- **Spec coverage:** "Architecture" (second `embed.FS`, `layout.html`/content files, `Clone()`-per-page) → Task 1. "Template data" (`pageData`, route wiring with literal `Title`/`Nav`/`Script` values) → Task 2 Step 3. "Error handling" (`template.Must` panic-at-startup) → Task 1 Step 7. "Testing" (Go test asserting 200/Content-Type/title/data-nav/x-data-marker for both routes, `TestStaticAssetsNoCache` unaffected, no Playwright) → Task 2 Steps 1–5. "Migration" 3-step list → mirrored across both tasks. "Non-goals" → carried into Global Constraints' out-of-scope line.
- **Placeholder scan:** No TBD/TODO markers; every step has literal code or an exact shell command.
- **Type consistency:** `pageData{Title, Nav, Script string}` used identically in Task 1's test and Task 2's route wiring; `parsePageTemplates() map[string]*template.Template` keys (`"subnets"`, `"unions"`) match `pageTemplateFiles`' keys and both tasks' usage; `serveTemplatedPage(tmpl *template.Template, data pageData) http.HandlerFunc` signature matches its Task 2 call sites.
