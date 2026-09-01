# Migrate Remaining UI Pages onto Shared Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining 11 application pages (`networks`, `devices`, `sets`, `links`, `rules`, `compile`, `diagnose`, `users`, `drafts`, `history`, `topology`) onto the shared `html/template` layout already built and proven on the `subnets`/`unions` pilot, deleting their standalone `web/*.html` files.

**Architecture:** No new mechanism — this plan is almost entirely reuse of what the pilot already built and reviewed clean: `templates/layout.html`, `parsePageTemplates()`, `mustPageTemplate()`, `serveTemplatedPage()`, the `templatedPages` table, and the `TestTemplatedPages`/`assertLayoutInvariants` test scaffolding (`internal/httpapi/server.go`, `internal/httpapi/server_test.go`). Each page's `<main>...</main>` block moves verbatim into its own `templates/{page}.html` content file, one `templatedPages` entry is added per page (file + `pageData{Title, Nav, Script}`, all values read directly off the existing static file — no invention), its route switches from `servePage(...)` to `serveTemplatedPage(mustPageTemplate(pages, name), templatedPages[name].data)`, and the old `web/{page}.html` is deleted. Two pages (`diagnose`, and `drafts`/`history`) need one small one-time adjustment each before they fit the plain pattern — see Rulings below.

