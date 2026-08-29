# ES Modules Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global-object `<script>`-order convention in `internal/httpapi/web/*.js` with explicit `import`/`export` between ES modules, without a bundler and without adding package.json/node_modules.

**Architecture:** Convert files bottom-up by dependency layer (leaf modules → mid-layer → scene layer → page controllers). Each file gets `export` on its consumed top-level names; a temporary `window.X = X` bridge keeps not-yet-converted consumers working via the bare global they already use; a final cleanup task removes every bridge once all consumers import directly. HTML script tags flip from `<script src="...">` to `<script type="module" src="...">` one file at a time, except two files (`camera.js`, `netmap.js`) whose consumers (`diagnose.js`, `topology.js`) read them at top-level module-load time — those two consumers' own `<script>` tags flip to `type="module"` early (Task 2) to keep them in the same deferred-execution queue as their dependencies. `alpine.min.js` moves to the last `<script>` tag on every page (Task 6) so `common.js`'s module always finishes before Alpine evaluates `x-data="appData()"`.

**Tech Stack:** Vanilla JS, native ES modules (no bundler), `node:test` + dynamic `import()` for tests (no new test framework).

**Spec:** `docs/superpowers/specs/2026-08-29-es-modules-migration-design.md`

## Global Constraints

- No package.json / node_modules — only Node built-ins (`AGENTS.md`, `README.md`).
- JS tests run as `node --test 'internal/httpapi/web/*.test.js'` — the glob is required; this command does not change.
- Test files stay `.test.js` on CommonJS (`require("node:test")`); they load ES-module sources via `await import(...)` wrapped in a top-level `(async () => { ... })();` IIFE (top-level `await` is invalid in CommonJS).
- File boundaries are 1:1 — no splitting or merging of existing `.js` files.
- `alpine.min.js` is not converted; it stays a classic `<script defer>` (last on the page, per Task 6).
- Every existing test's assertions are preserved verbatim — only the loader (the `vm.runInContext`/`new Function`/`require` block at the top of each test file) changes.

---

## Task 1: `tween.js`

**Files:**
- Modify: `internal/httpapi/web/tween.js:6`, `:37`
- Modify: `internal/httpapi/web/tween.test.js:1-11`
- Test: `internal/httpapi/web/tween.test.js`

**Interfaces:**
- Produces: `export const Tween` — `{ create, easeOutCubic }` (unchanged shape).

No HTML changes: `tween.js` has no top-level (module-load-time) consumers — every `Tween.*` read in `diagnose.js`/`topology.js` is inside a function called later (verified: lines 279/483/814 in diagnose.js, 947/1057 in topology.js, all inside named functions).

- [ ] **Step 1: Add `export` to `Tween` and drop the dead CommonJS interop line**

`internal/httpapi/web/tween.js`:
```diff
-const Tween = (() => {
+export const Tween = (() => {
   const easeOutCubic = (t) => 1 - (1 - t) ** 3;
   ...
   return Object.freeze({ create, easeOutCubic });
 })();
-
-if (typeof module !== "undefined") module.exports = Tween;
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/tween.test.js`, replace lines 1-11:
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const { Tween } = await import(path.join(__dirname, "tween.js"));

  test("tick interpolates numeric props and reports activity", () => {
```
Indent the four existing `test(...)` blocks one level (they are now inside the async IIFE) and close the file with:
```js
})();
```
The body of each `test()` (assertions) is unchanged.

- [ ] **Step 3: Run the test**

Run: `node --test internal/httpapi/web/tween.test.js`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add internal/httpapi/web/tween.js internal/httpapi/web/tween.test.js
git commit -m "refactor(web): convert tween.js to an ES module"
```

---

## Task 2: `camera.js`

**Files:**
- Modify: `internal/httpapi/web/camera.js:6`
- Modify: `internal/httpapi/web/camera.test.js:1-14`
- Modify: `internal/httpapi/web/diagnose.html:112,114,124`
- Modify: `internal/httpapi/web/topology.html:94,96,108`
- Test: `internal/httpapi/web/camera.test.js`

**Interfaces:**
- Produces: `export const Camera` — `{ MIN_ZOOM, MAX_ZOOM, create, zoomAt, screenToWorld, worldToScreen, fitView }` (unchanged shape). Also assigned to `window.Camera` (temporary bridge, removed in Task 29) because `diagnose.js` and `topology.js` read `Camera.create()` at their own top level (module-load time), not inside a function.

**Why `diagnose.js`/`topology.js`'s `<script>` tags flip to `type="module"` here, not at their own Task 15/16:** `diagnose.js:8` does `camera: Camera.create()` and `topology.js:7` does `camera: Camera.create()` as literal top-level statements (inside the `state`/`State` object literal), executed the instant the script runs — not deferred to a later call. Once `camera.js` becomes a module (deferred, waits for the whole document to parse), a still-classic `diagnose.js`/`topology.js` positioned later in the document would keep running immediately during parsing — i.e. *before* `camera.js`'s deferred module sets `window.Camera` — and throw `Camera is not defined`. Flipping their own tags to `type="module"` moves them into the same deferred queue, where document order is preserved, so `camera.js` (earlier tag) still runs before them. Their content is untouched — no `import`/`export` yet, just the `type="module"` attribute — which is valid because a module needs no import/export statements to be a module. All other files loaded by these two pages remain classic scripts for now; their only use of `Camera`/`NetMap`/etc. is inside functions called after `boot()`, verified in Task 7 and the spec's risk section.

- [ ] **Step 1: Add `export` and a `window` bridge to `Camera`**

`internal/httpapi/web/camera.js`:
```diff
-const Camera = (() => {
+const Camera = (() => {
   const MIN_ZOOM = 0.1;
   ...
   return { MIN_ZOOM, MAX_ZOOM, create, zoomAt, screenToWorld, worldToScreen, fitView };
 })();
+
+export { Camera };
+window.Camera = Camera; // TODO(Task 29): remove once every classic-script consumer imports Camera directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/camera.test.js`, replace lines 1-14 (the `require`s and the `loadCamera` helper):
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function loadCamera() {
  const { Camera } = await import(path.join(__dirname, "camera.js"));
  return Camera;
}

// objects created by the module have a normal prototype now; pt() is no
// longer needed for deepEqual, but kept so the rest of the file (below) is
// untouched
const pt = (p) => ({ x: p.x, y: p.y });
```
Then wrap the file body: prepend `(async () => {` right after the `pt` definition, change every `const Camera = loadCamera();` to `const Camera = await loadCamera();`, mark every enclosing `test("...", () => { ... })` callback `async`, and append `})();` at the end of the file. Concretely, each of the 7 existing tests becomes:
```js
test("identity camera maps screen to world unchanged", async () => {
  const Camera = await loadCamera();
  const cam = Camera.create();
  assert.deepEqual(pt(Camera.screenToWorld(cam, 120, 80)), { x: 120, y: 80 });
});
```
(same transform for the other 6 tests — only the `loadCamera()` call site and the surrounding `async`/`await` change; assertions are untouched).

- [ ] **Step 3: Flip the `camera.js`, `diagnose.js` script tags in `diagnose.html`**

`internal/httpapi/web/diagnose.html`:
```diff
-<script src="/alpine.min.js" defer></script>
+<script src="/alpine.min.js" defer></script>
 <script src="/common.js"></script>
-<script src="/camera.js"></script>
+<script type="module" src="/camera.js"></script>
 <script src="/minimap.js"></script>
 <script src="/camera_input.js"></script>
 <script src="/netmap.js"></script>
 <script src="/tween.js"></script>
 <script src="/canvas_theme.js"></script>
 <script src="/hit_test.js"></script>
 <script src="/canvas_view.js"></script>
 <script src="/topo_scene.js"></script>
 <script src="/net_info.js"></script>
-<script src="/diagnose.js"></script>
+<script type="module" src="/diagnose.js"></script>
```

- [ ] **Step 4: Flip the `camera.js`, `topology.js` script tags in `topology.html`**

`internal/httpapi/web/topology.html`:
```diff
 <script src="/common.js"></script>
-<script src="/camera.js"></script>
+<script type="module" src="/camera.js"></script>
 <script src="/minimap.js"></script>
 <script src="/camera_input.js"></script>
 <script src="/netmap.js"></script>
 <script src="/tween.js"></script>
 <script src="/canvas_theme.js"></script>
 <script src="/hit_test.js"></script>
 <script src="/canvas_view.js"></script>
 <script src="/net_info.js"></script>
 <script src="/link_panel.js"></script>
 <script src="/topo_scene.js"></script>
 <script src="/topology_sync.js"></script>
