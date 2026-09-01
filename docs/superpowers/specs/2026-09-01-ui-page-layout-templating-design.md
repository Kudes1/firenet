# Shared page layout for the web UI (pilot: subnets/unions)

## Motivation

Every "application" page (`subnets.html`, `unions.html`, `networks.html`,
`devices.html`, `sets.html`, `links.html`, `rules.html`, `users.html`,
`topology.html`, `diagnose.html`, `compile.html`, `drafts.html`,
`history.html`) is served as a fully standalone static file via
`embed.FS` (`internal/httpapi/server.go`'s `servePage`) — there is no
server-side templating in this project at all. Roughly 13-14 lines of
`<head>`/`<body>`/footer boilerplate (theme-flash script, favicon,
stylesheet, `<body data-nav="..." x-data="appData()"
@notify.window="...">`, and the `common.js`/`{page}.js`/`alpine.min.js`
footer scripts) are duplicated byte-for-byte across all of them,
differing only in `<title>`, `data-nav`, the page's own script filename,
and (on one page) an extra `data-no-draft-banner` attribute.

`login.html`/`invite.html` use a materially different, simpler shell
(no theme script, no `common.js`/Alpine footer) and are explicitly
**not** part of this shared shell.

This spec introduces a Go `html/template`-based layout for that shell
and migrates two pilot pages (`subnets`, `unions`) onto it, to validate
the mechanism before migrating the rest in follow-up work.

## Scope

**In scope:**
- A new `internal/httpapi/templates/` embed root holding `layout.html`
  (the shared shell) and one content file per migrated page.
- Migrating `subnets.html` and `unions.html` onto the layout.
- The Go-side plumbing: a second `embed.FS`, once-at-startup template
  parsing, and a new `serveTemplatedPage` handler alongside the
  existing `servePage`.

**Out of scope:**
- The `<dialog class="modal">` edit-modal markup skeleton (title/
  fields/hint/actions) repeated across the CRUD pages — a separate,
  smaller and riskier extraction (real per-page field differences
  inside), left for a future iteration.
- Every other page (`networks`, `devices`, `sets`, `links`, `rules`,
  `users`, `topology`, `diagnose`, `compile`, `drafts`, `history`) —
  they keep their current standalone `web/*.html` files and the
  existing `servePage(name)` path unchanged. Migrated later, page (or
  small group) at a time, the same way `floating_panel.js`/`table.js`
  were rolled out incrementally.
- `login.html`/`invite.html` — different shell, not part of this
  layout.

## Architecture

New directory `internal/httpapi/templates/`, embedded separately from
`web/`:

```go
// embed.go
//go:embed templates
var templateFiles embed.FS
```

This directory is **never** mounted onto the static file server
(`mux.Handle("/", noCache(webRoot, http.FileServer(...)))` only knows
about `web/`), so the raw template source (with its `{{...}}` syntax)
is structurally unreachable over HTTP — not just unlinked, but not
served by anything that could match its path.

- `templates/layout.html` — `{{define "layout"}}...{{end}}`: the head
  boilerplate, `<body data-nav="{{.Nav}}" x-data="appData()"
  @notify.window="showBanner($event.detail.message,
  $event.detail.kind)">`, `{{template "content" .}}` in the middle, and
  the `common.js`/`{{.Script}}`/`alpine.min.js` footer. Neither pilot
  page needs `data-no-draft-banner` (only `users.html`/`drafts.html`
  do, both out of scope here); that attribute becomes a `pageData`
  field when one of those pages is migrated, not before.
- `templates/subnets.html`, `templates/unions.html` — each
  `{{define "content"}}<main x-data="...">...</main>{{end}}`,
  containing verbatim what used to be the `<main>` block of the old
  `web/subnets.html`/`web/unions.html`.

The old `web/subnets.html` and `web/unions.html` are deleted; their
content moves into `templates/`.

### Avoiding the shared-namespace pitfall

If `layout.html` and both content files were parsed into one shared
`*template.Template` (e.g. a single `template.ParseFS(templateFiles,
"templates/*.html")`), every file's `{{define "content"}}` would land
in the *same* namespace — Go template "content" blocks aren't scoped
per source file. The last one parsed would silently win for **every**
page's `{{template "content" .}}`, so both pages would render
identical content (only `<title>`/`data-nav` would still differ,
because those come from `pageData`, not from the mis-resolved block).
No error, no test failure unless something explicitly checks page
content — this is the main way this feature could ship subtly broken.

The fix is the standard Go idiom: parse `layout.html` once into a base
template, then `Clone()` it per page and parse only that page's own
content file into the clone:

```go
var pageTemplateFiles = map[string]string{
	"subnets": "templates/subnets.html",
	"unions":  "templates/unions.html",
}

func parsePageTemplates() map[string]*template.Template {
	base := template.Must(template.ParseFS(templateFiles, "templates/layout.html"))
	pages := make(map[string]*template.Template, len(pageTemplateFiles))
	for name, file := range pageTemplateFiles {
		clone := template.Must(base.Clone())
		pages[name] = template.Must(clone.ParseFS(templateFiles, file))
	}
	return pages
}
```

Each page therefore gets its own independent `*template.Template` tree
— no cross-page name collisions are possible by construction.

## Template data

```go
type pageData struct {
	Title  string
	Nav    string
	Script string
}
```

Set once per route registration, mirroring how the routes are listed
today:

```go
pages := parsePageTemplates()
mux.HandleFunc("GET /ui/subnets", serveTemplatedPage(pages["subnets"], pageData{
	Title: "firenet — подсети", Nav: "subnets", Script: "subnets.js",
}))
mux.HandleFunc("GET /ui/unions", serveTemplatedPage(pages["unions"], pageData{
	Title: "firenet — объединения", Nav: "unions", Script: "unions.js",
}))
```

`serveTemplatedPage` replaces `servePage` only for these two routes;
every other `/ui/*` route keeps calling the existing `servePage(name)`
unchanged:

```go
func serveTemplatedPage(tmpl *template.Template, data pageData) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := tmpl.ExecuteTemplate(w, "layout", data); err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
		}
	}
}
```

## Error handling

`parsePageTemplates` panics on a parse error (`template.Must`), the
same way `fs.Sub(webFiles, "web")` already panics in `NewServer` — both
are build-time-embedded content, so a broken template fails immediately
at server startup (and in every test that boots a server), never on a
live request. No new runtime failure mode is introduced beyond what
`servePage` already has (a missing/unreadable embedded file).

## Testing

Automated only, per project convention (no manual browser pass):

- New Go test in `server_test.go`: `GET /ui/subnets` and `GET
  /ui/unions` each return `200`, `Content-Type: text/html; charset=utf-8`,
  and a body containing the expected `<title>`, `data-nav="..."`, and
  — the check that would have caught the shared-namespace pitfall above
  — the page-specific `x-data="subnetsPage"` / `x-data="unionsPage"`
  marker, confirming each page rendered its *own* content block and not
  the other's.
- Existing `TestStaticAssetsNoCache` is unaffected (it only exercises
  `/common.js`, `/rules.js`, `/style.css`, `/favicon.svg`, none of which
  move).
- Existing Playwright e2e specs are not run as part of this change (per
  `CLAUDE.md`: automated code tests only); the rendered DOM for
  `subnets`/`unions` is expected to stay byte-for-byte equivalent since
  the `<main>` content moves verbatim, so no e2e updates are expected
  to be needed.

## Migration

1. Add `internal/httpapi/templates/layout.html`, `templates/subnets.html`,
   `templates/unions.html`; add the `templateFiles` embed; add
   `pageData`/`parsePageTemplates`/`serveTemplatedPage` to `server.go`.
2. Switch the two routes to `serveTemplatedPage`; delete
   `web/subnets.html`/`web/unions.html`.
3. Add the Go test described above.

## Non-goals / open follow-ups

- Migrating the remaining ~11 application pages onto the layout
  (separate follow-up commits, one or a few pages at a time).
- Extracting the `<dialog class="modal">` edit-modal skeleton (out of
  scope, see above).
- Any visual change — this is a pure server-side deduplication of
  markup that was already identical.