**Tech Stack:** Go 1.25 `html/template` (unchanged from the pilot) — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-ui-page-layout-templating-design.md` (the original pilot spec; its own "Non-goals / open follow-ups" section explicitly names this work: *"Migrating the remaining ~11 application pages onto the layout (separate follow-up commits, one or a few pages at a time)"*). This plan is that follow-up.

## Reuse analysis

- **Existing:** `templates/layout.html`, `parsePageTemplates()`, `mustPageTemplate()`, `serveTemplatedPage()`, `pageData`, `templatedPage`/`templatedPages` (`internal/httpapi/server.go`), and `TestParsePageTemplatesRenderDistinctContent`, `TestTemplatedPages`, `assertLayoutInvariants` (`internal/httpapi/server_test.go`) — all built and reviewed clean (task review + final whole-branch review, both "Ready to merge: Yes") during the `subnets`/`unions` pilot, then further hardened (boot-time panic on escape errors and on a typo'd lookup, one `templatedPages` table instead of two, shared layout-invariants test) in the pilot's minor-findings follow-up.
- **Reuse:** All of the above, unchanged in mechanism. `TestTemplatedPages`'s table-driven shape is extended with one row per newly migrated page — reusing an established pattern, not inventing a new one. Every page's exact `<title>`, `data-nav`, and script filename are read directly off its existing `web/{page}.html` — no new naming scheme.
- **Extend:** `templates/layout.html` gains one line (a `<meta name="viewport">` tag, Task 1) — this is a deliberate, scoped extension of the *shared* shell (see Ruling 3 below), not a new mechanism. `assertLayoutInvariants` gains one marker for the same reason.
- **New:** 11 content template files (`templates/networks.html` … `templates/topology.html`), 11 `templatedPages` entries, 11 route-registration edits, 11 `web/*.html` deletions, one relocation of `diagnose.html`'s two inline CSS rules into the existing shared `#topo-canvas, #diag-canvas` section of `web/style.css` (`internal/httpapi/web/style.css:286-288`).
- **Keep separate:** `login.html`/`invite.html` — different, simpler shell (no theme script, no Alpine/common.js footer), never proposed for this layout; unaffected. The `<dialog class="modal">` edit-modal skeleton repeated across the CRUD pages stays a separate, explicitly out-of-scope future extraction (per the original spec).

## Rulings (from this session, before writing this plan)

1. **`diagnose.html`'s inline `<style>` (its `<head>` has one, no other remaining page does):** user's explicit choice — relocate `#diag-canvas { inset: 0; width: 100%; height: 100%; }` and `#diag-fit { position: absolute; top: var(--space-2); right: var(--space-2); z-index: 2; }` into `internal/httpapi/web/style.css`, right after the existing shared rule at `style.css:288` (`#topo-canvas, #diag-canvas { touch-action: none; }`) — that section already exists specifically for the topology/diagnose canvas pair. `diagnose.html` then needs no per-page `<head>` hook and fits the plain layout exactly like every other page. Cost if wrong: a CSS regression on the diagnose page's canvas positioning — cheap to spot and revert (2 lines).
2. **`drafts.html`/`history.html`'s different shell** (no anti-flash theme script, `<link rel="icon" href="/favicon.svg">` without `type="image/svg+xml"`, no blank-line spacing around `<main>`): user's explicit choice — normalize onto the standard shell. Concretely: they gain the anti-flash theme script (this *fixes* an existing flash-of-wrong-theme bug they currently have in dark mode — every other page already has this script), the favicon link gains `type="image/svg+xml"` (cosmetic, same file, no behavior change), and whitespace around their `<main>` changes to match the shared layout's blank-line convention (cosmetic only — HTML whitespace between block elements is not rendered). Cost if wrong: two rarely-touched utility pages render with slightly different (arguably corrected) `<head>` — cheap to spot in the e2e specs and revert.
3. **Controller ruling (not asked separately — a reasoned default, not a stall):** rather than dropping `drafts.html`/`history.html`'s `<meta name="viewport" content="width=device-width, initial-scale=1">` to match what `subnets`/`unions`/every other page currently lacks, promote that meta tag into `templates/layout.html` itself (Task 1) so **every** page — the 11 being migrated here and the already-migrated `subnets`/`unions` — gains correct mobile-viewport behavior. A shell-wide concern belongs in the shared shell, and this is a net improvement, not a loss, for the two pages that already had it. Cost if wrong: an unwanted mobile-viewport behavior change across 13 pages — trivially revertable (delete one line from `templates/layout.html`).

## Global Constraints

- `internal/httpapi/templates/` must never be reachable over HTTP (already true; this plan only adds files under it, no new mounts).
- Every `parsePageTemplates()`/`mustPageTemplate()` guarantee from the pilot (panic at server construction on a parse error, an escaping error, or a typo'd `templatedPages`/route-registration name) applies unchanged to every page added here — nothing in this plan bypasses that path.
- Every migrated page's `<main>...</main>` block must be copied byte-for-byte from its current `web/{page}.html` into `templates/{page}.html` — **except** the three explicitly-ruled deviations above, which are the only intentional output changes in this whole plan. Verify each extraction with the diff command each task specifies before moving on.
- Automated tests only (per `CLAUDE.md`): no Playwright/manual-browser pass for this change.
- Out of scope (do not touch): `login.html`, `invite.html`, and the `<dialog class="modal">` skeleton extraction.
- No literal `{{`/`}}` sequences exist in any of the 11 remaining pages (verified: `grep -c '{{' web/*.html` → 0 for all of them), so no page needs escaping or special handling to become a Go template content block.
- Migrate in small groups, each task independently testable and committed on its own — mirrors both the original spec's own stated intent and how `floating_panel.js`/`table.js` were rolled out incrementally in this codebase.

---

### Task 1: Shared-layout viewport meta + test-scaffolding prep

**Files:**
- Modify: `internal/httpapi/templates/layout.html`
- Modify: `internal/httpapi/server_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `assertLayoutInvariants` now also checks for the viewport meta tag (all later tasks' pages get this check for free). `TestTemplatedPages`'s per-case struct field is renamed `xDataMark` → `marker` (still a `string`, still checked via `strings.Contains`) so later tasks can use a non-`x-data` marker (an `id="..."` attribute) for pages whose `<main>` has no `x-data`.

- [x] **Step 1: Write the failing/updated test**

In `internal/httpapi/server_test.go`, rename the `TestTemplatedPages` case struct's `xDataMark` field to `marker` (and its use in the loop from `c.xDataMark` to `c.marker`) — purely mechanical rename, both existing cases (`subnets`, `unions`) keep their current `x-data="..."` values as `marker`. Then add the viewport check to `assertLayoutInvariants`:

```go
func assertLayoutInvariants(t *testing.T, path, body string) {
	t.Helper()
	for _, marker := range []string{
		"<!doctype html>",
		`name="viewport" content="width=device-width, initial-scale=1"`,
		`href="/favicon.svg"`,
		`href="/style.css"`,
		`src="/common.js"`,
		`src="/alpine.min.js"`,
		`x-data="appData()"`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("GET %s: body missing shared layout marker %q", path, marker)
		}
	}
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: FAIL — `assertLayoutInvariants` reports both `/ui/subnets` and `/ui/unions` bodies missing the viewport marker (the shared layout doesn't emit it yet).

- [x] **Step 3: Add the viewport meta to the shared layout**

In `internal/httpapi/templates/layout.html`, insert one line right after `<meta charset="utf-8">` and before `<title>{{.Title}}</title>`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

- [x] **Step 4: Run test to verify it passes**

Run: `go test ./internal/httpapi/... -run 'TestTemplatedPages|TestParsePageTemplatesRenderDistinctContent' -v`
Expected: PASS (both).

- [x] **Step 5: Run the full package suite**

Run: `go test ./internal/httpapi/...` (needs `FIRENET_TEST_DATABASE_URL` — see the pilot's Task 2 report for how to stand up a disposable throwaway Postgres container if the project's own DB has no host port exposed; tear it down after).
Expected: PASS, no regressions.

- [x] **Step 6: Commit**

```bash
git add internal/httpapi/templates/layout.html internal/httpapi/server_test.go
git commit -m "feat(web): add viewport meta to shared page layout"
```

---

### Task 2: Migrate `diagnose.html` (CSS relocation + migration)

**Files:**
- Modify: `internal/httpapi/web/style.css`
- Modify: `internal/httpapi/web/diagnose.html` → then delete (Step 4)
- Create: `internal/httpapi/templates/diagnose.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`

**Interfaces:**
- Consumes: `templatedPage{file, data pageData}`, `templatedPages map[string]templatedPage`, `mustPageTemplate`, `serveTemplatedPage`, `assertLayoutInvariants` — all from the pilot/Task 1, unchanged signatures.

- [x] **Step 1: Relocate diagnose's inline CSS**

In `internal/httpapi/web/style.css`, after line 288 (`#topo-canvas, #diag-canvas { touch-action: none; }`), insert:

```css
#diag-canvas { inset: 0; width: 100%; height: 100%; }
#diag-fit { position: absolute; top: var(--space-2); right: var(--space-2); z-index: 2; }
```

These are the exact two rules currently inline in `web/diagnose.html`'s `<head>` (lines 14-16) — moved verbatim, not rewritten.

- [x] **Step 2: Extract the content template**

`web/diagnose.html`'s `<main>...</main>` block is lines 21-110 (of the file *before* Step 1/Step 3 changes — re-check with `grep -n '<main\|^</main>' internal/httpapi/web/diagnose.html` if line numbers have shifted). Create `internal/httpapi/templates/diagnose.html`:

```bash
{ echo '{{define "content"}}'; sed -n '21,110p' internal/httpapi/web/diagnose.html; echo '{{end}}'; } > internal/httpapi/templates/diagnose.html
```

Then hand-fix the boundaries so the file reads exactly:
- First line: `{{define "content"}}<main>` (merge the `{{define}}` marker onto the same line as the extracted `<main>` opening tag, matching the pilot templates' style — see `templates/subnets.html` for the pattern)
- Last line: `</main>{{end}}` (merge the closing `{{end}}` onto the same line as `</main>`)

Verify with:
```bash
diff <(sed -n '2,$p' internal/httpapi/templates/diagnose.html | sed '$d') <(sed -n '21,110p' internal/httpapi/web/diagnose.html | sed '1s/^<main>$//' | sed '$s/^<\/main>$//')
```
(if that diff command is awkward in practice, a simpler manual check is sufficient: open both files side by side and confirm every line between the first and last is byte-identical, and the first/last lines only differ by the added `{{define "content"}}`/`{{end}}` wrapper text)

- [x] **Step 3: Remove diagnose.html's now-relocated inline `<style>` block**

Not needed as a separate edit — the whole file is deleted in Step 4. (This step exists only to confirm: do NOT leave `web/diagnose.html` half-edited; it is either the original file until deletion, or gone.)

- [x] **Step 4: Wire the route and delete the old file**

In `internal/httpapi/server.go`, add to `templatedPages`:

```go
"diagnose": {file: "templates/diagnose.html", data: pageData{Title: "firenet — диагностика", Nav: "diagnose", Script: "diagnose.js"}},
```

Change the route registration from:
```go
mux.HandleFunc("GET /ui/diagnose", servePage("diagnose.html"))
```
to:
```go
mux.HandleFunc("GET /ui/diagnose", serveTemplatedPage(mustPageTemplate(pages, "diagnose"), templatedPages["diagnose"].data))
```

Delete the old file:
```bash
git rm internal/httpapi/web/diagnose.html
```

- [x] **Step 5: Add the test case**

In `internal/httpapi/server_test.go`, add to `TestTemplatedPages`'s `cases` slice:

```go
{"/ui/diagnose", "firenet — диагностика", "diagnose", `id="diag-canvas"`},
```

- [x] **Step 6: Run tests**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: PASS, including the new `/ui/diagnose` case and `assertLayoutInvariants` for it.

Run: `go test ./internal/httpapi/...`
Expected: PASS, no regressions (needs `FIRENET_TEST_DATABASE_URL`).

Run: `go build ./... && go vet ./...`
Expected: clean (style.css has no Go build step, but confirm no stray references to the deleted file: `grep -rn "diagnose.html" internal/httpapi/*.go internal/httpapi/web/*.js` should show nothing).

- [x] **Step 7: Commit**

```bash
git add internal/httpapi/web/style.css internal/httpapi/templates/diagnose.html internal/httpapi/server.go internal/httpapi/server_test.go
git rm internal/httpapi/web/diagnose.html 2>/dev/null || true
git commit -m "refactor(web): migrate diagnose.html onto the shared page layout"
```

---

### Task 3: Migrate `compile.html`, `history.html`, `drafts.html` (small pages)

**Files:**
- Create: `internal/httpapi/templates/compile.html`, `internal/httpapi/templates/history.html`, `internal/httpapi/templates/drafts.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Delete: `internal/httpapi/web/compile.html`, `internal/httpapi/web/history.html`, `internal/httpapi/web/drafts.html`

**Interfaces:** same as Task 2.

- [x] **Step 1: Extract the three content templates**

Source `<main>` ranges (verify with `grep -n '<main\|^</main>' internal/httpapi/web/{compile,history,drafts}.html` before extracting — these are current-HEAD line numbers):
- `compile.html`: lines 17-22 → `templates/compile.html`, wrapped as `{{define "content"}}<main>` … `</main>{{end}}`
- `history.html`: lines 11-26 → `templates/history.html`, wrapped as `{{define "content"}}<main class="page">` … `</main>{{end}}`
- `drafts.html`: lines 11-34 → `templates/drafts.html`, wrapped as `{{define "content"}}<main class="page">` … `</main>{{end}}`

Use the same extract-and-wrap approach as Task 2 Step 2 for each, verifying every extracted file's body (everything between the `{{define}}`/`{{end}}` markers) is byte-identical to the source file's `<main>...</main>` range.

- [x] **Step 2: Wire the three routes and delete the old files**

In `internal/httpapi/server.go`, add to `templatedPages`:

```go
"compile": {file: "templates/compile.html", data: pageData{Title: "firenet — компиляция", Nav: "compile", Script: "compile.js"}},
"history": {file: "templates/history.html", data: pageData{Title: "firenet — история версий", Nav: "history", Script: "history.js"}},
"drafts":  {file: "templates/drafts.html", data: pageData{Title: "firenet — черновики", Nav: "drafts", Script: "drafts.js"}},
```

Change each route registration the same way as Task 2 Step 4 (`servePage("compile.html")` → `serveTemplatedPage(mustPageTemplate(pages, "compile"), templatedPages["compile"].data)`, and likewise for `history`/`drafts`).

Delete the old files:
```bash
git rm internal/httpapi/web/compile.html internal/httpapi/web/history.html internal/httpapi/web/drafts.html
```

- [x] **Step 3: Add the three test cases**

In `internal/httpapi/server_test.go`'s `TestTemplatedPages` `cases` slice:

```go
{"/ui/compile", "firenet — компиляция", "compile", `id="compile-run"`},
{"/ui/history", "firenet — история версий", "history", `id="history-table"`},
{"/ui/drafts", "firenet — черновики", "drafts", `id="drafts-table"`},
```

- [x] **Step 4: Run tests**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: PASS for all 6 cases so far (subnets, unions, diagnose, compile, history, drafts).

Run: `go test ./internal/httpapi/...` and `go build ./... && go vet ./...`
Expected: clean, no regressions.

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/templates/compile.html internal/httpapi/templates/history.html internal/httpapi/templates/drafts.html internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "refactor(web): migrate compile/history/drafts pages onto the shared page layout"
```

---

### Task 4: Migrate `devices.html`, `users.html`

**Files:**
- Create: `internal/httpapi/templates/devices.html`, `internal/httpapi/templates/users.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Delete: `internal/httpapi/web/devices.html`, `internal/httpapi/web/users.html`

**Interfaces:** same as Task 2.

- [x] **Step 1: Extract the two content templates**

Source `<main>` ranges (re-verify line numbers before extracting):
- `devices.html`: lines 17-93 → `templates/devices.html`, `{{define "content"}}<main x-data="devicesPage">` … `</main>{{end}}`
- `users.html`: lines 17-109 → `templates/users.html`, `{{define "content"}}<main x-data="usersPage">` … `</main>{{end}}`

Same extract-and-wrap approach as Task 2 Step 2.

- [x] **Step 2: Wire the two routes and delete the old files**

Add to `templatedPages`:
```go
"devices": {file: "templates/devices.html", data: pageData{Title: "firenet — устройства", Nav: "devices", Script: "devices.js"}},
"users":   {file: "templates/users.html", data: pageData{Title: "firenet — пользователи", Nav: "users", Script: "users.js"}},
```

Change the two route registrations, delete the old files (`git rm internal/httpapi/web/devices.html internal/httpapi/web/users.html`) — same pattern as prior tasks.

- [x] **Step 3: Add the two test cases**

```go
{"/ui/devices", "firenet — устройства", "devices", `x-data="devicesPage"`},
{"/ui/users", "firenet — пользователи", "users", `x-data="usersPage"`},
```

- [x] **Step 4: Run tests**

`go test ./internal/httpapi/... -run TestTemplatedPages -v`, then the full package suite and `go build ./... && go vet ./...` — all must pass clean.

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/templates/devices.html internal/httpapi/templates/users.html internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "refactor(web): migrate devices/users pages onto the shared page layout"
```

---

### Task 5: Migrate `networks.html`, `links.html`

**Files:**
- Create: `internal/httpapi/templates/networks.html`, `internal/httpapi/templates/links.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Delete: `internal/httpapi/web/networks.html`, `internal/httpapi/web/links.html`

**Interfaces:** same as Task 2.

- [x] **Step 1: Extract the two content templates**

Source `<main>` ranges (re-verify before extracting):
- `networks.html`: lines 17-121 → `templates/networks.html`, `{{define "content"}}<main x-data="networksPage">` … `</main>{{end}}`
- `links.html`: lines 17-137 → `templates/links.html`, `{{define "content"}}<main x-data="linksPage">` … `</main>{{end}}`

- [x] **Step 2: Wire the two routes and delete the old files**

```go
"networks": {file: "templates/networks.html", data: pageData{Title: "firenet — сети", Nav: "networks", Script: "networks.js"}},
"links":    {file: "templates/links.html", data: pageData{Title: "firenet — связи", Nav: "links", Script: "links.js"}},
```

Change route registrations, `git rm internal/httpapi/web/networks.html internal/httpapi/web/links.html`.

- [x] **Step 3: Add the two test cases**

```go
{"/ui/networks", "firenet — сети", "networks", `x-data="networksPage"`},
{"/ui/links", "firenet — связи", "links", `x-data="linksPage"`},
```

- [x] **Step 4: Run tests**

Same as prior tasks — table-driven test, full package suite, build+vet.

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/templates/networks.html internal/httpapi/templates/links.html internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "refactor(web): migrate networks/links pages onto the shared page layout"
```

---

### Task 6: Migrate `sets.html`, `topology.html`

**Files:**
- Create: `internal/httpapi/templates/sets.html`, `internal/httpapi/templates/topology.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Delete: `internal/httpapi/web/sets.html`, `internal/httpapi/web/topology.html`

**Interfaces:** same as Task 2.

**Note:** `/ui/topology` is also the redirect target of `GET /{$}` (`http.Redirect(w, r, "/ui/topology", http.StatusFound)`, `internal/httpapi/server.go`) — that redirect handler itself is untouched by this task; only the `/ui/topology` route's own handler changes from `servePage` to `serveTemplatedPage`.

- [x] **Step 1: Extract the two content templates**

Source `<main>` ranges (re-verify before extracting):
- `sets.html`: lines 17-146 → `templates/sets.html`, `{{define "content"}}<main x-data="setsPage">` … `</main>{{end}}`
- `topology.html`: lines 17-167 → `templates/topology.html`, `{{define "content"}}<main>` … `</main>{{end}}`

- [x] **Step 2: Wire the two routes and delete the old files**

```go
"sets":     {file: "templates/sets.html", data: pageData{Title: "firenet — наборы", Nav: "sets", Script: "sets.js"}},
"topology": {file: "templates/topology.html", data: pageData{Title: "firenet — топология", Nav: "topology", Script: "topology.js"}},
```

Change route registrations (`/ui/sets` and `/ui/topology`), `git rm internal/httpapi/web/sets.html internal/httpapi/web/topology.html`.

- [x] **Step 3: Add the two test cases**

```go
{"/ui/sets", "firenet — наборы", "sets", `x-data="setsPage"`},
{"/ui/topology", "firenet — топология", "topology", `id="topo-canvas"`},
```

- [x] **Step 4: Run tests**

Same as prior tasks. Additionally spot-check the redirect still works: `go test ./internal/httpapi/... -run TestTopology -v` if such a test exists (`grep -rl 'GET /{\$}\|/ui/topology' internal/httpapi/*_test.go` to find it), otherwise a manual `doJSON(t, srv, http.MethodGet, "/", nil)` expecting a 302 to `/ui/topology` is sufficient evidence in the report if no such test is found.

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/templates/sets.html internal/httpapi/templates/topology.html internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "refactor(web): migrate sets/topology pages onto the shared page layout"
```

---

### Task 7: Migrate `rules.html` (largest page, standalone)

**Files:**
- Create: `internal/httpapi/templates/rules.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/server_test.go`
- Delete: `internal/httpapi/web/rules.html`

**Interfaces:** same as Task 2.

- [x] **Step 1: Extract the content template**

Source `<main>` range (re-verify before extracting): `rules.html` lines 17-281 → `templates/rules.html`, `{{define "content"}}<main x-data="rulesPage">` … `</main>{{end}}`. This is the largest extraction in this plan (265 lines) — take extra care with the diff-verification step; do it in two halves if that's easier to eyeball (e.g. `sed -n '17,150p'` vs `sed -n '151,281p'`).

- [x] **Step 2: Wire the route and delete the old file**

```go
"rules": {file: "templates/rules.html", data: pageData{Title: "firenet — правила", Nav: "rules", Script: "rules.js"}},
```

Change the `/ui/rules` route registration, `git rm internal/httpapi/web/rules.html`.

- [x] **Step 3: Add the test case**

```go
{"/ui/rules", "firenet — правила", "rules", `x-data="rulesPage"`},
```

This is now the 13th and final case in `TestTemplatedPages` — every `/ui/*` page except `login`/`invite`/the redirect root is covered.

- [x] **Step 4: Run tests**

`go test ./internal/httpapi/... -run TestTemplatedPages -v` (expect all 13 cases PASS), then the full package suite, then `go build ./... && go vet ./...`.

Also confirm no leftover references to any deleted `web/*.html` file anywhere in the module: `grep -rn "networks.html\|devices.html\|sets.html\|links.html\|rules.html\|compile.html\|diagnose.html\|users.html\|drafts.html\|history.html\|topology.html" --include=*.go --include=*.js .` should show nothing outside this plan's own docs and (if present) e2e specs that hit the page by URL, not by filename.

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/templates/rules.html internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "refactor(web): migrate rules page onto the shared page layout"
```

---

## Self-review notes

- **Spec coverage:** the original spec's only concrete ask for this follow-up was "migrate the remaining ~11 pages, one or a few at a time" — every one of the 11 has its own task or shares a small task with 1-2 siblings; none were skipped (`networks, devices, sets, links, rules, compile, diagnose, users, drafts, history, topology` — 11 names, 11 covered across Tasks 2-7). The two named exceptions (`diagnose`'s CSS, `drafts`/`history`'s shell) are handled by explicit rulings, not silently glossed over.
- **Placeholder scan:** every task gives exact line ranges (re-verified against current HEAD at dispatch time, since earlier tasks in this plan shift nothing in other pages' files but each task instructs a fresh `grep -n` check before extracting, since Task N's own edits to `server.go`/`server_test.go` never touch another page's `web/*.html` line numbers — the re-verify instruction is defensive, not because drift is expected), exact `pageData` literals (title/nav/script, all read directly off the source files, not invented), and an exact diff-style verification command per extraction.
- **Type consistency:** `templatedPage{file string, data pageData}`, `templatedPages map[string]templatedPage`, `mustPageTemplate(pages map[string]*template.Template, name string) *template.Template`, `serveTemplatedPage(tmpl *template.Template, data pageData) http.HandlerFunc` — all used identically to their Task-1-of-the-pilot definitions across every task here; no task redefines or shadows them. `TestTemplatedPages`' case struct field `marker` (renamed from `xDataMark` in this plan's own Task 1) is used consistently by every later task's added case.