-<script src="/topology.js"></script>
+<script type="module" src="/topology.js"></script>
```

- [ ] **Step 5: Run the tests**

Run: `node --test internal/httpapi/web/camera.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/camera.js internal/httpapi/web/camera.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert camera.js to an ES module"
```

---

## Task 3: `canvas_theme.js`

**Files:**
- Modify: `internal/httpapi/web/canvas_theme.js:6`, `:51`
- Modify: `internal/httpapi/web/canvas_theme.test.js:1-12,28-35`
- Test: `internal/httpapi/web/canvas_theme.test.js`

**Interfaces:**
- Produces: `export const CanvasTheme` — `{ create, fromComputed }` (unchanged shape). `window.CanvasTheme` bridge added (removed Task 29): `diagnose.js`/`topology.js` read `CanvasTheme.fromComputed(...)` only inside `boot()` (verified line 850/1318 respectively — inside functions), so no HTML changes are needed here beyond the tag flip already done in Task 2 covering the whole page's deferred queue.

- [ ] **Step 1: Add `export` and drop the dead CommonJS interop line**

`internal/httpapi/web/canvas_theme.js`:
```diff
-const CanvasTheme = (() => {
+const CanvasTheme = (() => {
   const NAMES = [...];
   ...
   return Object.freeze({ create, fromComputed });
 })();
-
-if (typeof module !== "undefined") module.exports = CanvasTheme;
+
+export { CanvasTheme };
+window.CanvasTheme = CanvasTheme; // TODO(Task 29): remove once every classic-script consumer imports CanvasTheme directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/canvas_theme.test.js`, replace lines 1-12:
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CanvasTheme } = await import(path.join(__dirname, "canvas_theme.js"));

const VARS = {
```
This top-level `await` requires the file to run as an ES module, which conflicts with the Global Constraint that test files stay CommonJS — so instead wrap the whole file in an async IIFE like every other test file:
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const { CanvasTheme } = await import(path.join(__dirname, "canvas_theme.js"));

  const VARS = {
    "--panel-bg": "#f6f6f8", "--border": "#d8d8dc", "--accent": "#2563eb",
    "--muted": "#6b6b6b", "--text": "#1a1a1a",
    "--kind-router": "#d97706", "--kind-switch": "#7c3aed", "--kind-network": "#16a34a",
  };

  test("create maps css vars onto theme fields", () => {
```
Indent the remaining three top-level `test(...)` blocks one level. The second test ("theme loads standalone, without the global NetMap") currently re-loads `canvas_theme.js` into a fresh `vm` sandbox to prove it has no dependency on `netmap.js`; replace its body with a second `import()` of the same path plus a cache-busting query so it re-evaluates the module instead of returning the cached one (this file has no module-level mutable state, so cache-busting isn't required for correctness here, but a fresh `import()` reproduces the original test's intent of a from-scratch load):
```js
  test("theme loads standalone, without the global NetMap", async () => {
    const { CanvasTheme: T } = await import(path.join(__dirname, "canvas_theme.js"));
    assert.equal(T.create({}).textHideZoom, 0.5);
  });
```
Close the file with `})();` after the last test.

- [ ] **Step 3: Run the test**

Run: `node --test internal/httpapi/web/canvas_theme.test.js`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add internal/httpapi/web/canvas_theme.js internal/httpapi/web/canvas_theme.test.js
git commit -m "refactor(web): convert canvas_theme.js to an ES module"
```

---

## Task 4: `hit_test.js`

**Files:**
- Modify: `internal/httpapi/web/hit_test.js:5`, `:110`
- Modify: `internal/httpapi/web/hit_test.test.js:1-7`
- Test: `internal/httpapi/web/hit_test.test.js`

**Interfaces:**
- Produces: `export const HitTest` — `{ bbox, pick, pickNodes }` (unchanged shape). `window.HitTest` bridge added (removed Task 29): all `HitTest.*` reads in `diagnose.js`/`topology.js` are inside event-handler functions (verified above), never at top level.

- [ ] **Step 1: Add `export` and drop the dead CommonJS interop line**

`internal/httpapi/web/hit_test.js`:
```diff
-const HitTest = (() => {
+const HitTest = (() => {
   const PAD = 4;
   ...
   return Object.freeze({ bbox, pick, pickNodes });
 })();
-
-if (typeof module !== "undefined") module.exports = HitTest;
+
+export { HitTest };
+window.HitTest = HitTest; // TODO(Task 29): remove once every classic-script consumer imports HitTest directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/hit_test.test.js`, replace lines 1-7 (this file used `new Function`, not `vm`, since `hit_test.js` has zero DOM dependency):
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const { HitTest } = await import(path.join(__dirname, "hit_test.js"));

  test("bbox covers rect and path extremes", () => {
```
Indent every remaining `test(...)` block one level and close the file with `})();`. Assertions are unchanged.

- [ ] **Step 3: Run the test**

Run: `node --test internal/httpapi/web/hit_test.test.js`
Expected: PASS (9 tests).

- [ ] **Step 4: Commit**

```bash
git add internal/httpapi/web/hit_test.js internal/httpapi/web/hit_test.test.js
git commit -m "refactor(web): convert hit_test.js to an ES module"
```

---

## Task 5: `columns.js`

**Files:**
- Modify: `internal/httpapi/web/columns.js:8` (export list), `:113-115` (drop CommonJS block)
- Modify: `internal/httpapi/web/rules_columns.test.js:1-10`
- Test: `internal/httpapi/web/rules_columns.test.js`

**Interfaces:**
- Produces: `export function parseColumnWidths`, `export function resetPair`, `export function resizePair`, `export function toPercentages`, `export function makeColumnsResizable`, `export function initializeColumns`. `window.makeColumnsResizable` and `window.initializeColumns` bridges added (removed Task 29) — these are the only two names read as bare globals by `networks.js`/`rules.js`/`sets.js`/`subnets.js`/`unions.js` (all inside `alpine:init` callbacks, never at top level, so no HTML tag flips are needed for those five pages here).

No HTML changes: `columns.js`'s consumers (`networks.js`, `rules.js`, `sets.js`, `subnets.js`, `unions.js`) all call `initializeColumns`/`makeColumnsResizable` from inside a `document.addEventListener("alpine:init", ...)` callback (verified), never at top level — safe to stay classic scripts until their own Phase 4 task.

- [ ] **Step 1: Export every top-level function**

`internal/httpapi/web/columns.js`:
```diff
-function sum(widths) {
+function sum(widths) {
   return widths.reduce((total, width) => total + width, 0);
 }

-function toPercentages(widths) {
+export function toPercentages(widths) {
   const total = sum(widths);
   return total ? widths.map((width) => Number(((width * 100) / total).toFixed(6))) : [];
 }

-function parseColumnWidths(raw, count, version) {
+export function parseColumnWidths(raw, count, version) {
   ...
 }

-function resizePair(widths, index, delta, minimums) {
+export function resizePair(widths, index, delta, minimums) {
   ...
 }

-function resetPair(widths, index, defaults, minimums) {
+export function resetPair(widths, index, defaults, minimums) {
   ...
 }
```
`columnElements`, `headerWidths`, `applyColumnWidths`, `saveColumnWidths`, `restoreColumnWidths` stay internal (not consumed outside this file).
```diff
-function makeColumnsResizable(table, key, version) {
+export function makeColumnsResizable(table, key, version) {
   ...
 }

-function initializeColumns(table, key, version) {
+export function initializeColumns(table, key, version) {
   if (restoreColumnWidths(table, key, version)) return;
   const widths = headerWidths(table);
   if (sum(widths)) applyColumnWidths(table, widths);
 }

-if (typeof module !== "undefined") {
-  module.exports = { parseColumnWidths, resetPair, resizePair, toPercentages };
-}
+window.makeColumnsResizable = makeColumnsResizable; // TODO(Task 29): remove once every classic-script consumer imports these directly
+window.initializeColumns = initializeColumns;
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/rules_columns.test.js`, replace lines 1-10:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const {
    parseColumnWidths,
    resetPair,
    resizePair,
    toPercentages,
  } = await import(path.join(__dirname, "columns.js"));

  test("resizePair changes only the selected pair", () => {
```
Indent the remaining three `test(...)` blocks one level and close the file with `})();`.

- [ ] **Step 3: Run the test**

Run: `node --test internal/httpapi/web/rules_columns.test.js`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add internal/httpapi/web/columns.js internal/httpapi/web/rules_columns.test.js
git commit -m "refactor(web): convert columns.js to an ES module"
```

---

## Task 6: `common.js` (+ site-wide `alpine.min.js` reorder)

**Files:**
- Modify: `internal/httpapi/web/common.js` (export every consumed top-level name, add `window.appData` bridge)
- Modify: `internal/httpapi/web/dirty_guard.test.js:54-79`
- Modify: `internal/httpapi/web/draft_context.test.js:9-31`
- Modify: `internal/httpapi/web/draft_banner.test.js:24-67`
- Modify: `internal/httpapi/web/sidebar.test.js:37-63`
- Modify: `internal/httpapi/web/login_redirect.test.js:9-22`
- Modify: all 14 HTML files: flip `<script src="/common.js">` to `<script type="module" src="/common.js">` and move `<script src="/alpine.min.js" defer>` to be the last `<script>` tag on the page
- Test: the 5 test files listed above

**Interfaces:**
- Produces: `export function appData`, `export function showBanner`, `export const DirtyGuard`, `export function currentDraftID`, `export function setCurrentDraftID`, `export function isReadOnly`, `export async function renderDraftBanner`, `export function apiPath`, `export class ReadOnlyError`, `export function assertEditable`, `export function loginRedirectURL`, `export const Api`, `export function ipv4CidrOverlap`, `export function containsFold`, `export function matchPrefixQuery`, `export function matchSubnetMembers`, `export async function buildNav`. `window.appData = appData` bridge added and kept permanently (not removed in Task 29 — `x-data="appData()"` is an inline HTML attribute expression Alpine evaluates against the global object; it can never become a static `import`). Every other export above additionally gets a `window.X = X` bridge, removed in Task 29 once its last bare-global consumer (a page `.js` file, listed per name below) is converted:
  - `showBanner`, `Api`, `apiPath`, `containsFold`: consumed by `compile.js`, `diagnose.js`, `drafts.js`, `history.js`, `link_panel.js`, `links.js`, `networks.js`, `rules.js`, `sets.js`, `subnets.js`, `topology.js`, `unions.js`, `users.js` (showBanner only, not the other three).
  - `assertEditable`: `links.js`, `networks.js`, `rules.js`, `sets.js`, `subnets.js`, `topology.js`, `unions.js`.
  - `DirtyGuard`, `isReadOnly`: `topology.js`.
  - `currentDraftID`: `drafts.js`, `topology.js`. `setCurrentDraftID`: `drafts.js`, `history.js`.
  - `loginRedirectURL`: `drafts.js`, `login.js`, `users.js`.
  - `ipv4CidrOverlap`: `subnets.js`.
  - `matchPrefixQuery`: `sets.js`, `unions.js`. `matchSubnetMembers`: `links.js`, `networks.js`, `sets.js`.
  - `parseIPv4`, `parsePrefix`, `parseQueryPrefix`, `formatIPv4`: `rules.js` (also `prefixContains`/`prefixOverlap`, used only inside `common.js` and `rules.js` — export these two as well since `rules.js:150-168` reads them as bare globals).
  - `ReadOnlyError`, `renderDraftBanner`, `buildNav`: no page `.js` file reads these as a bare global (only `common.js`'s own internal `DOMContentLoaded` listener and the tests), so no bridge is required for these three — export only.

All 13 not-yet-converted page files keep working unchanged through the bridges; none of them read any of these names at top level (every read is inside `alpine:init`/`DOMContentLoaded` callbacks or Alpine component methods — verified in Tasks 15-27's file reads).

- [ ] **Step 1: Export every consumed top-level declaration and add the `appData` bridge**

`internal/httpapi/web/common.js`:
```diff
-function appData() {
+export function appData() {
   return {
     ...
   };
 }
+window.appData = appData; // permanent: Alpine evaluates x-data="appData()" against the global scope

-function showBanner(message, kind) {
+export function showBanner(message, kind) {
   window.dispatchEvent(new CustomEvent("notify", { detail: { message, kind: kind || "error" } }));
 }
+window.showBanner = showBanner; // TODO(Task 29): remove once every classic-script consumer imports showBanner directly

-const DirtyGuard = (() => {
+const DirtyGuard = (() => {
   ...
   return { arm, markClean, isDirty };
 })();
+window.DirtyGuard = DirtyGuard; // TODO(Task 29): remove once topology.js imports DirtyGuard directly

-function currentDraftID() {
+export function currentDraftID() {
   ...
 }
+window.currentDraftID = currentDraftID; // TODO(Task 29)

-function setCurrentDraftID(id) {
+export function setCurrentDraftID(id) {
   ...
 }
+window.setCurrentDraftID = setCurrentDraftID; // TODO(Task 29)

-function isReadOnly() {
+export function isReadOnly() {
   return !currentDraftID();
 }
+window.isReadOnly = isReadOnly; // TODO(Task 29)

-async function renderDraftBanner() {
+export async function renderDraftBanner() {
   ...
 }

-function apiPath(suffix) {
+export function apiPath(suffix) {
   ...
 }
+window.apiPath = apiPath; // TODO(Task 29)

-class ReadOnlyError extends Error {
+export class ReadOnlyError extends Error {
   ...
 }

-function assertEditable() {
+export function assertEditable() {
   if (isReadOnly()) throw new ReadOnlyError();
 }
+window.assertEditable = assertEditable; // TODO(Task 29)

-function loginRedirectURL(pathname, search) {
+export function loginRedirectURL(pathname, search) {
   ...
 }
+window.loginRedirectURL = loginRedirectURL; // TODO(Task 29)

-const Api = {
+export const Api = {
   ...
 };
+window.Api = Api; // TODO(Task 29)

-function ipv4CidrOverlap(a, b) {
+export function ipv4CidrOverlap(a, b) {
   ...
 }
+window.ipv4CidrOverlap = ipv4CidrOverlap; // TODO(Task 29)

-function containsFold(s, sub) {
+export function containsFold(s, sub) {
   return !sub || String(s || "").toLowerCase().includes(sub.toLowerCase());
 }
+window.containsFold = containsFold; // TODO(Task 29)

-function parseIPv4(s) {
+export function parseIPv4(s) {
   ...
 }
+window.parseIPv4 = parseIPv4; // TODO(Task 29)

-function parsePrefix(s) {
+export function parsePrefix(s) {
   ...
 }
+window.parsePrefix = parsePrefix; // TODO(Task 29)

-function parseQueryPrefix(q) {
+export function parseQueryPrefix(q) {
   ...
 }
+window.parseQueryPrefix = parseQueryPrefix; // TODO(Task 29)

-function formatIPv4(n) {
+export function formatIPv4(n) {
   return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
 }
+window.formatIPv4 = formatIPv4; // TODO(Task 29)

-const prefixContains = (p, addr) => (addr & p.mask) === p.base;
-const prefixOverlap = (a, b) => {
+export const prefixContains = (p, addr) => (addr & p.mask) === p.base;
+export const prefixOverlap = (a, b) => {
   const common = a.mask & b.mask;
   return (a.base & common) === (b.base & common);
 };
+window.prefixContains = prefixContains; // TODO(Task 29)
+window.prefixOverlap = prefixOverlap; // TODO(Task 29)

-function matchPrefixQuery(entries, q) {
+export function matchPrefixQuery(entries, q) {
   ...
 }
+window.matchPrefixQuery = matchPrefixQuery; // TODO(Task 29)

-function matchSubnetMembers(subnets, cidrOf, q) {
+export function matchSubnetMembers(subnets, cidrOf, q) {
   return matchPrefixQuery([...names, ...names.map((s) => cidrOf(s))], q);
 }
+window.matchSubnetMembers = matchSubnetMembers; // TODO(Task 29)

-async function buildNav(active) {
+export async function buildNav(active) {
   ...
 }
```

- [ ] **Step 2: Flip `common.js` to a module and move `alpine.min.js` to last, on every HTML page**

For each of the 14 files below, apply both changes. Example (`internal/httpapi/web/diagnose.html`):
```diff
-<script src="/alpine.min.js" defer></script>
-<script src="/common.js"></script>
+<script type="module" src="/common.js"></script>
 <script type="module" src="/camera.js"></script>
 <script src="/minimap.js"></script>
 <script src="/camera_input.js"></script>
 <script src="/netmap.js"></script>
 <script src="/tween.js"></script>
 <script src="/canvas_theme.js"></script>
 <script src="/hit_test.js"></script>
 <script src="/canvas_view.js"></script>
 <script src="/topo_scene.js"></script>
 <script src="/net_info.js"></script>
 <script type="module" src="/diagnose.js"></script>
+<script src="/alpine.min.js" defer></script>
```
Apply the same two changes (drop `alpine.min.js` from the top, flip `common.js` to `type="module"`, append `alpine.min.js` as the last script tag) to: `compile.html`, `drafts.html`, `history.html`, `links.html`, `login.html` (has no `x-data`/Alpine at all — still move `common.js`... — **`login.html` and `index.html` load neither `alpine.min.js` nor `common.js`/`users.html` does load both**; check each file's actual script list before editing — `login.html` only has `<script src="/login.js"></script>`, so Step 2 does not apply to it), `networks.html`, `rules.html`, `sets.html`, `subnets.html`, `topology.html`, `unions.html`, `users.html`. `index.html` has no `<script>` tags at all and is unaffected.

- [ ] **Step 3: Rewrite the `dirty_guard.test.js` loader**

`internal/httpapi/web/dirty_guard.test.js`, replace lines 54-79 (`loadCommon`):
```js
async function loadCommon({ confirmResult }) {
  const doc = makeDoc();
  const winListeners = {};
  const location = { href: "http://x/ui/topology" };
  global.document = doc;
  global.window = { addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); }, location };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {};
  global.confirm = () => confirmResult;
  global.fetch = () => Promise.resolve({ ok: false });
  const { DirtyGuard, buildNav } = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
  return { sandbox: { DirtyGuard, buildNav }, doc, winListeners, location };
}
```
The cache-busting query string forces a fresh module evaluation per call (this file calls `loadCommon` multiple times per test and across tests, each expecting a clean `DirtyGuard` with no armed state left over from a previous call — the original `vm.createContext` gave every call a fresh sandbox; a plain `import()` would instead return the same cached module and leaked `DirtyGuard` state between calls). Remove the now-unused `vm` require at the top of the file and add `const path = require("node:path");` (already present). Wrap the 5 existing `test(...)` calls in a top-level `(async () => { ... })();` IIFE (`loadCommon` is now itself async, and the tests already `await` or are synchronous — mark every test callback that calls `loadCommon` as `async` and add `await` before each `loadCommon(...)` call). `clickNavLink`, `fire`, `makeEl`, `makeDoc` are unchanged.

- [ ] **Step 4: Rewrite the `draft_context.test.js` loader**

`internal/httpapi/web/draft_context.test.js`, replace lines 9-31 (`loadCommon`):
```js
async function loadCommon(store = {}, localStore = {}) {
  global.document = { addEventListener() {} };
  global.window = {};
  global.localStorage = {
    getItem: (k) => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = v; },
    removeItem: (k) => { delete localStore[k]; },
  };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  const names = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
  return { ...names, store, localStore };
}
```
Cache-busting is required here too: `currentDraftID`/`setCurrentDraftID` read/write `sessionStorage`/`localStorage` closures captured via the `global.sessionStorage`/`global.localStorage` object identity at call time (not at import time — they call the global accessor fresh each time), so this one is actually safe to *not* cache-bust; keep the cache-busting query anyway for consistency with the rest of this task and because "restored draft remains fixed in its tab..." explicitly loads `common.js` twice (`firstTab`/`secondTab`) expecting two independent instances only insofar as they share the same `localStore` object but track drafts through `sessionStorage`, which is a fresh plain object per `loadCommon` call regardless of module caching — cache-busting removes any doubt without needing to re-derive which of the 9 tests would otherwise share state. Remove the `vm`/`fs` requires, keep `path`. Wrap all 9 `test(...)` calls in a top-level async IIFE, mark each test callback `async`, `await` each `loadCommon(...)` call.

- [ ] **Step 5: Rewrite the `draft_banner.test.js` loader**

`internal/httpapi/web/draft_banner.test.js`, replace lines 24-67 (`loadCommon`), following the same pattern as Step 4: move every `sandbox.*` property (`document`, `window`, `localStorage`, `sessionStorage`, `matchMedia`, `fetch`, `console` — `console` needs no reassignment, it's already global) onto `global.*`, then:
```js
  const { renderDraftBanner } = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
  return { renderDraftBanner, doc, posted, localStore };
```
(drop the returned `sandbox` — tests that read `sandbox.sessionStorage.getItem(...)` or `sandbox.window.location.reload = ...` switch to `global.sessionStorage.getItem(...)` / `global.window.location.reload = ...` respectively). Wrap the 5 `test(...)` calls in a top-level async IIFE (they are already `async`).

- [ ] **Step 6: Rewrite the `sidebar.test.js` loader**

`internal/httpapi/web/sidebar.test.js`, replace lines 37-63 (`loadCommon`), same pattern:
```js
async function loadCommon(store, me) {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.documentElement = { dataset: {} };
  doc.createElement = (tag) => makeEl(tag);
  global.document = doc;
  global.window = { addEventListener() {}, location: { href: "" } };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {};
  global.confirm = () => false;
  global.fetch = () => Promise.resolve(me ? { ok: true, json: () => Promise.resolve(me) } : { ok: false });
  const { buildNav } = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
  return { buildNav, doc };
}
```
Wrap the 7 `test(...)` calls in a top-level async IIFE, mark each callback `async`, `await` each `loadCommon(...)`.

- [ ] **Step 7: Rewrite the `login_redirect.test.js` loader**

`internal/httpapi/web/login_redirect.test.js`, replace lines 9-22:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function loadCommon() {
  global.document = { addEventListener() {} };
  global.window = {};
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.matchMedia = () => ({ matches: false });
  return import(path.join(__dirname, "common.js"));
}

(async () => {
  test("loginRedirectURL preserves a same-origin path as next", async () => {
    const { loginRedirectURL } = await loadCommon();
    assert.equal(loginRedirectURL("/ui/rules", ""), "/login?next=%2Fui%2Frules");
  });

  test("loginRedirectURL drops a protocol-relative next", async () => {
    const { loginRedirectURL } = await loadCommon();
    assert.equal(loginRedirectURL("//evil.com", ""), "/login");
  });

  test("loginRedirectURL includes the query string in next", async () => {
    const { loginRedirectURL } = await loadCommon();
    assert.equal(loginRedirectURL("/ui/rules", "?chain=fwd"), "/login?next=%2Fui%2Frules%3Fchain%3Dfwd");
  });
})();
```
No cache-busting needed — `loginRedirectURL` is a pure function with no module-level state.

- [ ] **Step 8: Run the tests**

Run: `node --test internal/httpapi/web/dirty_guard.test.js internal/httpapi/web/draft_context.test.js internal/httpapi/web/draft_banner.test.js internal/httpapi/web/sidebar.test.js internal/httpapi/web/login_redirect.test.js`
Expected: PASS (5 + 9 + 5 + 7 + 3 = 29 tests).

- [ ] **Step 9: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: every test file still PASSes — every not-yet-converted page `.js` file reads `showBanner`/`Api`/`apiPath`/etc. through the new `window.*` bridges, so no other test file's behavior changes.

- [ ] **Step 10: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/*.html internal/httpapi/web/dirty_guard.test.js internal/httpapi/web/draft_context.test.js internal/httpapi/web/draft_banner.test.js internal/httpapi/web/sidebar.test.js internal/httpapi/web/login_redirect.test.js
git commit -m "refactor(web): convert common.js to an ES module, reorder alpine.min.js last on every page"
```

---

## Task 7: `netmap.js`

**Files:**
- Modify: `internal/httpapi/web/netmap.js:7`
- Modify: `internal/httpapi/web/netmap.test.js:1-11`
- Modify: `internal/httpapi/web/diagnose.html`, `internal/httpapi/web/topology.html` (flip `netmap.js`'s own tag only — `diagnose.js`/`topology.js` are already `type="module"` since Task 2)
- Test: `internal/httpapi/web/netmap.test.js`

**Interfaces:**
- Produces: `export const NetMap` — `{ DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_COLORS, KINDS, center, linkOffsets, spreadOffset, pointAt, insertIndex, cloudSegs }` (unchanged shape). `window.NetMap` bridge added (removed Task 29) — needed because `topo_scene.js` (Task 13) destructures `NetMap` at its own top level (`const { DEVICE_W, ... } = NetMap;` on line 9, before any function), and `topo_scene.js`'s `<script>` tag does not flip to module until Task 13. Since `netmap.js`'s tag flips to module now, and `topo_scene.js` stays classic non-deferred until Task 13, `topo_scene.js` running before `netmap.js` executes is exactly the hazard: the bridge (`window.NetMap`) covers it because `netmap.js`, though deferred, still runs before the DOMContentLoaded/boot() sequence that would need it — but `topo_scene.js`'s own top-level destructure runs at parse time, immediately, which is *before* any deferred script including `netmap.js`. This means the bridge alone is not sufficient for `topo_scene.js` specifically until `topo_scene.js`'s own tag also becomes `type="module"` at Task 13 — tracked there, not here (this task cannot pre-empt Task 13's own HTML edit since `topo_scene.js` is not yet touched by this task).

- [ ] **Step 1: Add `export` and the `window` bridge**

`internal/httpapi/web/netmap.js`:
```diff
-const NetMap = (() => {
+const NetMap = (() => {
   const DEVICE_W = 140;
   ...
   return Object.freeze({
     DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_COLORS, KINDS,
     center, linkOffsets, spreadOffset, pointAt, insertIndex, cloudSegs,
   });
 })();
+
+export { NetMap };
+window.NetMap = NetMap; // TODO(Task 29): remove once every classic-script consumer imports NetMap directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/netmap.test.js`, replace lines 1-11:
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const { NetMap } = await import(path.join(__dirname, "netmap.js"));

  test("insertIndex finds the closest segment of a polyline", () => {
```
Indent the remaining test one level, close with `})();`.

- [ ] **Step 3: Flip `netmap.js`'s tag in `diagnose.html` and `topology.html`**

`internal/httpapi/web/diagnose.html`:
```diff
 <script type="module" src="/camera.js"></script>
-<script src="/minimap.js"></script>
-<script src="/camera_input.js"></script>
-<script src="/netmap.js"></script>
+<script src="/minimap.js"></script>
+<script src="/camera_input.js"></script>
+<script type="module" src="/netmap.js"></script>
```
Same single-line change (`netmap.js` only) in `internal/httpapi/web/topology.html`.

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/netmap.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: unaffected (nothing yet imports `NetMap` directly; the bridge covers all current bare-global readers).

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/netmap.js internal/httpapi/web/netmap.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert netmap.js to an ES module"
```

---

## Task 8: `canvas_view.js`

**Files:**
- Modify: `internal/httpapi/web/canvas_view.js:6`, `:121`
- Modify: `internal/httpapi/web/canvas_view.test.js:1-42`
- Modify: `internal/httpapi/web/diagnose.html`, `internal/httpapi/web/topology.html` (flip `canvas_view.js`'s tag)
- Test: `internal/httpapi/web/canvas_view.test.js`

**Interfaces:**
- Produces: `export const CanvasView` — `{ create }` (unchanged shape). `window.CanvasView` bridge added (removed Task 29) — `diagnose.js`/`topology.js` call `CanvasView.create(...)` only inside `boot()` (verified lines 851/1319), no top-level hazard.

- [ ] **Step 1: Add `export`, drop the dead CommonJS interop line, add the bridge**

`internal/httpapi/web/canvas_view.js`:
```diff
-const CanvasView = (() => {
+const CanvasView = (() => {
   const raf = ...
   ...
   return Object.freeze({ create });
 })();
-
-if (typeof module !== "undefined") module.exports = CanvasView;
+
+export { CanvasView };
+window.CanvasView = CanvasView; // TODO(Task 29): remove once every classic-script consumer imports CanvasView directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/canvas_view.test.js`, `canvas_view.js` depends on `HitTest` (already converted, Task 4) for `paintIfVisible`'s bbox culling — this test loads `hit_test.js` and `canvas_view.js` together into one sandbox today; with real modules, importing `canvas_view.js` alone is enough since it will (once Task 9 is not needed here — `canvas_view.js` does not itself get an `import` statement in this task, since HitTest is read as `window.HitTest` bridge set by Task 4, not a static import; this task only converts `canvas_view.js`'s own export surface). Replace lines 1-42 (loader + `boot`):
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// recorder: ctx-стаб, записывающий вызовы методов canvas 2d context
function makeCtx() {
  const calls = [];
  const handler = {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => calls.push([prop, args]);
    },
    set(t, prop, v) { t[prop] = v; calls.push(["set:" + prop, [v]]); return true; },
  };
  const ctx = new Proxy({}, handler);
  ctx.calls = calls;
  return ctx;
}

(async () => {
  const { CanvasView } = await import(path.join(__dirname, "canvas_view.js"));

  function boot(list, cam, getOverlay) {
    const canvas = {
      clientWidth: 1200, clientHeight: 800, style: {},
      listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      getContext: () => makeCtx(),
    };
    global.window = { addEventListener() {}, devicePixelRatio: 1 };
    global.Path2D = class {};               // стаб для kind:"glyph"
    global.requestAnimationFrame = undefined; // синхронный режим тестов
    const view = CanvasView.create(canvas, { getList: () => list, getCam: () => cam, getOverlay });
    return { view, canvas, lastCtx: () => view._ctxForTest() };
  }

  const CAM = { x: 0, y: 0, z: 1 };

  test("draw applies camera transform and paints primitives", () => {
```
`HitTest.bbox` is called from inside `canvas_view.js`'s `paintIfVisible` as a bare global — with `hit_test.js` already converted to a module in Task 4 (which set `window.HitTest`) but **not loaded by this test file**, `HitTest` would be `undefined` in this Node process unless imported. Add one line inside the async IIFE, before `boot` is defined:
```js
  await import(path.join(__dirname, "hit_test.js")); // populates window.HitTest for canvas_view.js's bare reference
```
Indent the remaining 4 `test(...)` blocks one level, close the file with `})();`.

- [ ] **Step 3: Flip `canvas_view.js`'s tag in `diagnose.html` and `topology.html`**

`internal/httpapi/web/diagnose.html`:
```diff
 <script src="/tween.js"></script>
 <script src="/canvas_theme.js"></script>
 <script src="/hit_test.js"></script>
-<script src="/canvas_view.js"></script>
+<script type="module" src="/canvas_view.js"></script>
```
Same single-line change in `internal/httpapi/web/topology.html`.

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/canvas_view.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/canvas_view.js internal/httpapi/web/canvas_view.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert canvas_view.js to an ES module"
```

---

## Task 9: `camera_input.js`

**Files:**
- Modify: `internal/httpapi/web/camera_input.js:7`
- Modify: `internal/httpapi/web/camera_input.test.js:1-56`
- Modify: `internal/httpapi/web/diagnose.html`, `internal/httpapi/web/topology.html` (flip `camera_input.js`'s tag)
- Test: `internal/httpapi/web/camera_input.test.js`

**Interfaces:**
- Produces: `export const CameraControls` — `{ wire }` (unchanged shape). `window.CameraControls` bridge added (removed Task 29) — `diagnose.js`/`topology.js` call `CameraControls.wire(...)` only inside `boot()` (lines 825/364), no top-level hazard. `camera_input.js` itself reads `Camera.zoomAt(...)` at line 35, inside the nested `schedule` function — bare global read, resolved via `window.Camera` (bridge set by Task 2), no import needed since this task keeps the file's internals otherwise unchanged.

- [ ] **Step 1: Add `export` and the bridge**

`internal/httpapi/web/camera_input.js`:
```diff
-const CameraControls = (() => {
+const CameraControls = (() => {
   function wire(svg, { getCam, setCam, buttons = [0, 1], onChange, onDragEnd }) {
     ...
   }

   return Object.freeze({ wire });
 })();
+
+export { CameraControls };
+window.CameraControls = CameraControls; // TODO(Task 29): remove once every classic-script consumer imports CameraControls directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/camera_input.test.js`, replace lines 38-56 (`boot`) and the top requires (lines 1-9):
```js
"use strict";

// Unit-тесты ввода холста: зум колесом и пан перетаскиванием.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function makeEl(tag) {
  const el = {
    tag,
    attrs: {},
    listeners: {},
    _classes: new Set(),
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
  };
  el.classList = {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

const fire = (target, type, ev) => {
  ev.type = type;
  ev.preventDefault ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
};

(async () => {
  await import(path.join(__dirname, "camera.js")); // populates window.Camera for camera_input.js's bare reference
  const { CameraControls: Controls } = await import(path.join(__dirname, "camera_input.js"));

  function boot() {
    const doc = makeEl("#document");
    global.document = doc;
    const svg = makeEl("svg");
    let cam = { x: 0, y: 0, z: 1 };
    const wire = (buttons, opts = {}) => Controls.wire(svg, {
      getCam: () => cam,
      setCam: (c) => { cam = c; },
      buttons,
      ...opts,
    });
    return { doc, svg, wire, cam: () => cam };
  }

  // Координаты указателя берутся из прямоугольника холста: зум и пан
  // считаются относительно него, а не окна.
  test("pan applies the pointer delta relative to the canvas rect", () => {
```
Indent the remaining test body one level (unchanged assertions), close the file with `})();`.

- [ ] **Step 3: Flip `camera_input.js`'s tag in `diagnose.html` and `topology.html`**

`internal/httpapi/web/diagnose.html`:
```diff
 <script src="/minimap.js"></script>
-<script src="/camera_input.js"></script>
+<script type="module" src="/camera_input.js"></script>
```
Same single-line change in `internal/httpapi/web/topology.html`.

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/camera_input.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/camera_input.js internal/httpapi/web/camera_input.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert camera_input.js to an ES module"
```

---

## Task 10: `minimap.js`

**Files:**
- Modify: `internal/httpapi/web/minimap.js:6`
- Modify: `internal/httpapi/web/minimap.test.js:1-16`
- Modify: `internal/httpapi/web/diagnose.html`, `internal/httpapi/web/topology.html` (flip `minimap.js`'s tag)
- Test: `internal/httpapi/web/minimap.test.js`

**Interfaces:**
- Produces: `export const Minimap` — `{ layout, overflows, viewportRect, create }` (unchanged shape). `window.Minimap` bridge added (removed Task 29) — `diagnose.js`/`topology.js` call `Minimap.create(...)` only inside `boot()` (lines 857/1325), no top-level hazard. `minimap.js` itself reads `Camera.screenToWorld`/`Camera.worldToScreen` (lines 25-28, 54, 78) inside nested functions only — resolved via the `window.Camera` bridge from Task 2.

- [ ] **Step 1: Add `export` and the bridge**

`internal/httpapi/web/minimap.js`:
```diff
-const Minimap = (() => {
+const Minimap = (() => {
   function layout(b, mw, mh, pad) {
     ...
   }
   ...
   return Object.freeze({ layout, overflows, viewportRect, create });
 })();
+
+export { Minimap };
+window.Minimap = Minimap; // TODO(Task 29): remove once every classic-script consumer imports Minimap directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/minimap.test.js`, replace lines 1-16:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  await import(path.join(__dirname, "camera.js")); // populates window.Camera for minimap.js's bare reference
  const { Minimap } = await import(path.join(__dirname, "minimap.js"));

  async function loadMinimap() {
    return Minimap;
  }

  // worldToScreen mirrors Camera's transform without needing the vm's Camera
  // in this file's own scope.
  const worldToScreen = (map, wx, wy) => ({ x: wx * map.z + map.x, y: wy * map.z + map.y });
  const screenToWorld = (cam, sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
  // objects are now plain, deepEqual needs no copying
  const rect = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });

  test("layout centers a wide bbox constrained by width", async () => {
    const Minimap = await loadMinimap();
```
Every existing test keeps its `const Minimap = loadMinimap();` line, now `const Minimap = await loadMinimap();` inside an `async` test callback (the extra indirection through `loadMinimap()` matches the original file's shape so the diff to each of the 5 test bodies is exactly "add `async`/`await`"). Close the file with `})();` after the last test.

- [ ] **Step 3: Flip `minimap.js`'s tag in `diagnose.html` and `topology.html`**

`internal/httpapi/web/diagnose.html`:
```diff
-<script src="/minimap.js"></script>
+<script type="module" src="/minimap.js"></script>
```
Same single-line change in `internal/httpapi/web/topology.html`.

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/minimap.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/minimap.js internal/httpapi/web/minimap.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert minimap.js to an ES module"
```

---

## Task 11: `net_info.js`

**Files:**
- Modify: `internal/httpapi/web/net_info.js:6`
- Modify: `internal/httpapi/web/net_info.test.js:32-49`
- Modify: `internal/httpapi/web/diagnose.html`, `internal/httpapi/web/topology.html` (flip `net_info.js`'s tag)
- Test: `internal/httpapi/web/net_info.test.js`

**Interfaces:**
- Produces: `export const NetInfo` — `{ show, hide, attach }` (unchanged shape). `window.NetInfo` bridge added (removed Task 29) — `diagnose.js`/`topology.js` call `NetInfo.show`/`NetInfo.attach` only inside functions (lines 239, 871 in diagnose.js; similar in topology.js), no top-level hazard.

- [ ] **Step 1: Add `export` and the bridge**

`internal/httpapi/web/net_info.js`:
```diff
-const NetInfo = (() => {
+const NetInfo = (() => {
   const PLACE = { w: 280, h: 90, margin: 8 };
   ...
   return Object.freeze({ show, hide, attach });
 })();
+
+export { NetInfo };
+window.NetInfo = NetInfo; // TODO(Task 29): remove once every classic-script consumer imports NetInfo directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/net_info.test.js`, replace lines 32-49 (`boot`) and drop the `vm` require from the top:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Minimal DOM stub sufficient to drive net_info.js outside a browser.
function makeEl(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...cs) { this.children.push(...cs); },
    remove() {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text || ""; },
  };
}

(async () => {
  const { NetInfo } = await import(path.join(__dirname, "net_info.js"));

  function boot() {
    const canvas = makeEl("svg");
    const box = makeEl("div");
    box.hidden = true;
    const doc = {
      readyState: "complete",
      listeners: {},
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => (id === "net-info" ? box : null),
      addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    };
    return { canvas, doc, box, get: null, NetInfo };
  }
```
The rest of the file's tests call `get(expr)` to reach into the sandbox for arbitrary expressions — check its remaining usages (`command grep -n "get(" internal/httpapi/web/net_info.test.js`) and replace each with a direct reference to the already-imported `NetInfo` (e.g. `get("NetInfo.show")` becomes plain `NetInfo.show`). Close the file with `})();` after the last test.

- [ ] **Step 3: Flip `net_info.js`'s tag in `diagnose.html` and `topology.html`**

`internal/httpapi/web/diagnose.html`:
```diff
-<script src="/net_info.js"></script>
+<script type="module" src="/net_info.js"></script>
```
Same single-line change in `internal/httpapi/web/topology.html`.

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/net_info.test.js`
Expected: PASS (same test count as before this task).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/net_info.js internal/httpapi/web/net_info.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert net_info.js to an ES module"
```

---

## Task 12: `topology_sync.js`

**Files:**
- Modify: `internal/httpapi/web/topology_sync.js:20`
- Modify: `internal/httpapi/web/topology_sync.test.js:13-21`
- Modify: `internal/httpapi/web/topology.html` (flip `topology_sync.js`'s tag — not loaded by `diagnose.html`)
- Test: `internal/httpapi/web/topology_sync.test.js`

**Interfaces:**
- Produces: `export const TopologySync` — `{ create }` (unchanged shape). No `window` bridge needed as a *dependency* concern (this file has zero external dependencies, by its own docstring), but a bridge is still added because `topology.js` (Task 16) reads `TopologySync.create(...)` as a bare global until then.

- [ ] **Step 1: Add `export` and the bridge**

`internal/httpapi/web/topology_sync.js`:
```diff
-const TopologySync = (() => {
+const TopologySync = (() => {
   const SAVING = "saving";
   ...
   return { create };
 })();
+
+export { TopologySync };
+window.TopologySync = TopologySync; // TODO(Task 29): remove once topology.js imports TopologySync directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/topology_sync.test.js`, replace lines 1-21:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  const { TopologySync } = await import(path.join(__dirname, "topology_sync.js"));

  test("queue serializes commands and projects later pending commands over a canonical response", async () => {
```
Indent the remaining tests one level, close with `})();`.

- [ ] **Step 3: Flip `topology_sync.js`'s tag in `topology.html`**

```diff
 <script src="/link_panel.js"></script>
-<script src="/topology_sync.js"></script>
+<script type="module" src="/topology_sync.js"></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/topology_sync.test.js`
Expected: PASS (same test count as before this task).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/topology_sync.js internal/httpapi/web/topology_sync.test.js internal/httpapi/web/topology.html
git commit -m "refactor(web): convert topology_sync.js to an ES module"
```

---

## Task 13: `topo_scene.js`

**Files:**
- Modify: `internal/httpapi/web/topo_scene.js:8`
- Modify: `internal/httpapi/web/topo_scene.test.js:1-20`
- Modify: `internal/httpapi/web/diagnose.html`, `internal/httpapi/web/topology.html` (flip `topo_scene.js`'s tag)
- Test: `internal/httpapi/web/topo_scene.test.js`

**Interfaces:**
- Produces: `export const TopoScene` — `{ ensureLayout, buildScene, bounds }` (unchanged shape). `window.TopoScene` bridge added (removed Task 29). `topo_scene.js` itself has the same top-level-destructure hazard as `diagnose.js`/`topology.js` did in Task 2 (`const { DEVICE_W, ... } = NetMap;` at line 9, the first line of its IIFE) — but its own tag flips to `type="module"` *in this same task* (not pre-emptively, unlike Task 2's special case), because nothing downstream of `topo_scene.js` reads *its* exports at top level, so there is no other file whose tag needs to move early on `topo_scene.js`'s account. The hazard this task must not reintroduce is the reverse: `topo_scene.js`'s tag must flip in the *same* task as its `export` is added, otherwise a still-classic `topo_scene.js` would run before `netmap.js`'s deferred module (converted in Task 7) sets `window.NetMap`, even with the bridge in place — since bridges fix visibility, not order, exactly as analyzed in Task 2.

- [ ] **Step 1: Add `export` and the bridge**

`internal/httpapi/web/topo_scene.js`:
```diff
-const TopoScene = (() => {
+const TopoScene = (() => {
   const { DEVICE_W, DEVICE_H, NET_W, NET_H, KINDS, center, linkOffsets, spreadOffset, pointAt, cloudSegs, UNION_COLORS } = NetMap;
   ...
   return Object.freeze({ ensureLayout, buildScene, bounds });
 })();
+
+export { TopoScene };
+window.TopoScene = TopoScene; // TODO(Task 29): remove once every classic-script consumer imports TopoScene directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/topo_scene.test.js`, replace lines 1-12:
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  await import(path.join(__dirname, "netmap.js")); // populates window.NetMap for topo_scene.js's top-level destructure
  const { TopoScene } = await import(path.join(__dirname, "topo_scene.js"));
  const { CanvasTheme } = await import(path.join(__dirname, "canvas_theme.js"));

  const theme = CanvasTheme.create({
```
Indent the rest of the file (the `scene` helper and both `test(...)` blocks) one level, close with `})();`.

- [ ] **Step 3: Flip `topo_scene.js`'s tag in `diagnose.html` and `topology.html`**

`internal/httpapi/web/diagnose.html`:
```diff
 <script type="module" src="/canvas_view.js"></script>
-<script src="/topo_scene.js"></script>
+<script type="module" src="/topo_scene.js"></script>
 <script type="module" src="/net_info.js"></script>
```
`internal/httpapi/web/topology.html`:
```diff
 <script type="module" src="/net_info.js"></script>
 <script src="/link_panel.js"></script>
-<script src="/topo_scene.js"></script>
+<script type="module" src="/topo_scene.js"></script>
 <script type="module" src="/topology_sync.js"></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/topo_scene.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: all still PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/topo_scene.js internal/httpapi/web/topo_scene.test.js internal/httpapi/web/diagnose.html internal/httpapi/web/topology.html
git commit -m "refactor(web): convert topo_scene.js to an ES module"
```

---

## Task 14: `link_panel.js`

**Files:**
- Modify: `internal/httpapi/web/link_panel.js:10`, `:282`
- Modify: `internal/httpapi/web/link_panel.test.js:89-92`
- Modify: `internal/httpapi/web/topology.html` (flip `link_panel.js`'s tag — not loaded by `diagnose.html`)
- Test: `internal/httpapi/web/link_panel.test.js`

**Interfaces:**
- Produces: `export const LinkPanel` — `{ show, hide, attach }` (unchanged shape). `window.LinkPanel` bridge added (removed Task 29) — only consumer is `topology.js` (Task 16), inside functions only. `link_panel.js` itself reads `showBanner` (line 240) guarded by `typeof showBanner === "function"` — already resolved via the `window.showBanner` bridge from Task 6, no change needed here.

- [ ] **Step 1: Add `export`, drop the dead CommonJS interop line, add the bridge**

`internal/httpapi/web/link_panel.js`:
```diff
-const LinkPanel = (() => {
+const LinkPanel = (() => {
   const PLACE = { w: 380, h: 320, margin: 8 };
   ...
   return Object.freeze({ show, hide, attach });
 })();
-
-if (typeof module !== "undefined") module.exports = LinkPanel;
+
+export { LinkPanel };
+window.LinkPanel = LinkPanel; // TODO(Task 29): remove once topology.js imports LinkPanel directly
```

- [ ] **Step 2: Rewrite the test loader to `import()`**

`internal/httpapi/web/link_panel.test.js`, replace lines 1-7 and lines 89-92 (the `boot` function's loader lines):
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
```
and, inside `boot()`, replace:
```diff
-  sandbox.globalThis = sandbox;
-  vm.createContext(sandbox);
-  vm.runInContext(fs.readFileSync(path.join(__dirname, "link_panel.js"), "utf8"), sandbox, { filename: "link_panel.js" });
-  const get = (expr) => vm.runInContext(expr, sandbox);
+  const get = () => LinkPanel;
```
and wrap the whole file (from the first `function makeEl` through the last `test(...)`) in a top-level `(async () => { const { LinkPanel } = await import(path.join(__dirname, "link_panel.js")); ... })();` IIFE. Check remaining `get("LinkPanel.X")`-style expression strings in the test bodies (`command grep -n 'get("' internal/httpapi/web/link_panel.test.js`) and replace each with direct `LinkPanel.X` property access.

- [ ] **Step 3: Flip `link_panel.js`'s tag in `topology.html`**

```diff
-<script src="/link_panel.js"></script>
+<script type="module" src="/link_panel.js"></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/link_panel.test.js`
Expected: PASS (same test count as before this task).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/link_panel.js internal/httpapi/web/link_panel.test.js internal/httpapi/web/topology.html
git commit -m "refactor(web): convert link_panel.js to an ES module"
```

---

## Task 15: `diagnose.js` + `diagnose.html`

**Files:**
- Modify: `internal/httpapi/web/diagnose.js:6`, `:887-892`
- Modify: `internal/httpapi/web/diagnose_page.test.js:165-172` (loader) and every `get("Diagnose....")` call site
- Modify: `internal/httpapi/web/diagnose.html` (collapse the script list to one module tag; `camera.js`/`netmap.js`/`canvas_view.js`/`topo_scene.js` tags already `type="module"` from Tasks 2/7/8/13 — the rest still need flipping)
- Test: `internal/httpapi/web/diagnose_page.test.js`

**Interfaces:**
- Consumes (real `import`, replacing the bare-global reads at the top of the file): `NetMap` (`./netmap.js`), `Camera` (`./camera.js`), `CameraControls` (`./camera_input.js`), `CanvasTheme` (`./canvas_theme.js`), `CanvasView` (`./canvas_view.js`), `HitTest` (`./hit_test.js`), `Minimap` (`./minimap.js`), `NetInfo` (`./net_info.js`), `TopoScene` (`./topo_scene.js`), `Tween` (`./tween.js`), `Api`, `showBanner`, `apiPath` (`./common.js`).
- Produces: `export const Diagnose` — unchanged shape (`{ boot, renderReport, run, resetResult, state, expandHighlight, expandFlow, flowMark, resolveSpreadSources, mergeFlows, runSpread }`), consumed only by `diagnose_page.test.js` (no other file imports `Diagnose`).

- [ ] **Step 1: Add the `import` block and `export` to `diagnose.js`**

`internal/httpapi/web/diagnose.js`:
```diff
 "use strict";

+import { NetMap } from "./netmap.js";
+import { Camera } from "./camera.js";
+import { CameraControls } from "./camera_input.js";
+import { CanvasTheme } from "./canvas_theme.js";
+import { CanvasView } from "./canvas_view.js";
+import { HitTest } from "./hit_test.js";
+import { Minimap } from "./minimap.js";
+import { NetInfo } from "./net_info.js";
+import { TopoScene } from "./topo_scene.js";
+import { Tween } from "./tween.js";
+import { Api, showBanner, apiPath } from "./common.js";
+
 // Diagnose — карта топологии на canvas с подсветкой путей и отчёт
 // диагностики трафика (POST /api/diagnose). Карта только для чтения:
 // перетаскивание узлов и правка — на /ui/topology.
-const Diagnose = (() => {
+const Diagnose = (() => {
   const { DEVICE_W, DEVICE_H, NET_W, NET_H } = NetMap;
   ...
   return {
     boot, renderReport, run, resetResult, state, expandHighlight, expandFlow, flowMark,
     resolveSpreadSources, mergeFlows, runSpread,
   };
 })();
+export { Diagnose };

 if (document.readyState === "loading") {
   document.addEventListener("DOMContentLoaded", Diagnose.boot);
 } else {
   Diagnose.boot();
 }
```
Search the file body for any other bare reference to `apiPath`/`Api`/`showBanner` outside this preamble — they already resolve correctly against the imported bindings since `import` creates the same kind of module-scope binding a top-level `const` would.

- [ ] **Step 2: Rewrite the `diagnose_page.test.js` loader**

Replace the loader block at lines 155-172 (the `sandbox.globalThis = sandbox; vm.createContext(...); for (const f of [...]) vm.runInContext(...)`) with:
```js
  global.document = doc;
  global.window = { dispatchEvent: notify, addEventListener() {}, devicePixelRatio: 1 };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  global.confirm = () => true;
  global.getComputedStyle = () => ({ getPropertyValue: () => "" });
  global.fetch = fetch; // the fetch defined just above in this function
  const modulePath = path.join(__dirname, "diagnose.js") + `?t=${Date.now()}-${Math.random()}`;
  const { Diagnose } = await import(modulePath);
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
```
(match whichever `sandbox.*` properties this specific fixture set — copy every key that was on the old `sandbox` object onto `global` instead, keeping the same values; the cache-busting query string is required here because `bootPage`/`boot`-style helpers in this file are called once per `test()` and each expects a fresh `Diagnose.state`, which is module-level mutable state now — a plain `import()` would return the same cached instance across every test in the file, and `state.result`/`state.list`/`state.hl` from one test would leak into the next). Change the enclosing boot function to `async` and every one of its callers in the `test(...)` blocks to `await` it (they already are `async` per the existing file's pattern — verify with `command grep -n "^test(" internal/httpapi/web/diagnose_page.test.js`).

Replace the `get` helper (previously `(expr) => vm.runInContext(expr, sandbox)`) with:
```js
  const get = (expr) => new Function("Diagnose", "window", "document", `return (${expr});`)(Diagnose, global.window, doc);
```
This keeps all 37 existing `get("Diagnose.state...")`/`get("JSON.stringify(...)")` call sites in the test bodies below completely unchanged — `new Function` evaluates the string against exactly the three names the expressions use (verified: every occurrence starts with `Diagnose.` or `JSON.` or is a bare `r` referring to a local variable already in scope in the calling test, not through `get`).

- [ ] **Step 3: Collapse `diagnose.html`'s script list to one entry module**

`internal/httpapi/web/diagnose.html`:
```diff
 <script type="module" src="/common.js"></script>
-<script type="module" src="/camera.js"></script>
-<script src="/minimap.js"></script>
-<script src="/camera_input.js"></script>
-<script type="module" src="/netmap.js"></script>
-<script src="/tween.js"></script>
-<script src="/canvas_theme.js"></script>
-<script src="/hit_test.js"></script>
-<script type="module" src="/canvas_view.js"></script>
-<script type="module" src="/topo_scene.js"></script>
-<script type="module" src="/net_info.js"></script>
 <script type="module" src="/diagnose.js"></script>
 <script src="/alpine.min.js" defer></script>
```
`diagnose.js`'s own `import` statements (Step 1) now pull in `camera.js`, `netmap.js`, `canvas_theme.js`, `canvas_view.js`, `hit_test.js`, `minimap.js`, `net_info.js`, `topo_scene.js`, `tween.js` — the separate `<script>` tags for those files are redundant and removed. `camera_input.js` is used by `diagnose.js` too (`CameraControls`) — its `import` was added in Step 1; the standalone `<script src="/camera_input.js">` tag is dropped as well:
```diff
 <script type="module" src="/common.js"></script>
 <script type="module" src="/diagnose.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/diagnose_page.test.js`
Expected: PASS (all existing tests in the file).

- [ ] **Step 5: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: all PASS — no other test file imports `diagnose.js`.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/diagnose.js internal/httpapi/web/diagnose_page.test.js internal/httpapi/web/diagnose.html
git commit -m "refactor(web): convert diagnose.js to an ES module, collapse diagnose.html's script list"
```

---

## Task 16: `topology.js` + `topology.html`

**Files:**
- Modify: `internal/httpapi/web/topology.js:1-13` (imports), `:1379-1385` (export + tail)
- Modify: `internal/httpapi/web/topology_render.test.js` and `internal/httpapi/web/topology_search.test.js` (loader + `get()` shim)
- Modify: `internal/httpapi/web/topology.html` (collapse to one module tag)
- Test: `internal/httpapi/web/topology_render.test.js`, `internal/httpapi/web/topology_search.test.js`

**Interfaces:**
- Consumes: `NetMap` (`./netmap.js`), `Camera` (`./camera.js`), `CameraControls` (`./camera_input.js`), `CanvasTheme` (`./canvas_theme.js`), `CanvasView` (`./canvas_view.js`), `HitTest` (`./hit_test.js`), `Minimap` (`./minimap.js`), `NetInfo` (`./net_info.js`), `LinkPanel` (`./link_panel.js`), `TopoScene` (`./topo_scene.js`), `Tween` (`./tween.js`), `TopologySync` (`./topology_sync.js`), `Api`, `showBanner`, `apiPath`, `assertEditable`, `DirtyGuard`, `currentDraftID`, `isReadOnly`, `containsFold` (`./common.js`).
- Produces: `export const Topology` — unchanged shape (`{ render, boot }`); `export const State` — the module-level mutable state object, needed by `topology_render.test.js`/`topology_search.test.js`'s `get("State...")` expressions.

This is the last consumer of every Phase 1-3 bridge except `showBanner`/`Api`/`apiPath`/`assertEditable`/`containsFold` (still used by the remaining 11 CRUD/simple pages) — Task 29 removes the `Camera`, `NetMap`, `CameraControls`, `CanvasTheme`, `CanvasView`, `HitTest`, `Minimap`, `NetInfo`, `LinkPanel`, `TopoScene`, `Tween`, `TopologySync`, `DirtyGuard`, `isReadOnly`, `currentDraftID` (partially — `drafts.js` still needs it until Task 23) bridges once this task lands.

- [ ] **Step 1: Add the `import` block and exports to `topology.js`**

`internal/httpapi/web/topology.js`:
```diff
 "use strict";

+import { NetMap } from "./netmap.js";
+import { Camera } from "./camera.js";
+import { CameraControls } from "./camera_input.js";
+import { CanvasTheme } from "./canvas_theme.js";
+import { CanvasView } from "./canvas_view.js";
+import { HitTest } from "./hit_test.js";
+import { Minimap } from "./minimap.js";
+import { NetInfo } from "./net_info.js";
+import { LinkPanel } from "./link_panel.js";
+import { TopoScene } from "./topo_scene.js";
+import { Tween } from "./tween.js";
+import { TopologySync } from "./topology_sync.js";
+import { Api, showBanner, apiPath, assertEditable, DirtyGuard, currentDraftID, isReadOnly, containsFold } from "./common.js";
+
-const State = {
+export const State = {
   ...
 };
```
and at the tail:
```diff
   const Topology = {
     render,
     boot,
   };
   return Topology;
 })();
+export { Topology };

 if (document.readyState === "loading") {
   document.addEventListener("DOMContentLoaded", Topology.boot);
 } else {
   Topology.boot();
 }
```

- [ ] **Step 2: Rewrite the `topology_render.test.js` loader**

Replace the loader block (lines ~230-284 depending on the fixture in that test's `boot()`, ending at the `for (const f of [...]) vm.runInContext(...)` loop) — copy every `sandbox.*` key onto `global.*` the same way as Task 15, then:
```js
  const modulePath = path.join(__dirname, "topology.js") + `?t=${Date.now()}-${Math.random()}`;
  const { Topology, State } = await import(modulePath);
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  const get = (expr) => new Function("State", "Topology", "DirtyGuard", "window", "document",
    `return (${expr});`)(State, Topology, (await import(path.join(__dirname, "common.js"))).DirtyGuard, global.window, doc);
```
Cache-busting is required: `State` is module-level mutable state, and this file's `boot()`-equivalent helper is invoked once per test expecting a fresh topology. Every one of the 30 existing `get("State....")`/`get("DirtyGuard....")` call sites in the test bodies stays unchanged. Mark the enclosing boot helper `async` and its callers `await` it.

- [ ] **Step 3: Rewrite the `topology_search.test.js` loader**

Same transformation as Step 2, applied to this file's own `boot()`-equivalent helper (lines ~90-140) — it loads the identical 14-file list, so the replacement loader block is byte-identical to Step 2's.

- [ ] **Step 4: Collapse `topology.html`'s script list to one entry module**

`internal/httpapi/web/topology.html`:
```diff
 <script type="module" src="/common.js"></script>
-<script type="module" src="/camera.js"></script>
-<script src="/minimap.js"></script>
-<script src="/camera_input.js"></script>
-<script type="module" src="/netmap.js"></script>
-<script src="/tween.js"></script>
-<script src="/canvas_theme.js"></script>
-<script src="/hit_test.js"></script>
-<script type="module" src="/canvas_view.js"></script>
-<script src="/net_info.js"></script>
-<script src="/link_panel.js"></script>
-<script type="module" src="/topo_scene.js"></script>
-<script type="module" src="/topology_sync.js"></script>
 <script type="module" src="/topology.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 5: Run the tests**

Run: `node --test internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js`
Expected: PASS (all existing tests in both files).

- [ ] **Step 6: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/web/topology.js internal/httpapi/web/topology_render.test.js internal/httpapi/web/topology_search.test.js internal/httpapi/web/topology.html
git commit -m "refactor(web): convert topology.js to an ES module, collapse topology.html's script list"
```

---

## Task 17: `networks.js` + `networks.html`

**Files:**
- Modify: `internal/httpapi/web/networks.js:1-12`
- Modify: `internal/httpapi/web/networks_page.test.js` (loader)
- Modify: `internal/httpapi/web/networks.html`
- Test: `internal/httpapi/web/networks_page.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath, assertEditable, containsFold, matchSubnetMembers` (`./common.js`), `makeColumnsResizable, initializeColumns` (`./columns.js`).
- Produces: nothing (page controller, no other `.js` file imports `networks.js`).

- [ ] **Step 1: Add the `import` block to `networks.js`**

`internal/httpapi/web/networks.js`:
```diff
 "use strict";

+import { Api, showBanner, apiPath, assertEditable, containsFold, matchSubnetMembers } from "./common.js";
+import { makeColumnsResizable, initializeColumns } from "./columns.js";
+
 // Networks page: table over topology.yaml networks; ...
 const NETWORKS_COL_WIDTHS_KEY = "firenet-networks-col-widths-v1";
 const NETWORKS_COL_WIDTHS_VERSION = 1;

 document.addEventListener("alpine:init", () => {
```

- [ ] **Step 2: Rewrite the `networks_page.test.js` loader**

Replace the `for (const f of ["common.js", "columns.js", "networks.js"]) { vm.runInContext(...) }` block (and the `sandbox.globalThis = sandbox; vm.createContext(sandbox);` lines before it) with:
```js
  global.document = { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) };
  global.window = { dispatchEvent: notify };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {};
  global.dispatchEvent = notify;
  global.confirm = () => true;
  global.fetch = fetch; // defined above in this function
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  await import(path.join(__dirname, "networks.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
```
Cache-busting is required because `networks.js`'s own module-level `NETWORKS_COL_WIDTHS_KEY`/`VERSION` constants are stateless, but re-registering `Alpine.data("networksPage", ...)` against a fresh `factories` object per test needs the `document.addEventListener("alpine:init", ...)` call inside `networks.js` to run again — a cached module would not re-run its top-level code on a second `import()` of the same URL. Wrap the enclosing `bootPage` function in `async` and mark its call sites `await`ed (check `command grep -n "bootPage(" internal/httpapi/web/networks_page.test.js` for every call site).

- [ ] **Step 3: Flip `networks.html`'s script tags**

`internal/httpapi/web/networks.html`:
```diff
 <script type="module" src="/common.js"></script>
-<script src="/columns.js"></script>
-<script src="/networks.js"></script>
+<script type="module" src="/networks.js"></script>
 <script src="/alpine.min.js" defer></script>
```
(`columns.js`'s tag is dropped — `networks.js`'s own `import` now pulls it in.)

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/networks_page.test.js`
Expected: PASS (all existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/networks.js internal/httpapi/web/networks_page.test.js internal/httpapi/web/networks.html
git commit -m "refactor(web): convert networks.js to an ES module"
```

---

## Task 18: `rules.js` + `rules.html`

**Files:**
- Modify: `internal/httpapi/web/rules.js:1-12`
- Modify: `internal/httpapi/web/rules_page.test.js` (loader)
- Modify: `internal/httpapi/web/rules.html`
- Test: `internal/httpapi/web/rules_page.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath, assertEditable, containsFold, parseIPv4, parsePrefix, parseQueryPrefix, formatIPv4, prefixContains, prefixOverlap` (`./common.js`), `makeColumnsResizable, initializeColumns` (`./columns.js`).
- Produces: nothing.

- [ ] **Step 1: Add the `import` block to `rules.js`**

`internal/httpapi/web/rules.js`:
```diff
 "use strict";

+import { Api, showBanner, apiPath, assertEditable, containsFold, parseIPv4, parsePrefix, parseQueryPrefix, formatIPv4, prefixContains, prefixOverlap } from "./common.js";
+import { makeColumnsResizable, initializeColumns } from "./columns.js";
+
 // Rules page: client-side table over rules.yaml, mirroring the networks
 // page. ...

 const RULES_COL_WIDTHS_KEY = "firenet-rules-col-widths-v4";
 const RULES_COL_WIDTHS_VERSION = 4;
```
Leave the pre-existing duplicate `function splitPorts(s) {...}` declaration (lines 13-18 and 23-28) exactly as-is — it is a pre-existing bug unrelated to this migration and out of scope.

- [ ] **Step 2: Rewrite the `rules_page.test.js` loader**

Same transformation as Task 17 Step 2, loading `["common.js", "columns.js", "rules.js"]` → `global.*` assignments + `await import(path.join(__dirname, "rules.js") + \`?t=${Date.now()}-${Math.random()}\`)`. `rules.js`'s entry point is `registerRulesPage()`, called at its own top level via `if (typeof document !== "undefined") registerRulesPage();` — this still runs on every fresh `import()` (cache-busted), registering a new `alpine:init` listener each time, matching the current per-test isolation.

- [ ] **Step 3: Flip `rules.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/columns.js"></script>
-<script src="/rules.js"></script>
+<script type="module" src="/rules.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/rules_page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/rules.js internal/httpapi/web/rules_page.test.js internal/httpapi/web/rules.html
git commit -m "refactor(web): convert rules.js to an ES module"
```

---

## Task 19: `sets.js` + `sets.html`

**Files:**
- Modify: `internal/httpapi/web/sets.js:1-11`
- Modify: `internal/httpapi/web/sets_page.test.js` (loader)
- Modify: `internal/httpapi/web/sets.html`
- Test: `internal/httpapi/web/sets_page.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath, assertEditable, containsFold, matchPrefixQuery, matchSubnetMembers` (`./common.js`), `makeColumnsResizable, initializeColumns` (`./columns.js`).
- Produces: nothing.

- [ ] **Step 1: Add the `import` block to `sets.js`**

```diff
 "use strict";

+import { Api, showBanner, apiPath, assertEditable, containsFold, matchPrefixQuery, matchSubnetMembers } from "./common.js";
+import { makeColumnsResizable, initializeColumns } from "./columns.js";
+
 // Sets page: read-only table over topology.yaml sets; ...
```

- [ ] **Step 2: Rewrite the `sets_page.test.js` loader**

Same transformation pattern as Task 17 Step 2, loading `["common.js", "columns.js", "sets.js"]`.

- [ ] **Step 3: Flip `sets.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/columns.js"></script>
-<script src="/sets.js"></script>
+<script type="module" src="/sets.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/sets_page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/sets.js internal/httpapi/web/sets_page.test.js internal/httpapi/web/sets.html
git commit -m "refactor(web): convert sets.js to an ES module"
```

---

## Task 20: `subnets.js` + `subnets.html`

**Files:**
- Modify: `internal/httpapi/web/subnets.js:1-8`
- Modify: `internal/httpapi/web/subnets_page.test.js` (loader)
- Modify: `internal/httpapi/web/subnets.html`
- Test: `internal/httpapi/web/subnets_page.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath, assertEditable, containsFold, ipv4CidrOverlap` (`./common.js`), `makeColumnsResizable, initializeColumns` (`./columns.js`).
- Produces: nothing.

- [ ] **Step 1: Add the `import` block to `subnets.js`**

```diff
 "use strict";

+import { Api, showBanner, apiPath, assertEditable, containsFold, ipv4CidrOverlap } from "./common.js";
+import { makeColumnsResizable, initializeColumns } from "./columns.js";
+
 // Subnets page: read-only table over subnets.yaml via /api/subnets; ...
```

- [ ] **Step 2: Rewrite the `subnets_page.test.js` loader**

Replace the `for (const f of ["common.js", "columns.js", "subnets.js"])` block (lines 49-53) with the same `global.*` + cache-busted `import()` pattern as Task 17 Step 2.

- [ ] **Step 3: Flip `subnets.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/columns.js"></script>
-<script src="/subnets.js"></script>
+<script type="module" src="/subnets.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/subnets_page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/subnets.js internal/httpapi/web/subnets_page.test.js internal/httpapi/web/subnets.html
git commit -m "refactor(web): convert subnets.js to an ES module"
```

---

## Task 21: `unions.js` + `unions.html`

**Files:**
- Modify: `internal/httpapi/web/unions.js:1-11`
- Modify: `internal/httpapi/web/unions_page.test.js` (loader)
- Modify: `internal/httpapi/web/unions.html`
- Test: `internal/httpapi/web/unions_page.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath, assertEditable, containsFold, matchPrefixQuery` (`./common.js`), `makeColumnsResizable, initializeColumns` (`./columns.js`).
- Produces: nothing.

- [ ] **Step 1: Add the `import` block to `unions.js`**

```diff
 "use strict";

+import { Api, showBanner, apiPath, assertEditable, containsFold, matchPrefixQuery } from "./common.js";
+import { makeColumnsResizable, initializeColumns } from "./columns.js";
+
 // Unions page: table over topology.yaml unions; ...
```

- [ ] **Step 2: Rewrite the `unions_page.test.js` loader**

Same pattern, loading `["common.js", "columns.js", "unions.js"]`.

- [ ] **Step 3: Flip `unions.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/columns.js"></script>
-<script src="/unions.js"></script>
+<script type="module" src="/unions.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/unions_page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/unions.js internal/httpapi/web/unions_page.test.js internal/httpapi/web/unions.html
git commit -m "refactor(web): convert unions.js to an ES module"
```

---

## Task 22: `links.js` + `links.html`

**Files:**
- Modify: `internal/httpapi/web/links.js:1-7`
- Modify: `internal/httpapi/web/links_page.test.js` (loader)
- Modify: `internal/httpapi/web/links.html`
- Test: `internal/httpapi/web/links_page.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath, assertEditable, containsFold, matchSubnetMembers` (`./common.js`). No `columns.js` dependency (`links.html` never loaded it).
- Produces: nothing.

- [ ] **Step 1: Add the `import` block to `links.js`**

```diff
 "use strict";

+import { Api, showBanner, apiPath, assertEditable, containsFold, matchSubnetMembers } from "./common.js";
+
 // Links page: table over topology.yaml links. ...

 document.addEventListener("alpine:init", () => {
```

- [ ] **Step 2: Rewrite the `links_page.test.js` loader**

Replace the `for (const f of ["common.js", "links.js"])` block with the `global.*` + cache-busted `import()` pattern (no `columns.js` in this list).

- [ ] **Step 3: Flip `links.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/links.js"></script>
+<script type="module" src="/links.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/links_page.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/links.js internal/httpapi/web/links_page.test.js internal/httpapi/web/links.html
git commit -m "refactor(web): convert links.js to an ES module"
```

---

## Task 23: `drafts.js` + `drafts.html`

**Files:**
- Modify: `internal/httpapi/web/drafts.js:1-6`, `:208`
- Modify: `internal/httpapi/web/drafts.test.js` (loader)
- Modify: `internal/httpapi/web/drafts.html`
- Test: `internal/httpapi/web/drafts.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, currentDraftID, setCurrentDraftID, loginRedirectURL` (`./common.js`).
- Produces: `export const Drafts` — no other `.js` file imports it, but exporting matches the file's existing pattern (`{boot, refresh, selectDraft, loadDiff, deleteDraft, createDraft, confirmSelected, get me(), get drafts(), get selected(), get diffs()}`), consumed by the test.

- [ ] **Step 1: Add the `import` block and export to `drafts.js`**

```diff
 "use strict";

+import { Api, showBanner, currentDraftID, setCurrentDraftID, loginRedirectURL } from "./common.js";
+
 // Drafts page: list your own drafts (or everyone's, for an admin), create,
 ...
 const Drafts = (() => {
   ...
   return {
     boot, refresh, selectDraft, loadDiff, deleteDraft, createDraft, confirmSelected,
     get me() { return me; },
     get drafts() { return drafts; },
     get selected() { return selected; },
     get diffs() { return diffs; },
   };
 })();
+export { Drafts };

 document.addEventListener("DOMContentLoaded", Drafts.boot);
```

- [ ] **Step 2: Rewrite the `drafts.test.js` loader**

Replace the `for (const f of ["common.js", "drafts.js"])` block with the `global.*` + cache-busted `import()` pattern; then:
```js
  const { Drafts } = await import(path.join(__dirname, "drafts.js") + `?t=${Date.now()}-${Math.random()}`);
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  return { Drafts, doc, calls, store };
```
Check the remainder of the file for `get(expr)` or `sandbox.Drafts`-style access (`command grep -n "sandbox\.\|get(" internal/httpapi/web/drafts.test.js`) and switch each to the returned `Drafts` reference directly.

- [ ] **Step 3: Flip `drafts.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/drafts.js"></script>
+<script type="module" src="/drafts.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/drafts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/drafts.js internal/httpapi/web/drafts.test.js internal/httpapi/web/drafts.html
git commit -m "refactor(web): convert drafts.js to an ES module"
```

---

## Task 24: `history.js` + `history.html`

**Files:**
- Modify: `internal/httpapi/web/history.js:1-6`, `:124`
- Modify: `internal/httpapi/web/history.test.js` (loader)
- Modify: `internal/httpapi/web/history.html`
- Test: `internal/httpapi/web/history.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, setCurrentDraftID` (`./common.js`).
- Produces: `export const History` — unchanged shape, consumed only by the test.

- [ ] **Step 1: Add the `import` block and export to `history.js`**

```diff
 "use strict";

+import { Api, showBanner, setCurrentDraftID } from "./common.js";
+
 // Version history: the confirmed-version list, ...
 const History = (() => {
   ...
   return {
     boot, refresh, showDiff, restore,
     get me() { return me; },
     get versions() { return versions; },
     get selectedID() { return selectedID; },
     get diffs() { return diffs; },
   };
 })();
+export { History };

 document.addEventListener("DOMContentLoaded", History.boot);
```

- [ ] **Step 2: Rewrite the `history.test.js` loader**

Same pattern as Task 23 Step 2, loading `["common.js", "history.js"]`.

- [ ] **Step 3: Flip `history.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/history.js"></script>
+<script type="module" src="/history.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/history.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/history.js internal/httpapi/web/history.test.js internal/httpapi/web/history.html
git commit -m "refactor(web): convert history.js to an ES module"
```

---

## Task 25: `compile.js` + `compile.html`

**Files:**
- Modify: `internal/httpapi/web/compile.js:1-8`
- Modify: `internal/httpapi/web/compile.test.js` (loader)
- Modify: `internal/httpapi/web/compile.html`
- Test: `internal/httpapi/web/compile.test.js`

**Interfaces:**
- Consumes: `Api, showBanner, apiPath` (`./common.js`).
- Produces: nothing (`renderDevice`/`runCompile` are not imported elsewhere).

- [ ] **Step 1: Add the `import` block to `compile.js`**

```diff
 "use strict";

+import { Api, showBanner, apiPath } from "./common.js";
+
 // renderDevice builds one device's scripts as text nodes ...
```

- [ ] **Step 2: Rewrite the `compile.test.js` loader**

This file has two boot helpers (`bootCompile` at line 21 and a second one around line 108, per the two `for (const f of ["common.js", "compile.js"])` matches) — apply the same `global.*` + cache-busted `import()` replacement to both.

- [ ] **Step 3: Flip `compile.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/compile.js"></script>
+<script type="module" src="/compile.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/compile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/compile.js internal/httpapi/web/compile.test.js internal/httpapi/web/compile.html
git commit -m "refactor(web): convert compile.js to an ES module"
```

---

## Task 26: `login.js` + `login.html`

**Files:**
- Modify: `internal/httpapi/web/login.js` — no changes to imports (this file has zero `common.js` dependency: it reimplements its own redirect-target parsing, `loginRedirectTarget`, rather than importing `loginRedirectURL`)
- Modify: `internal/httpapi/web/login.test.js:9-18`
- Modify: `internal/httpapi/web/login.html`
- Test: `internal/httpapi/web/login.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function loginRedirectTarget` — consumed only by the test.

`login.html` does not load `common.js` or `alpine.min.js` at all (confirmed: its only script tag is `<script src="/login.js"></script>`) — this task is the simplest in the plan.

- [ ] **Step 1: Add `export` to `login.js`**

```diff
-function loginRedirectTarget(search) {
+export function loginRedirectTarget(search) {
   const next = new URLSearchParams(search).get("next");
   const safe = next && next.startsWith("/") && !next.startsWith("//");
   return safe ? next : "/ui/topology";
 }
```

- [ ] **Step 2: Rewrite the `login.test.js` loader**

Replace lines 1-18:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  global.document = { addEventListener() {} };
  const { loginRedirectTarget } = await import(path.join(__dirname, "login.js"));

  test("loginRedirectTarget defaults to topology when next is missing", () => {
    assert.equal(loginRedirectTarget(""), "/ui/topology");
  });

  test("loginRedirectTarget accepts a same-origin path", () => {
    assert.equal(loginRedirectTarget("?next=%2Fui%2Frules"), "/ui/rules");
  });

  test("loginRedirectTarget rejects a protocol-relative next", () => {
    assert.equal(loginRedirectTarget("?next=%2F%2Fevil.com"), "/ui/topology");
  });

  test("loginRedirectTarget rejects an absolute URL", () => {
    assert.equal(loginRedirectTarget("?next=https%3A%2F%2Fevil.com"), "/ui/topology");
  });
})();
```
`URLSearchParams` is a real Node/browser global (no need for the old `sandbox.URLSearchParams = require("node:url").URLSearchParams` shim).

- [ ] **Step 3: Flip `login.html`'s script tag**

```diff
-<script src="/login.js"></script>
+<script type="module" src="/login.js"></script>
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/login.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/login.js internal/httpapi/web/login.test.js internal/httpapi/web/login.html
git commit -m "refactor(web): convert login.js to an ES module"
```

---

## Task 27: `users.js` + `users.html`

**Files:**
- Modify: `internal/httpapi/web/users.js:1-3`
- Modify: `internal/httpapi/web/users.html`
- Test: none exists for `users.js` today (per `docs/superpowers/plans/2026-08-26-draft-version-ui.md`'s own note: `users.js` "exports nothing, so nothing in it is reachable from a test") — this task adds none, matching that established convention; verification is the full regression run in Step 3.

**Interfaces:**
- Consumes: `showBanner, loginRedirectURL` (`./common.js`).
- Produces: nothing.

- [ ] **Step 1: Add the `import` block to `users.js`**

```diff
 "use strict";

+import { showBanner, loginRedirectURL } from "./common.js";
+
 document.addEventListener("DOMContentLoaded", async () => {
```

- [ ] **Step 2: Flip `users.html`'s script tags**

```diff
 <script type="module" src="/common.js"></script>
-<script src="/users.js"></script>
+<script type="module" src="/users.js"></script>
 <script src="/alpine.min.js" defer></script>
```

- [ ] **Step 3: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: all PASS (no test exercises `users.js` directly; this step exists purely as this task's verification gate, matching the plan's "every task ends with an independently testable deliverable" rule via the full suite rather than a per-file test).

- [ ] **Step 4: Commit**

```bash
git add internal/httpapi/web/users.js internal/httpapi/web/users.html
git commit -m "refactor(web): convert users.js to an ES module"
```

---

## Task 28: Remove every temporary `window.*` bridge

**Files:**
- Modify: `internal/httpapi/web/tween.js`, `camera.js`, `canvas_theme.js`, `hit_test.js`, `columns.js`, `common.js`, `netmap.js`, `canvas_view.js`, `camera_input.js`, `minimap.js`, `net_info.js`, `topology_sync.js`, `topo_scene.js`, `link_panel.js`
- Test: full suite

Every page `.js` file now imports what it needs directly (Tasks 15-27) — no file anywhere in `internal/httpapi/web/*.js` reads any of `Camera`, `NetMap`, `CameraControls`, `CanvasTheme`, `CanvasView`, `HitTest`, `Minimap`, `NetInfo`, `LinkPanel`, `TopoScene`, `Tween`, `TopologySync`, `showBanner`, `Api`, `apiPath`, `assertEditable`, `DirtyGuard`, `currentDraftID`, `setCurrentDraftID`, `isReadOnly`, `loginRedirectURL`, `ipv4CidrOverlap`, `containsFold`, `matchPrefixQuery`, `matchSubnetMembers`, `parseIPv4`, `parsePrefix`, `parseQueryPrefix`, `formatIPv4`, `prefixContains`, `prefixOverlap`, `makeColumnsResizable`, or `initializeColumns` as a bare global anymore. `window.appData` is the one permanent exception (Alpine's `x-data="appData()"` will always need it).

- [ ] **Step 1: Verify no bare-global reads remain**

Run, for each name above: `command grep -rn "\b<Name>\b" internal/httpapi/web/*.js | command grep -v "\.test\.js\|import \|export \|window\.<Name> =\|// TODO(Task 29)"` — expect no output (every remaining occurrence should be inside its own defining file's `export`/module-scope, not a bare cross-file read). Example for `Camera`: `command grep -n "\bCamera\b" internal/httpapi/web/diagnose.js internal/httpapi/web/topology.js` should show only the `import { Camera } from "./camera.js";` line and calls that resolve through it.

- [ ] **Step 2: Delete every `window.X = X; // TODO(Task 29): ...` line**

Remove the one-line bridge assignment (and its trailing `// TODO(Task 29)` comment) added in Tasks 1-14 from: `tween.js`, `camera.js`, `canvas_theme.js`, `hit_test.js`, `columns.js` (both `makeColumnsResizable`/`initializeColumns` lines), `common.js` (every bridge except `window.appData = appData;`, which stays permanently with its comment updated to drop the `Task 29` reference since it is no longer a TODO):
```diff
-window.appData = appData; // permanent: Alpine evaluates x-data="appData()" against the global scope
+window.appData = appData; // Alpine evaluates x-data="appData()" against the global scope; this stays forever, not a migration leftover
```
`netmap.js`, `canvas_view.js`, `camera_input.js`, `minimap.js`, `net_info.js`, `topology_sync.js`, `topo_scene.js`, `link_panel.js`.

- [ ] **Step 3: Full regression run**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: all PASS — every test file already loads its dependencies through real `import()` (Tasks 1-27), so removing the bridges changes nothing observable.

- [ ] **Step 4: Go build/vet/fmt/test (embed content changed)**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./...`
Expected: builds clean, `gofmt -l .` prints nothing, all Go tests PASS (the embedded `web/` tree changed but no Go code reads its contents beyond `go:embed`).

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/*.js
git commit -m "refactor(web): remove temporary window.* bridges now every consumer imports directly"
```

---

## Self-Review

**Spec coverage:**
- "Механика конвертации файлов" (namespace-object files vs flat files) — every task's Step 1 follows exactly this mechanical rule (`export` prepended to the existing declaration, no restructuring).
- "HTML" (single entry module tag per page) — Tasks 15 (diagnose) and 16 (topology) collapse the multi-tag lists; Tasks 17-27 collapse the simpler CRUD/one-dependency pages.
- "Тестовая инфраструктура" (межфайловая изоляция via per-file process, внутрифайловая via `global.*` swap, `.test.js`/CommonJS unchanged, async IIFE for `await import`) — every task's test step follows this pattern; cache-busting query strings are added specifically where a boot-style helper is called more than once per test file and depends on module-level mutable state (`common.js`'s `DirtyGuard`, `topology.js`'s `State`, `diagnose.js`'s `state`, and every `Alpine.data(...)`-registering page controller) — flagged explicitly per task rather than applied blanket, since files with no such state (`Camera`, `NetMap`, `HitTest`, `Tween`, `CanvasTheme`, `TopologySync`, pure page files like `login.js`) don't need it.
- "Порядок миграции" (4 phases, bottom-up) — Tasks 1-6 (phase 1), 7-12 (phase 2), 13-14 (phase 3), 15-27 (phase 4) match exactly.
- "Риски" (script-order hazard, MIME type) — the script-order hazard is resolved concretely: Task 2 identifies and fixes the one genuine case (`camera.js`/`netmap.js` read at top level by `diagnose.js`/`topology.js`), Task 13 resolves the equivalent case for `topo_scene.js` reading `NetMap`, and Task 6 resolves the `alpine.min.js`/`appData` ordering hazard site-wide. The MIME-type risk isn't a task on its own — it surfaces as an observable failure (module script refuses to execute) the first time any task's regression run serves a `type="module"` tag through `go run`/`docker compose`, so no dedicated task carries it; Task 2's first `node --test` run plus a page load during Task 6 or later would surface it immediately if it existed.
- Global Constraints (no package.json, `.test.js`/CommonJS, test glob, 1:1 files, `alpine.min.js` untouched) — verified per-task; no task ever creates a `package.json`, renames a `.test.js` file, or splits/merges a `.js` file.

**Placeholder scan:** every `Step 1`/diff in every task shows the literal before/after code (no "similarly for the rest," no "TBD"); the three exceptions are explicitly bounded, not open-ended — Task 6 Step 2's HTML instruction ("Apply the same two changes to: ...") lists all 14 files by name; Task 15/16's `get()` shims cover verified, counted call-site patterns (37/30/4 occurrences, all matching one of two forms); Task 28 Step 1's grep command is the verification itself, not a placeholder for undone work.

**Type/name consistency:** `Camera`/`NetMap`/`CameraControls`/`CanvasTheme`/`CanvasView`/`HitTest`/`Minimap`/`NetInfo`/`LinkPanel`/`TopoScene`/`Tween`/`TopologySync`/`Api`/`showBanner`/`apiPath`/`assertEditable`/`DirtyGuard`/`currentDraftID`/`setCurrentDraftID`/`isReadOnly`/`loginRedirectURL`/`ipv4CidrOverlap`/`containsFold`/`matchPrefixQuery`/`matchSubnetMembers`/`parseIPv4`/`parsePrefix`/`parseQueryPrefix`/`formatIPv4`/`prefixContains`/`prefixOverlap`/`makeColumnsResizable`/`initializeColumns`/`appData`/`buildNav`/`renderDraftBanner`/`ReadOnlyError` are spelled identically in every producing task's "Produces" line and every consuming task's "Consumes" line and `import` statement — cross-checked against the actual export names read from each source file during planning (Tasks 1-14), not invented.
