# Draft Banner Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the draft-status banner from a fixed page-wide overlay (prepended to `<body>`, requiring compensating `padding-top` on `.sidebar`/`main`) into the normal content flow at the top of `<main>`, and show it on the "Черновики" (drafts) and "История" (history) pages too — leaving it off "Пользователи" (users), whose data isn't draft-scoped.

**Architecture:** No new mechanism. `renderDraftBanner()` (`internal/httpapi/web/common.js`) already builds the banner element and gates itself on `document.body.dataset.noDraftBanner`, set from the `NoDraftBanner` field of each page's `pageData` in `internal/httpapi/server.go`. Two changes: (1) the banner's insertion point moves from `document.body.prepend(...)` to `document.querySelector("main").prepend(...)`, and its CSS drops `position: fixed` for normal flow, deleting the padding-top compensation hack it required; (2) `NoDraftBanner: true` is removed from the `history`/`drafts` entries in `templatedPages` (kept on `users`).

**Tech Stack:** Vanilla JS (`internal/httpapi/web/*.js`), Go `html/template` (`internal/httpapi/server.go`), plain CSS (`internal/httpapi/web/style.css`). Tests: `node --test` for the web JS files, `go test ./...` for Go.

**Spec:** No separate spec doc — this plan captures the full agreed design (see Rulings below); it is scoped and small enough not to warrant one.

## Rulings (from the conversation that led to this plan)

1. **Insertion point:** the banner moves into `<main>` (prepended there) instead of `<body>`. `<main>` is static markup already present at `DOMContentLoaded` time in every content template, unlike the sidebar `<aside>` which `buildNav()` builds and prepends to `<body>` asynchronously (a separate, unawaited fetch) — targeting `<main>` avoids that race entirely, which the old fixed-position CSS was partly working around.
2. **Users page stays excluded:** `users.js` reads/writes plain `/api/*` endpoints (not `apiPath()`/draft-scoped), so a "read-only — version N / open a draft" banner would misdescribe data that isn't versioned at all. `NoDraftBanner: true` stays on the `users` entry in `server.go`.
3. **Drafts/History pages gain the banner:** both manage draft/version state themselves, but the user explicitly wants visual consistency across pages over the (minor) redundancy — `NoDraftBanner: true` is removed from their `templatedPages` entries.

## Global Constraints

- Automated tests only (per `CLAUDE.md`): no Playwright/manual-browser pass for this change. Verify with `go test ./...` and `node --test internal/httpapi/web/*.test.js`.
- Keep code compact; don't add abstractions beyond what this change needs.

---

### Task 1: Move the banner's insertion point from `<body>` to `<main>`

**Files:**
- Modify: `internal/httpapi/web/common.js` (`renderDraftBanner`, near the end of the function)
- Modify: `internal/httpapi/web/draft_banner.test.js` (mock `doc` needs a `<main>` and `querySelector`)

**Interfaces:**
- Consumes: nothing new — `document.querySelector` is a standard DOM API already used elsewhere in this codebase's real runtime; only the test mock needs to grow it.
- Produces: `renderDraftBanner()` still returns `Promise<void>` and builds the same `banner` element (`className`, children, listeners) as before — only the final insertion call changes. Later tasks (CSS, server.go) don't depend on any new export.

- [x] **Step 1: Update the test mock and expectations first**

In `internal/httpapi/web/draft_banner.test.js`, the `loadCommon` helper's `doc` currently only has `doc.body`. Add a `<main>` element and a `querySelector` that resolves it, and point every assertion at `doc.main` instead of `doc.body`:

Replace:
```javascript
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = () => {};
```
with:
```javascript
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  doc.main = makeEl("main");
  doc.querySelector = (sel) => (sel === "main" ? doc.main : null);
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = () => {};
```

Then in each of the four tests that read `doc.body.children[0]`, change it to `doc.main.children[0]`:
- `"shows a read-only banner with the current version and an 'open draft' action"`: `const banner = doc.body.children[0];` → `const banner = doc.main.children[0];`
- `"the open-draft button creates a draft and stores its id"`: `const openBtn = doc.body.children[0].children[1];` → `const openBtn = doc.main.children[0].children[1];`
- `"shows an editing banner with the draft's name and status, and a 'return to current' action"`: `const banner = doc.body.children[0];` → `const banner = doc.main.children[0];`

(The two "falls back to read-only" tests don't read `doc.body.children`, so they need no change.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test internal/httpapi/web/draft_banner.test.js`
Expected: FAIL — `doc.main` is `undefined` (the mock has it now, but `common.js` still calls `document.body.prepend`, so `doc.main.children` stays empty and the first three tests fail on the banner assertions).

- [x] **Step 3: Change the insertion point in common.js**

In `internal/httpapi/web/common.js`, `renderDraftBanner()` ends with:
```javascript
  document.body.prepend(banner);
}
```
Change to:
```javascript
  document.querySelector("main").prepend(banner);
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test internal/httpapi/web/draft_banner.test.js`
Expected: PASS, all 5 tests.

- [x] **Step 5: Check for fallout in other web tests that exercise common.js's DOMContentLoaded path**

Run: `node --test internal/httpapi/web/compile.test.js`
Expected: PASS (this file dispatches `DOMContentLoaded` manually, which fires `renderDraftBanner()` as a side effect; its `doc` mock has no `main`/`querySelector`, same as it previously had no working `document.body.prepend` — the call was already throwing and being swallowed by `renderDraftBanner()`'s `.catch()` in `common.js`, so this is not a new failure mode). If it fails, add the same `doc.main`/`doc.querySelector` mock additions as Step 1 to `compile.test.js`'s `bootCompile` helper — but only if the run actually shows a failure; don't pre-emptively change a file whose tests already pass.

- [x] **Step 6: Run the full web test suite**

Run: `node --test internal/httpapi/web/*.test.js`
Expected: PASS, no regressions anywhere.

- [x] **Step 7: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/draft_banner.test.js
git commit -m "refactor(web): render the draft banner inside <main> instead of <body>"
```

---

### Task 2: Restyle the banner for normal flow, drop the fixed-position hack

**Files:**
- Modify: `internal/httpapi/web/style.css`

**Interfaces:**
- Consumes: the `.draft-banner`/`.draft-banner-readonly`/`.draft-banner-editing` class names set by `common.js` (unchanged by Task 1).
- Produces: no new classes; `main`'s existing `padding: var(--space-3)` (style.css:204) already gives the banner breathing room on all sides once it's a normal flow child, so nothing downstream needs to change.

- [x] **Step 1: Replace the `.draft-banner` block and delete the compensation rule**

In `internal/httpapi/web/style.css`, the current block (around line 1188) reads:
```css
/* The banner is prepended to <body>, which is a horizontal flex row
   (sidebar + main); without position:fixed it would become a third
   column instead of a page-wide header. Pinning it to the top takes it
   out of that row, so .sidebar/main need a compensating padding-top
   (below) — but only on pages where the banner actually renders, i.e.
   not [data-no-draft-banner] (see common.js's DOMContentLoaded guard). */
.draft-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  font-size: 0.85em;
  border-bottom: 1px solid var(--border);
}
/* ~44px covers the banner's own rendered height (padding 8px top+bottom
   plus its text/button content, ~28px) without leaving a visible gap. */
body:not([data-no-draft-banner]) .sidebar,
body:not([data-no-draft-banner]) main {
  padding-top: calc(var(--space-3) + 44px);
}
.draft-banner-readonly {
```

Replace the comment + `.draft-banner` rule + the now-obsolete padding-top compensation rule (keep `.draft-banner-readonly` and everything after it untouched) with:
```css
/* Prepended to <main> by common.js's renderDraftBanner(), so it's the
   first item in main's flex column — normal flow, no fixed positioning
   or compensating padding needed. */
.draft-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  margin-bottom: var(--space-3);
  font-size: 0.85em;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.draft-banner-readonly {
```

- [x] **Step 2: Confirm no other rule still references the deleted selector**

Run: `grep -n "data-no-draft-banner" internal/httpapi/web/style.css`
Expected: no output (the only CSS rule keyed on that attribute was the one just deleted; the `data-no-draft-banner` attribute itself still exists in `templates/layout.html` and `server.go` — Task 3 changes who gets it, not the mechanism).

- [x] **Step 3: Commit**

```bash
git add internal/httpapi/web/style.css
git commit -m "style(web): render the draft banner in normal flow instead of as a fixed overlay"
```

---

### Task 3: Show the banner on Drafts/History, keep it off Users

**Files:**
- Modify: `internal/httpapi/server.go` (`templatedPages` map)
- Modify: `internal/httpapi/server_test.go` (`TestTemplatedPages` cases)

**Interfaces:**
- Consumes: the `NoDraftBanner bool` field on `pageData` (`internal/httpapi/server.go:148`), unchanged.
- Produces: nothing new; this only changes which pages set the flag.

- [x] **Step 1: Update the test expectations first**

In `internal/httpapi/server_test.go`, `TestTemplatedPages`'s `cases` slice currently has:
```go
		{"/ui/history", "firenet — история версий", "history", `id="history-table"`, true},
		{"/ui/drafts", "firenet — черновики", "drafts", `id="drafts-table"`, true},
```
Change the trailing `noDraftBanner` bool to `false` for both:
```go
		{"/ui/history", "firenet — история версий", "history", `id="history-table"`, false},
		{"/ui/drafts", "firenet — черновики", "drafts", `id="drafts-table"`, false},
```
The `/ui/users` case keeps `true` — leave it unchanged.

- [x] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: FAIL — `/ui/history` and `/ui/drafts` report `data-no-draft-banner=true, want false` (the server still sets the flag).

- [x] **Step 3: Remove `NoDraftBanner` from the history/drafts entries**

In `internal/httpapi/server.go`, change:
```go
	"history":  {file: "templates/history.html", data: pageData{Title: "firenet — история версий", Nav: "history", Script: "history.js", NoDraftBanner: true}},
	"drafts":   {file: "templates/drafts.html", data: pageData{Title: "firenet — черновики", Nav: "drafts", Script: "drafts.js", NoDraftBanner: true}},
```
to:
```go
	"history":  {file: "templates/history.html", data: pageData{Title: "firenet — история версий", Nav: "history", Script: "history.js"}},
	"drafts":   {file: "templates/drafts.html", data: pageData{Title: "firenet — черновики", Nav: "drafts", Script: "drafts.js"}},
```
Leave the `users` entry's `NoDraftBanner: true` untouched.

- [x] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/httpapi/... -run TestTemplatedPages -v`
Expected: PASS, all 13 cases.

- [x] **Step 5: Run the full Go suite**

Run: `go test ./...`
Expected: PASS, no regressions (needs `FIRENET_TEST_DATABASE_URL` — see prior plans in this repo for standing up a disposable Postgres if needed).

- [x] **Step 6: Commit**

```bash
git add internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "feat(web): show the draft banner on the drafts/history pages"
```

---

## Self-review notes

- **Spec coverage:** the three agreed points from the conversation (banner moves into `<main>`, drafts/history gain it, users stays excluded) each map to a task — Task 1 (insertion point), Task 2 (CSS follow-through for the same move), Task 3 (which pages get it). Nothing from the discussion was left uncovered.
- **Placeholder scan:** every step gives exact before/after code (JS, CSS, Go) and exact commands; no "add appropriate styling" or similar left unresolved.
- **Type consistency:** `renderDraftBanner(): Promise<void>` (Task 1) is unchanged in signature; `pageData.NoDraftBanner bool` (Task 3) is unchanged in type, only its value per page changes. `.draft-banner`/`.draft-banner-readonly`/`.draft-banner-editing` class names (Task 2) match exactly what `common.js` sets, both before and after.
