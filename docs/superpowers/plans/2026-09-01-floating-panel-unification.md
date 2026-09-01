# Unify canvas floating panels Implementation Plan

> ✅ **Plan complete.** All 4 tasks, the final whole-branch review, one fix wave,
> and its scoped re-review are done — clean. Commits: `438d546` (Task 1),
> `225a328` (Task 2), `c93d4f7` (Task 3), `0ac021f` (Task 4), `431d79b`
> (final-review fix wave). Full history and rulings:
> `.superpowers/sdd/2026-09-01-floating-panel-unification/progress.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five independent implementations of "floating panel over the canvas" (topology's `#net-edit`, `#device-edit`, `#link-panel`; diagnose's `#diag-panel`, `#spread-panel`) with one shared engine (`floating_panel.js`) that owns open/close/drag/clamp/world-anchoring/persistence, while each page keeps owning its own panel content.

**Architecture:** A new framework-agnostic module, `internal/httpapi/web/floating_panel.js`, exports `createFloatingPanel(opts)` — a factory that wires a header/close-button/body DOM triplet already present in the page's HTML. Callers (`topology.js`, `diagnose.js`, `link_panel.js`) each construct one instance per panel, passing element ids, a `getCamera()` accessor and a `viewportEl()` accessor; the factory returns `{open, close, position, reflow, isOpen}`. `devices.js`/`networks.js` no longer position anything themselves — `topology.js` injects the panel instance onto their Alpine component (`instance._panel = panel`, the same pattern already used for `instance._savePort`) and their `openDeviceEdit`/`openNetworkEdit`/`closeEditor` methods delegate to it.

**Tech Stack:** Vanilla JS (no Alpine, no build step), Node's built-in `node:test`/`node:assert/strict` runner (`node --test <file>.test.js`, no jsdom — DOM is hand-stubbed per test file).

**Spec:** `docs/superpowers/specs/2026-09-01-floating-panel-unification-design.md`

## Global Constraints

- No manual browser testing — automated tests only (project CLAUDE.md rule). Every task ends with `node --test` on the files it touches.
- Out of scope: the native `<dialog>` table-page modals (devices/networks/links/rules/sets/subnets/unions/users pages' `openEdit`/`closeModal`/`$refs.dialog`) — untouched by this plan.
- All five panels use ONE clamp formula: `Math.max(margin, viewport - size - margin)` on both edges (margin on every side) — this is diagnose.js's existing, already-tested formula. Topology's `net-edit`/`device-edit` currently use a different, asymmetric formula (no margin reserved on the far edge); this plan intentionally changes them to match diagnose's formula, and updates their two affected test assertions accordingly (flagged explicitly in Task 2).
- Every panel that used to close on a gesture (Escape / left-click on empty canvas) keeps doing so via factory options; `diag-panel`/`spread-panel` never had that behavior and don't gain it.
- `link-panel` currently closes on mouse-wheel (zoom) and stops doing so after this plan — it repositions instead, same as the other four panels.

---

## Task 1: `floating_panel.js` — the shared engine ✅ complete (commit 438d546, review clean)

**Files:**
- Create: `internal/httpapi/web/floating_panel.js`
- Test: `internal/httpapi/web/floating_panel.test.js`

**Interfaces:**
- Consumes: `Camera.screenToWorld(camera, x, y)` and `Camera.worldToScreen(camera, x, y)` from `internal/httpapi/web/camera.js` (both already exist and return `{x, y}`; verified against `camera.test.js`).
- Produces: `createFloatingPanel(opts) -> {open(at?), close(), position(), reflow(), isOpen()}`, consumed by Tasks 2-4.
  - `opts`: `{panelId, headerId, closeId, viewportEl, getCamera, posKey=null, openKey=null, defaultOpen=false, margin=8, fallbackW=320, fallbackH=240, onOpenChange=null, onClose=null, closeOnEscape=false, closeOnCanvasClick=null}`.
  - `viewportEl`/`closeOnCanvasClick` are zero-arg functions returning a DOM element (called each time, not memoized, matching the existing `canvas()`/`wrapEl()` helper idiom already used in `topology.js`/`diagnose.js`).
  - `getCamera` is a zero-arg function returning `{x, y, z}`.
  - `open(at)`: `at` is an optional screen-space `{x, y}` point. If given, re-anchors the panel there (converted to world coords internally); if omitted, the panel opens wherever its last-known anchor is (persisted or default-centered).

- [x] **Step 1: Write `floating_panel.test.js`**

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Minimal DOM stub: a flat id->element registry, no real tree. Matches the
// style already used by camera.test.js/devices_page.test.js — production
// code here only ever does document.getElementById/addEventListener.
function makeEl() {
  return {
    hidden: true,
    style: {},
    offsetWidth: 0,
    offsetHeight: 0,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
  };
}

function fire(el, type, ev = {}) {
  (el.listeners[type] || []).slice().forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, ...ev }));
}

async function loadFactory() {
  const els = {};
  const store = {};
  // doc — тот же приём, что и makeEl(), но с getElementById: floating_panel.js
  // вешает document-level слушатели (mousemove/mouseup/keydown) через тот же
  // addEventListener/listeners, так что fire(doc, ...) работает одинаково и
  // для элементов, и для document.
  const doc = {
    listeners: {},
    getElementById: (id) => (els[id] ||= makeEl()),
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
  };
  global.document = doc;
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  };
  const { createFloatingPanel } = await import(path.join(__dirname, "floating_panel.js") + `?t=${Date.now()}-${Math.random()}`);
  return { createFloatingPanel, els, doc, store };
}

const identityCam = { x: 0, y: 0, z: 1 };
const viewport = () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) });

test("open(at) anchors the panel at the given screen point under an identity camera", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    fallbackW: 100, fallbackH: 80,
  });
  panel.open({ x: 150, y: 200 });
  assert.equal(els.p.hidden, false, "panel shown");
  assert.equal(els.p.style.left, "150px");
  assert.equal(els.p.style.top, "200px");
});

test("open(at) clamps into the viewport with margin on every side", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    fallbackW: 520, fallbackH: 380, margin: 8,
  });
  panel.open({ x: 5000, y: -50 });
  // maxLeft = max(8, 1200-520-8) = 672; maxTop = max(8, 0) = 8 (y clamped up first)
  assert.equal(els.p.style.left, "672px", "clamped short of the right edge, margin kept on both sides");
  assert.equal(els.p.style.top, "8px", "clamped to the top margin");
});

test("close hides the panel and invokes onClose", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  let closed = false;
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    onClose: () => { closed = true; },
  });
  panel.open({ x: 10, y: 10 });
  panel.close();
  assert.equal(els.p.hidden, true);
  assert.ok(closed);
  assert.equal(panel.isOpen(), false);
});

test("clicking the close button closes the panel", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
  });
  panel.open({ x: 10, y: 10 });
  fire(els["p-close"], "click", {});
  assert.equal(els.p.hidden, true);
});

test("dragging the header moves the panel live, clamped, and mousedown on the close button does not start a drag", async () => {
  const { createFloatingPanel, els, doc } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    fallbackW: 520, fallbackH: 380, margin: 8,
  });
  panel.open({ x: 100, y: 50 });
  fire(els["p-close"], "mousedown", { button: 0, clientX: 100, clientY: 50 });
  fire(doc, "mousemove", { clientX: 900, clientY: 900 });
  assert.equal(els.p.style.left, "100px", "close-button press did not start a drag");

  fire(els["p-header"], "mousedown", { button: 0, clientX: 100, clientY: 50 });
  fire(doc, "mousemove", { clientX: 140, clientY: 80 });
  assert.equal(els.p.style.left, "140px", "follows the cursor horizontally");
  assert.equal(els.p.style.top, "80px", "follows the cursor vertically");
  fire(doc, "mousemove", { clientX: 5000, clientY: 5000 });
  assert.equal(els.p.style.left, "672px", "drag clamps short of the right edge, margin kept");
  assert.equal(els.p.style.top, "412px", "drag clamps short of the bottom edge, margin kept");
  fire(doc, "mouseup", {});
  fire(doc, "mousemove", { clientX: 1, clientY: 1 });
  assert.equal(els.p.style.left, "672px", "stops following the cursor after mouseup");
});

test("position() re-projects the anchor when the camera changes, without re-clamping", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  let cam = { x: 0, y: 0, z: 1 };
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => cam,
    fallbackW: 100, fallbackH: 80,
  });
  panel.open({ x: 300, y: 200 }); // anchor = world (300, 200) under identity camera
  cam = { x: 50, y: -20, z: 2 };
  panel.position();
  // worldToScreen(cam, 300, 200) = (300*2+50, 200*2-20) = (650, 380)
  assert.equal(els.p.style.left, "650px");
  assert.equal(els.p.style.top, "380px");
});

test("reflow re-clamps at the current anchor without needing a new point", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    fallbackW: 100, fallbackH: 80, margin: 8,
  });
  panel.open({ x: 700, y: 700 }); // within bounds at the original fallback size, so anchor lands exactly here
  els.p.offsetWidth = 900; // content grew after open (e.g. a toggled section)
  els.p.offsetHeight = 780;
  panel.reflow();
  assert.equal(els.p.style.left, "292px", "re-clamped to the now-larger size: max(8, 1200-900-8)");
  assert.equal(els.p.style.top, "12px", "re-clamped to the now-larger size: max(8, 800-780-8)");
});

test("open() with no argument keeps the previous anchor (toolbar-toggle style)", async () => {
  const { createFloatingPanel, els } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    fallbackW: 100, fallbackH: 80,
  });
  panel.open({ x: 300, y: 200 });
  panel.close();
  panel.open();
  assert.equal(els.p.style.left, "300px", "reopened at the same place, no point given");
  assert.equal(els.p.style.top, "200px");
});

test("openKey persists open state across instances and defaultOpen only applies on first use", async () => {
  const { createFloatingPanel, els, store } = await loadFactory();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    openKey: "test-open-key", defaultOpen: true,
  });
  assert.equal(els.p.hidden, false, "defaultOpen honored when nothing stored yet");
  panel.close();
  assert.equal(store["test-open-key"], "0");
});

test("posKey persists the anchor across instances", async () => {
  const { createFloatingPanel, els, store } = await loadFactory();
  const panel1 = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    posKey: "test-pos-key", fallbackW: 100, fallbackH: 80,
  });
  panel1.open({ x: 300, y: 200 });
  assert.deepEqual(JSON.parse(store["test-pos-key"]), { x: 300, y: 200 });

  els.p2 = makeEl();
  els["p2-header"] = makeEl();
  els["p2-close"] = makeEl();
  const panel2 = createFloatingPanel({
    panelId: "p2", headerId: "p2-header", closeId: "p2-close",
    viewportEl: viewport, getCamera: () => identityCam,
    posKey: "test-pos-key", fallbackW: 100, fallbackH: 80,
  });
  panel2.open();
  assert.equal(els.p2.style.left, "300px", "new instance picks up the persisted anchor");
});

test("closeOnEscape and closeOnCanvasClick close the panel; closeOnCanvasClick ignores the right button", async () => {
  const { createFloatingPanel, els, doc } = await loadFactory();
  const canvasEl = makeEl();
  const panel = createFloatingPanel({
    panelId: "p", headerId: "p-header", closeId: "p-close",
    viewportEl: viewport, getCamera: () => identityCam,
    closeOnEscape: true, closeOnCanvasClick: () => canvasEl,
  });
  panel.open({ x: 10, y: 10 });
  fire(canvasEl, "mousedown", { button: 2 });
  assert.equal(els.p.hidden, false, "right-button press does not close");
  fire(canvasEl, "mousedown", { button: 0 });
  assert.equal(els.p.hidden, true, "left-button press closes");

  panel.open({ x: 10, y: 10 });
  fire(doc, "keydown", { key: "Escape" });
  assert.equal(els.p.hidden, true, "Escape closes");
});
```

- [x] **Step 2: Run the test to verify it fails (module doesn't exist yet)**

Run: `cd internal/httpapi/web && node --test floating_panel.test.js`
Expected: FAIL — `Cannot find module '.../floating_panel.js'`.

- [x] **Step 3: Implement `floating_panel.js`**

```js
"use strict";

import { Camera } from "./camera.js";

// createFloatingPanel — общий "хром" панелей, плавающих над канвасом
// (топология: net-edit/device-edit/link-panel; диагностика: diag-panel/
// spread-panel): открытие/закрытие, перетаскивание за заголовок, клэмп в
// границах контейнера (margin с обеих сторон) и мировая привязка (position()
// проецирует anchor текущей камерой — без клэмпа, панель едет вместе с
// картой, в т.ч. за пределы видимой области при панорамировании/зуме).
// Персист позиции/открытости в localStorage — опционален (posKey/openKey).
// Наполнение (форма, бизнес-логика) остаётся у вызывающей стороны — фабрика
// не трогает содержимое panel-body.
function createFloatingPanel({
  panelId,
  headerId,
  closeId,
  viewportEl,
  getCamera,
  posKey = null,
  openKey = null,
  defaultOpen = false,
  margin = 8,
  fallbackW = 320,
  fallbackH = 240,
  onOpenChange = null,
  onClose = null,
  closeOnEscape = false,
  closeOnCanvasClick = null,
}) {
  const panelEl = () => document.getElementById(panelId);
  let anchor = null; // мировая точка {x, y}, к которой привязана панель
  let drag = null; // {x, y, boxX, boxY} — экранные координаты старта драга

  function setOpen(open, persist = true) {
    panelEl().hidden = !open;
    if (persist && openKey) localStorage.setItem(openKey, open ? "1" : "0");
    if (onOpenChange) onOpenChange(open);
  }

  function position() {
    if (!anchor) return;
    const p = Camera.worldToScreen(getCamera(), anchor.x, anchor.y);
    panelEl().style.left = `${p.x}px`;
    panelEl().style.top = `${p.y}px`;
  }

  // clampAndPin подтягивает панель внутрь видимой области viewportEl() (с
  // margin по всем сторонам) и переопределяет anchor по уже кламп-нутой
  // позиции — иначе следующий position() (после пана/зума) вернул бы панель
  // туда, где она была бы без клэмпа, дав видимый скачок.
  function clampAndPin() {
    const wrap = viewportEl().getBoundingClientRect();
    const b = panelEl();
    const w = b.offsetWidth || fallbackW;
    const h = b.offsetHeight || fallbackH;
    const maxLeft = Math.max(margin, wrap.width - w - margin);
    const maxTop = Math.max(margin, wrap.height - h - margin);
    const left = Math.min(Math.max(parseFloat(b.style.left) || 0, margin), maxLeft);
    const top = Math.min(Math.max(parseFloat(b.style.top) || 0, margin), maxTop);
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
    anchor = Camera.screenToWorld(getCamera(), left, top);
    if (posKey) localStorage.setItem(posKey, JSON.stringify(anchor));
  }

  // open показывает панель. at (экранная точка, например курсор правого
  // клика) переносит anchor в эту точку; без at панель открывается на
  // прежнем месте (тулбар-тумблер вроде diag-panel/spread-panel).
  function open(at) {
    if (at) anchor = Camera.screenToWorld(getCamera(), at.x, at.y);
    setOpen(true);
    position();
    clampAndPin();
  }

  function endDrag() {
    drag = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  function close() {
    if (drag) endDrag();
    setOpen(false);
    if (onClose) onClose();
  }

  // reflow переклэмпивает панель на месте — вызывается вызывающей стороной,
  // когда содержимое меняет размер панели (например link-panel переключился
  // в фильтрованный режим и стал выше), чтобы панель не вылезла за канвас.
  function reflow() {
    if (panelEl().hidden) return;
    position();
    clampAndPin();
  }

  function onDragMove(e) {
    if (!drag) return;
    const wrap = viewportEl().getBoundingClientRect();
    const b = panelEl();
    const w = b.offsetWidth || fallbackW;
    const h = b.offsetHeight || fallbackH;
    const x = drag.boxX + (e.clientX - drag.x);
    const y = drag.boxY + (e.clientY - drag.y);
    const maxLeft = Math.max(margin, wrap.width - w - margin);
    const maxTop = Math.max(margin, wrap.height - h - margin);
    b.style.left = `${Math.min(Math.max(x, margin), maxLeft)}px`;
    b.style.top = `${Math.min(Math.max(y, margin), maxTop)}px`;
  }

  function onDragEnd() {
    clampAndPin(); // пересчитывает anchor от места, где драг оставил панель
    endDrag();
  }

  function isOpen() {
    return !panelEl().hidden;
  }

  const header = document.getElementById(headerId);
  const closeBtn = document.getElementById(closeId);
  closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", close);
  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const b = panelEl();
    drag = { x: e.clientX, y: e.clientY, boxX: parseFloat(b.style.left) || 0, boxY: parseFloat(b.style.top) || 0 };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  });
  if (closeOnEscape) {
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }
  if (closeOnCanvasClick) {
    closeOnCanvasClick().addEventListener("mousedown", (e) => { if (e.button === 0) close(); });
  }

  const storedOpen = openKey ? localStorage.getItem(openKey) : null;
  const openAtStart = storedOpen === null ? defaultOpen : storedOpen === "1";
  try {
    const saved = posKey ? JSON.parse(localStorage.getItem(posKey)) : null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) anchor = saved;
  } catch {}
  if (!anchor) {
    const wrap = viewportEl().getBoundingClientRect();
    anchor = Camera.screenToWorld(getCamera(), wrap.width / 2 - fallbackW / 2, wrap.height / 2 - fallbackH / 2);
  }
  setOpen(openAtStart, false);
  position();
  if (openAtStart) clampAndPin();

  return { open, close, position, reflow, isOpen };
}

export { createFloatingPanel };
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd internal/httpapi/web && node --test floating_panel.test.js`
Expected: PASS (all tests green).

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/web/floating_panel.js internal/httpapi/web/floating_panel.test.js
git commit -m "feat(web): add shared floating_panel.js engine for canvas panels"
```

---

## Task 2: Entity-edit windows (`#device-edit`, `#net-edit`) → `floating_panel.js` ✅ complete (commit 225a328, review clean)

Covers `devices.js`, `networks.js`, their two test files, and the `topology.js`/`style.css`/`topology.html` pieces both windows share (they're structurally identical today — same CSS classes, same `setupFloatingEditClose`/`setupFloatingEditDrag` helpers — so splitting them into separate tasks would leave an inconsistent intermediate state).

**Files:**
- Modify: `internal/httpapi/web/devices.js`
- Modify: `internal/httpapi/web/networks.js`
- Modify: `internal/httpapi/web/topology.js`
- Modify: `internal/httpapi/web/topology.html`
- Modify: `internal/httpapi/web/style.css`
- Modify: `internal/httpapi/web/devices_page.test.js`
- Modify: `internal/httpapi/web/networks_page.test.js`
- Modify: `internal/httpapi/web/topology_render.test.js`

**Interfaces:**
- Consumes: `createFloatingPanel` from Task 1.
- Produces: `topology.js` module-scope `netEditPanel`/`deviceEditPanel` (both `{open, close, position, reflow, isOpen}`), injected onto the `networksPage`/`devicesPage` Alpine instances as `instance._panel` — consumed by Task 3 only insofar as `applyCamera()` (below) is extended there with one more line.

- [x] **Step 1: Update `devices_page.test.js`**

Remove `deviceEdit` from the default `$refs` (bootPage, around line 91-94):

```js
  page.$refs = {
    dialog: { close: () => calls.push({ path: "dialog.close" }) },
  };
```

Replace the two floating-window tests (the `openDeviceEdit fills the draft...` and `openDeviceEdit clamps...` tests) with:

```js
// --- плавающее окно на холсте топологии (ПКМ по устройству → «Редактировать») ---
// Позиционирование/клэмп/drag/мировая привязка теперь общий floating_panel.js
// (см. floating_panel.test.js) — здесь проверяется только то, что
// devicesPage заполняет draft и делегирует открытие/закрытие своему _panel
// (инстанс, который topology.js создаёт и кладёт на this._panel — см.
// Topology.openDeviceEditWindow).

test("openDeviceEdit fills the draft and opens the canvas window via _panel", async () => {
  const { page } = await bootLoadedPage();
  const opens = [];
  page._panel = { open: (at) => opens.push(at), close: () => {} };

  page.openDeviceEdit("sw1", { x: 150, y: 200 });

  assert.deepEqual(page.draft, { index: 1, name: "sw1", description: "", union: "" });
  assert.deepEqual(opens, [{ x: 150, y: 200 }], "canvas window opened at the click point");
});
```

Replace `saveDraft delegates to the injected save port and closes the canvas window`:

```js
test("saveDraft delegates to the injected save port and closes the canvas window", async () => {
  const { page, calls, getFixture } = await bootLoadedPage();
  const portOps = [];
  let closed = false;
  page.$refs = {};
  page._panel = { open() {}, close: () => { closed = true; } };
  page._savePort = async (ops) => {
    portOps.push(ops);
    return { topology: { ...getFixture(), devices: [{ name: "core-1", kind: "router", description: "новый узел" }, { name: "sw1", kind: "switch" }] } };
  };
  page.draft = { index: 0, name: "core-1", description: "новый узел", union: "hq" };

  await page.saveDraft();

  assert.deepEqual(portOps, [[
    { kind: "update-device", deviceName: "r1", device: { name: "core-1", kind: "router", description: "новый узел" } },
  ]]);
  assert.equal(
    calls.filter((c) => c.path === "/api/drafts/d1/topology/operations/batch" && c.method === "POST").length,
    0,
    "no direct POST when a port is injected",
  );
  assert.equal(page.devices[0].name, "core-1");
  assert.ok(closed, "canvas window closed after save");
});
```

Replace `saveDraft keeps the canvas window open when the port fails`:

```js
test("saveDraft keeps the canvas window open when the port fails", async () => {
  const { page, banners } = await bootLoadedPage();
  let closed = false;
  page.$refs = {};
  page._panel = { open() {}, close: () => { closed = true; } };
  page._savePort = async () => { throw new Error("boom"); };
  page.openDeviceEdit("r1", { x: 100, y: 100 });

  await page.saveDraft();

  assert.match(banners.at(-1)?.message, /Ошибка сохранения/);
  assert.ok(!closed, "window stays open with the draft intact");
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd internal/httpapi/web && node --test devices_page.test.js`
Expected: the three rewritten tests FAIL (`this._panel` is undefined inside `devices.js`'s current `openDeviceEdit`/`closeEditor`).

- [x] **Step 3: Update `devices.js`**

Remove the size constants (the `DEVICE_EDIT_W`/`_H`/`_MARGIN` block):

```js
const DEVICES_COL_WIDTHS_KEY = "firenet-devices-col-widths-v1";
const DEVICES_COL_WIDTHS_VERSION = 1;
```

(delete the `// Размер плавающего окна...` comment and the three `const DEVICE_EDIT_*` lines that followed it).

Replace `openDeviceEdit`/`showDeviceEdit`/`closeDeviceEdit`/`closeEditor`:

```js
    // openDeviceEdit открывает плавающее окно редактирования устройства на
    // холсте топологии (ПКМ по устройству → «Редактировать»). Поведение
    // дублирует openEdit страницы «Устройства» — тот же draft; отличие —
    // открытие/позиционирование окна на холсте делегировано this._panel
    // (floating_panel.js-инстанс, который topology.js создаёт и кладёт на
    // инстанс перед вызовом — см. Topology.openDeviceEditWindow). Тип
    // устройства (router/switch) не редактируется — как и в openEdit.
    openDeviceEdit(name, at) {
      const i = this.devices.findIndex((d) => d.name === name);
      if (i < 0) return;
      const d = this.devices[i];
      this.draft = { index: i, name: d.name, description: d.description, union: d.union };
      this._panel.open(at);
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    // closeEditor закрывает открытый редактор: модальный диалог страницы
    // «Устройства» или плавающее окно на холсте топологии — что из них
    // примонтировано.
    closeEditor() {
      if (this.$refs.dialog) this.closeModal();
      else this._panel.close();
    },
```

(this replaces the original `openDeviceEdit`, `closeModal`, `showDeviceEdit`, `closeDeviceEdit`, `closeEditor` methods — `closeModal` is unchanged, just kept in place; `showDeviceEdit`/`closeDeviceEdit` are deleted entirely).

- [x] **Step 4: Run to verify `devices_page.test.js` passes**

Run: `cd internal/httpapi/web && node --test devices_page.test.js`
Expected: PASS.

- [x] **Step 5: Update `networks_page.test.js`** (mirrors steps 1, applied to networks)

Remove `netEdit` from the default `$refs` (bootPage, around line 68-71):

```js
  page.$refs = {
    dialog: { close: () => calls.push({ path: "dialog.close" }) },
  };
```

Replace the two floating-window tests:

```js
// --- плавающее окно на холсте топологии (ПКМ по сети → «Редактировать») ---
// Позиционирование/клэмп/drag/мировая привязка теперь общий floating_panel.js
// (см. floating_panel.test.js) — здесь проверяется только то, что
// networksPage заполняет draft и делегирует открытие/закрытие своему _panel.

test("openNetworkEdit fills the draft and opens the canvas window via _panel", async () => {
  const { page } = await bootLoadedPage();
  const opens = [];
  page._panel = { open: (at) => opens.push(at), close: () => {} };

  page.openNetworkEdit("dmz", { x: 150, y: 200 });

  assert.deepEqual(page.draft, { index: 1, name: "dmz", subnets: ["b"], description: "" });
  assert.deepEqual(opens, [{ x: 150, y: 200 }], "canvas window opened at the click point");
});
```

Replace `saveDraft delegates to the injected save port and closes the canvas window`:

```js
test("saveDraft delegates to the injected save port and closes the canvas window", async () => {
  const { page, calls, topoFixture } = await bootLoadedPage();
  const portOps = [];
  let closed = false;
  page.$refs = {};
  page._panel = { open() {}, close: () => { closed = true; } };
  page._savePort = async (op) => {
    portOps.push(op);
    return { topology: { ...topoFixture, networks: [{ name: "office", subnets: ["a", "c"], description: "новое" }] } };
  };
  page.draft = { index: 0, name: "office", subnets: ["a", "c"], description: "офисная" };

  await page.saveDraft();

  assert.deepEqual(portOps, [{
    kind: "update-network",
    networkName: "office",
    network: { name: "office", subnets: ["a", "c"], description: "офисная" },
  }]);
  assert.equal(
    calls.filter((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST").length,
    0,
    "no direct POST when a port is injected",
  );
  assert.deepEqual(page.networks, [{ name: "office", subnets: ["a", "c"], description: "новое" }]);
  assert.ok(closed, "canvas window closed after save");
});
```

Replace `saveDraft keeps the canvas window open when the port fails`:

```js
test("saveDraft keeps the canvas window open when the port fails", async () => {
  const { page, banners } = await bootLoadedPage();
  let closed = false;
  page.$refs = {};
  page._panel = { open() {}, close: () => { closed = true; } };
  page._savePort = async () => { throw new Error("boom"); };
  page.openNetworkEdit("office", { x: 100, y: 100 });
  page.draft.subnets = ["a"];

  await page.saveDraft();

  assert.match(banners.at(-1)?.message, /Ошибка сохранения/);
  assert.ok(!closed, "window stays open with the draft intact");
});
```

- [x] **Step 6: Run to verify failure, then update `networks.js`**

Run: `cd internal/httpapi/web && node --test networks_page.test.js` — expect the three rewritten tests to FAIL.

Remove the size constants:

```js
const NETWORKS_COL_WIDTHS_KEY = "firenet-networks-col-widths-v1";
const NETWORKS_COL_WIDTHS_VERSION = 1;
```

(delete the `// Размер плавающего окна...` comment and the three `const NET_EDIT_*` lines).

Replace `openNetworkEdit`/`showNetworkEdit`/`closeNetworkEdit`/`closeEditor`:

```js
    // openNetworkEdit открывает плавающее окно редактирования сети на холсте
    // топологии (ПКМ по сети → «Редактировать»). Поведение дублирует openEdit
    // страницы «Сети»: тот же draft, те же подсети и saveDraft. Отличие —
    // открытие/позиционирование окна делегировано this._panel (см.
    // devicesPage.openDeviceEdit — тот же приём). На холсте topology.js
    // обновляет this.networks/this.subnets из текущего State перед вызовом,
    // так что черновик всегда строится по свежим данным.
    openNetworkEdit(name, at) {
      const i = this.networks.findIndex((n) => n.name === name);
      if (i < 0) return;
      this.draft = { index: i, name: this.networks[i].name, subnets: [...this.networks[i].subnets], description: this.networks[i].description };
      this.resetMemberSearch();
      this._panel.open(at);
    },

    closeModal() {
      this.$refs.dialog.close();
    },
```

(deletes `showNetworkEdit`/`closeNetworkEdit` entirely; `closeModal` unchanged, kept in place).

Replace `closeEditor`:

```js
    // closeEditor закрывает открытый редактор: модальный диалог страницы
    // «Сети» или плавающее окно на холсте топологии — что из них примонтировано.
    closeEditor() {
      if (this.$refs.dialog) this.closeModal();
      else this._panel.close();
    },
```

- [x] **Step 7: Run to verify `networks_page.test.js` passes**

Run: `cd internal/httpapi/web && node --test networks_page.test.js`
Expected: PASS.

- [x] **Step 8: Update `topology.html`**

In both the `#device-edit` and `#net-edit` blocks, rename classes (content unchanged otherwise):

```html
      <div id="device-edit" class="floating-panel net-edit" x-data="devicesPage" x-ref="deviceEdit" hidden>
        <header id="device-edit-header" class="floating-panel-header">
          <h3 class="floating-panel-title">Изменить устройство</h3>
          <button type="button" id="device-edit-close" class="floating-panel-close" title="Закрыть" aria-label="Закрыть">×</button>
        </header>
        <div class="floating-panel-body">
```

```html
      <div id="net-edit" class="floating-panel net-edit" x-data="networksPage" x-ref="netEdit" hidden>
        <header id="net-edit-header" class="floating-panel-header">
          <h3 class="floating-panel-title">Изменить сеть</h3>
          <button type="button" id="net-edit-close" class="floating-panel-close" title="Закрыть" aria-label="Закрыть">×</button>
        </header>
        <div class="floating-panel-body">
```

(the closing `</div>` for each `net-edit-body` div stays; only the opening tag's class changes).

- [x] **Step 9: Update `style.css`**

Replace the whole `/* floating object editor ... */` block through `.net-edit-body .modal-actions { ... }` (currently lines ~399-439) with:

```css
/* floating panel chrome shared by canvas edit windows (#net-edit,
   #device-edit, #link-panel) and diagnose tool panels (#diag-panel,
   #spread-panel) — opened near a canvas point, draggable by header,
   world-anchored via floating_panel.js. */
.floating-panel {
  position: absolute;
  z-index: 10;
  width: 380px;
  max-width: calc(100% - 2 * var(--space-3));
  max-height: calc(100% - 2 * var(--space-3));
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
}
.floating-panel[hidden] { display: none; }
.floating-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
}
.floating-panel-title { margin: 0; font-size: 1rem; }
.floating-panel-close { border: none; background: none; color: var(--fg); font-size: 1.2rem; line-height: 1; cursor: pointer; padding: 0 var(--space-1); }
.floating-panel-close:hover { color: var(--accent); }
.floating-panel-body { padding: var(--space-3); }
.floating-panel-body form { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.floating-panel-body label,
.floating-panel-body .modal-field { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-3); font-size: 0.9rem; }
.floating-panel-body .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: auto; }

/* .net-edit — модификатор поверх .floating-panel для #net-edit/#device-edit:
   шире (--net-edit-w) и с overflow: visible — .member-suggestions
   (position: absolute) у net-edit всплывает над окном, но по DOM-дереву
   остаётся его потомком; overflow: auto считал бы её высоту в scroll-области,
   пряча список за скроллбаром самого окна вместо того, чтобы дать ему
   открыться поверх содержимого. */
.net-edit {
  z-index: 20;
  width: min(var(--net-edit-w), calc(100% - 2 * var(--space-3)));
  overflow: visible;
}
```

Leave the `/* floating link filter editor ... */` (`.link-panel*`) and `/* — диагностика пути ... */` (`.diag-panel*`) blocks untouched — they still stand alone until Tasks 3 and 4.

- [x] **Step 10: Update `topology_render.test.js`** — teach the two Alpine-instance test doubles to actually call `_panel.open`, and add one camera-follow test per window

Update `installNetEditAlpine`:

```js
function installNetEditAlpine(page) {
  const calls = [];
  const instance = {
    networks: [],
    subnets: [],
    openNetworkEdit(name, at) { calls.push(["openNetworkEdit", name, at]); this._panel.open(at); },
  };
  globalThis.Alpine = { $data: (el) => (el === page.ids["net-edit"] ? instance : null) };
  return { instance, calls, done: () => { delete globalThis.Alpine; } };
}
```

Update `installDeviceEditAlpine`:

```js
function installDeviceEditAlpine(page) {
  const calls = [];
  const instance = {
    devices: [],
    unions: [],
    openDeviceEdit(name, at) { calls.push(["openDeviceEdit", name, at]); this._panel.open(at); },
  };
  globalThis.Alpine = { $data: (el) => (el === page.ids["device-edit"] ? instance : null) };
  return { instance, calls, done: () => { delete globalThis.Alpine; } };
}
```

Update the two drag-clamp tests' expected values — the shared engine clamps with margin on **every** edge (Global Constraints), whereas the old per-page code only reserved margin on the near edge:

In `"net-edit window can be dragged by its header, clamped to the canvas bounds"`, change:

```js
  fire(page.doc, "mousemove", { clientX: 5000, clientY: 5000 });
  assert.equal(box.style.left, "672px", "left clamped so the window stays on the canvas, margin kept on the far edge too");
  assert.equal(box.style.top, "232px", "top clamped so the window stays on the canvas, margin kept on the far edge too");
  fire(page.doc, "mouseup", {});
  fire(page.doc, "mousemove", { clientX: 999, clientY: 999 });
  assert.equal(box.style.left, "672px", "drag stops listening for mousemove after mouseup");
```

In `"device-edit window can be dragged by its header, clamped to the canvas bounds"`, change:

```js
  fire(page.doc, "mousemove", { clientX: 5000, clientY: 5000 });
  assert.equal(box.style.left, "672px", "left clamped so the window stays on the canvas, margin kept on the far edge too");
  assert.equal(box.style.top, "412px", "top clamped so the window stays on the canvas, margin kept on the far edge too");
```

Add, right after `"net-edit save port applies update-network through the canvas sync queue"` (before the `// --- device-edit` comment):

```js
test("zooming the camera repositions the open net-edit window", async () => {
  const page = await bootTopology(responses);
  await tick();
  const alpine = installNetEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y });
    fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
    const box = page.doc.getElementById("net-edit");
    const anchor = { x: parseFloat(box.style.left), y: parseFloat(box.style.top) };
    fire(page.canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
    page.pump();
    const cam = JSON.parse(page.get("JSON.stringify(State.camera)"));
    assert.equal(box.style.left, `${anchor.x * cam.z + cam.x}px`, "window follows its network after zoom");
    assert.equal(box.style.top, `${anchor.y * cam.z + cam.y}px`, "window follows its network after zoom");
  } finally {
    alpine.done();
  }
});
```

Add, right after `"device-edit save port applies update-device through the canvas sync queue"`:

```js
test("zooming the camera repositions the open device-edit window", async () => {
  const page = await bootTopology(responses);
  await tick();
  const alpine = installDeviceEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
    fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
    const box = page.doc.getElementById("device-edit");
    const anchor = { x: parseFloat(box.style.left), y: parseFloat(box.style.top) };
    fire(page.canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
    page.pump();
    const cam = JSON.parse(page.get("JSON.stringify(State.camera)"));
    assert.equal(box.style.left, `${anchor.x * cam.z + cam.x}px`, "window follows its device after zoom");
    assert.equal(box.style.top, `${anchor.y * cam.z + cam.y}px`, "window follows its device after zoom");
  } finally {
    alpine.done();
  }
});
```

- [x] **Step 11: Update `topology.js`**

Add the import, right after the existing `LinkPanel` import:

```js
import { LinkPanel } from "./link_panel.js";
import { createFloatingPanel } from "./floating_panel.js";
```

Add two module-scope panel variables next to the other panel-scoped `let`s:

```js
  let popoverWorld = null; // world point the open popover is anchored to
  let ctxPending = null; // {items, at}: node menu awaiting a clean right-release
  let camControls = null; // CameraControls handle (isRightDown)
  let minimap = null; // Minimap над #topo-minimap
  let netEditPanel = null; // floating_panel.js-инстанс окна #net-edit
  let deviceEditPanel = null; // floating_panel.js-инстанс окна #device-edit
```

Extend `applyCamera()`:

```js
  function applyCamera() {
    view.invalidate();
    movePopover();
    minimap.update();
    netEditPanel?.position();
    deviceEditPanel?.position();
  }
```

In `openNetworkEditWindow`, inject the panel before calling into the Alpine instance:

```js
    instance._savePort = async (op) => {
      enqueueOp(op);
      await sync.idle();
      if (syncStatus === "error") throw new Error("не удалось применить операцию к черновику");
      return { topology: State.topology };
    };
    instance._panel = netEditPanel;
    instance.openNetworkEdit(name, at);
```

In `openDeviceEditWindow`, inject the panel the same way:

```js
    instance._savePort = async (ops) => {
      enqueueOpBatch(ops);
      await sync.idle();
      if (syncStatus === "error") throw new Error("не удалось применить операцию к черновику");
      return { topology: State.topology };
    };
    instance._panel = deviceEditPanel;
    instance.openDeviceEdit(name, at);
```

Delete the `setupFloatingEditClose` and `setupFloatingEditDrag` function definitions entirely (the comment blocks and both functions, currently sitting between `deleteSelection`-adjacent code and `boot()`).

In `boot()`, replace:

```js
    NetInfo.attach(canvas());
    LinkPanel.attach(canvas());
    setupFloatingEditClose("net-edit");
    setupFloatingEditClose("device-edit");
    setupFloatingEditDrag("net-edit", "net-edit-header", "net-edit-close");
    setupFloatingEditDrag("device-edit", "device-edit-header", "device-edit-close");
    setTool("select");
    Topology.render();
```

with:

```js
    NetInfo.attach(canvas());
    LinkPanel.attach(canvas());
    netEditPanel = createFloatingPanel({
      panelId: "net-edit", headerId: "net-edit-header", closeId: "net-edit-close",
      viewportEl: canvas, getCamera: () => State.camera,
      posKey: "firenet-net-edit-pos-v1",
      fallbackW: 520, fallbackH: 560,
      closeOnEscape: true, closeOnCanvasClick: canvas,
    });
    deviceEditPanel = createFloatingPanel({
      panelId: "device-edit", headerId: "device-edit-header", closeId: "device-edit-close",
      viewportEl: canvas, getCamera: () => State.camera,
      posKey: "firenet-device-edit-pos-v1",
      fallbackW: 520, fallbackH: 380,
      closeOnEscape: true, closeOnCanvasClick: canvas,
    });
    setTool("select");
    Topology.render();
```

(`LinkPanel.attach(canvas())` is left exactly as it is today — Task 3 changes its signature and behavior.)

- [x] **Step 12: Run the full JS suite for this task's files**

Run: `cd internal/httpapi/web && node --test devices_page.test.js networks_page.test.js topology_render.test.js`
Expected: PASS (all tests, including the two rewritten drag-clamp assertions and the two new camera-follow tests).

- [x] **Step 13: Commit**

```bash
git add internal/httpapi/web/devices.js internal/httpapi/web/networks.js internal/httpapi/web/topology.js internal/httpapi/web/topology.html internal/httpapi/web/style.css internal/httpapi/web/devices_page.test.js internal/httpapi/web/networks_page.test.js internal/httpapi/web/topology_render.test.js
git commit -m "refactor(web): move net-edit/device-edit windows onto floating_panel.js"
```

---

## Task 3: `#link-panel` → `floating_panel.js` ✅ complete (commit c93d4f7, review clean)

Link-panel currently builds its header and close button dynamically in JS (`render()`), unlike the other four panels which have them static in HTML. This task gives it static header/close/body markup (title text and body content stay dynamic) so it can plug into the same factory contract.

**Files:**
- Modify: `internal/httpapi/web/link_panel.js`
- Modify: `internal/httpapi/web/topology.js`
- Modify: `internal/httpapi/web/topology.html`
- Modify: `internal/httpapi/web/style.css`
- Modify: `internal/httpapi/web/topology_render.test.js`
- Modify: `internal/httpapi/web/link_panel.test.js` *(planning gap — this file existed and tested the old `attach`/`show` signatures and manual-DOM chrome; missed when this list was written. Executed anyway: see ledger Task 3 ruling.)*

**Interfaces:**
- Consumes: `createFloatingPanel` (Task 1); `netEditPanel`/`deviceEditPanel`/`applyCamera()` (Task 2, extended here).
- Produces: `LinkPanel.position()` — a new export `applyCamera()` calls; `LinkPanel.attach(canvasEl, getCamera)` — signature change (previously `attach(canvasEl)`).

- [x] **Step 1: Update `topology.html`**

Replace the single-line `#link-panel` div:

```html
      <div id="link-panel" class="link-panel" hidden></div>
```

with static chrome, dynamic body:

```html
      <div id="link-panel" class="floating-panel link-panel" hidden>
        <header id="link-panel-header" class="floating-panel-header">
          <strong id="link-panel-title" class="floating-panel-title"></strong>
          <button type="button" id="link-panel-close" class="floating-panel-close" title="Закрыть" aria-label="Закрыть">×</button>
        </header>
        <div id="link-panel-body" class="floating-panel-body"></div>
      </div>
```

- [x] **Step 2: Update `style.css`**

Replace the `/* floating link filter editor ... */` block (currently `.link-panel { ... } .link-panel[hidden] { ... } .link-panel-grid { ... } ...`) — drop everything now covered by `.floating-panel`/`.floating-panel[hidden]`, keep only the link-specific layout rules:

```css
/* .link-panel — модификатор поверх .floating-panel для #link-panel:
   раскладка полей фильтра по сторонам связи. */
.link-panel-grid { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-2); }
.link-panel .member-add { margin: var(--space-2) 0 var(--space-3); }
.link-panel .modal-actions {
  position: sticky;
  bottom: 0;
  background: var(--panel-bg);
  padding-top: var(--space-2);
}
.link-panel .member-add select { width: 100%; }
```

- [x] **Step 3: Update `topology_render.test.js`**

Update `"right-click on a link offers Редактировать and opens the link panel at the click point"` — the title is no longer inside `panel.children` (it's now the independently-addressed `#link-panel-title`), and the offset behavior (panel opens 14px right / 10px down from the click, unchanged from before) still applies:

```js
test("right-click on a link offers Редактировать and opens the link panel at the click point", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 }); // середина связи r1–r2
  const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(edit, "edit item present on a link");
  fire(edit, "click", {});
  const panel = page.ids["link-panel"];
  assert.ok(panel && !panel.hidden, "panel opened");
  assert.match(String(page.ids["link-panel-title"].textContent), /r1.*↔.*r2/, "title names both link devices");
  assert.equal(panel.style.left, "224px", "anchored near the click point");
});
```

Replace `"link panel uses the diagnostic header and close action"`:

```js
test("link panel uses the shared floating-panel header and close action", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  assert.match(String(page.ids["link-panel-title"].textContent), /r1.*↔.*r2/);
  fire(page.ids["link-panel-close"], "click", {});
  assert.ok(page.ids["link-panel"].hidden, "close button hides the panel");
});
```

The remaining link-panel tests (`applying a filter...`, `clearing a filter...`, `cancel closes the link panel...`, `editing a just-created link...`) look up buttons via `findBtn(panel, ...)` where `panel = page.ids["link-panel"]`; since those buttons (toggle/select/apply/cancel) still live inside `#link-panel-body` which is itself a child appended under `#link-panel` in the real DOM, but in this stub's flat id registry `#link-panel-body` is a *separate* auto-vivified element, not a child of `#link-panel`. Update each of those four tests' `const panel = page.ids["link-panel"];` line to:

```js
  const panel = page.ids["link-panel-body"];
```

(only that one line changes in each of the four tests — the rest of each test body is unchanged, since `render()` still appends the toggle/grid/actions into the body element, just under a different id than before).

- [x] **Step 4: Run to verify failure**

Run: `cd internal/httpapi/web && node --test topology_render.test.js`
Expected: the link-panel tests FAIL (`link_panel.js` still builds its own header and appends everything to `#link-panel` directly).

- [x] **Step 5: Rewrite `link_panel.js`**

```js
"use strict";

import { showBanner } from "./common.js";
import { createFloatingPanel } from "./floating_panel.js";

// LinkPanel — плавающая панель редактирования фильтра одной связи, открываемая
// с холста топологии (ПКМ по связи → «Редактировать», недоступно пока
// create-link этой связи не подтверждён — см. Topology.openLinkPanel).
// Дублирует часть /ui/links (переключение обычная/фильтрованная,
// экспорт/импорт по сторонам); правки применяет onApply(filter|null), которое
// ставит set-link-filter/clear-link-filter в очередь операций немедленно —
// не общей кнопкой «Сохранить». Хром (открытие/закрытие/drag/мировая
// привязка/клэмп) — floating_panel.js; render() наполняет только
// #link-panel-title/#link-panel-body.
const LinkPanel = (() => {
  // OFFSET сдвигает панель от точки ПКМ, чтобы курсор не оказывался ровно
  // на её углу — как и раньше.
  const OFFSET = { x: 14, y: 10 };

  let s = null; // {link, filter: {aExports,bExports}|null, subnets, candidates, deps}
  let panel = null;

  const titleEl = () => document.getElementById("link-panel-title");
  const bodyEl = () => document.getElementById("link-panel-body");

  function cidrOf(name) {
    const sn = (s.subnets || []).find((x) => x.name === name);
    return sn ? sn.cidr : "";
  }

  // row строит строку «бейдж имени + CIDR», опционально с кнопкой удаления
  function row(name, onRemove) {
    const el = document.createElement("div");
    el.setAttribute("class", "member-row");
    const badge = document.createElement("span");
    badge.setAttribute("class", "owner-badge");
    badge.textContent = name;
    const hint = document.createElement("span");
    hint.setAttribute("class", "hint");
    hint.textContent = cidrOf(name);
    el.append(badge, hint);
    if (onRemove) {
      const del = document.createElement("button");
      del.setAttribute("class", "icon-btn delete");
      del.setAttribute("title", "Убрать из экспорта");
      del.textContent = "✕";
      del.addEventListener("click", onRemove);
      el.append(del);
    }
    return el;
  }

  function list(names, onRemove) {
    const el = document.createElement("div");
    el.setAttribute("class", "member-list" + (onRemove ? "" : " import-list"));
    if (!names.length) {
      const empty = document.createElement("p");
      empty.setAttribute("class", "hint member-empty");
      empty.textContent = onRemove ? "Экспорт не выбран" : "Сосед ничего не экспортирует";
      el.append(empty);
    } else {
      names.forEach((n) => el.append(row(n, onRemove && (() => {
        s.filter[onRemove] = s.filter[onRemove].filter((x) => x !== n);
        render();
      }))));
    }
    return el;
  }

  // addRow — селект доступных кандидатов (уже выбранные скрыты), выбор
  // сразу добавляет запись в экспорт этой стороны.
  function addRow(side, key) {
    const el = document.createElement("div");
    el.setAttribute("class", "member-add");
    const select = document.createElement("select");
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "добавить…";
    select.append(opt0);
    (s.candidates[side] || [])
      .filter((e) => !s.filter[key].includes(e.name))
      .forEach((e) => {
        const opt = document.createElement("option");
        opt.value = e.name;
        opt.textContent = e.cidr ? `${e.name} (${e.cidr})` : e.name;
        select.append(opt);
      });
    select.addEventListener("change", () => {
      const name = select.value;
      if (name && !s.filter[key].includes(name)) s.filter[key] = [...s.filter[key], name];
      render();
    });
    el.append(select);
    return el;
  }

  function sideColumn(side) {
    const key = side + "Exports";
    const peerKey = (side === "a" ? "b" : "a") + "Exports";
    const device = s.link[side].device;
    const peer = s.link[side === "a" ? "b" : "a"].device;
    const wrap = document.createElement("div");
    const legend = document.createElement("h4");
    legend.setAttribute("class", "filter-dir-title");
    legend.textContent = `${device} → ${peer}`;
    const exTitle = document.createElement("div");
    exTitle.setAttribute("class", "hint");
    exTitle.textContent = "Экспорт";
    const imTitle = document.createElement("div");
    imTitle.setAttribute("class", "hint");
    imTitle.textContent = `Импорт (из ${peer})`;
    wrap.append(legend, exTitle, list(s.filter[key], key), addRow(side, key), imTitle, list(s.filter[peerKey], null));
    return wrap;
  }

  function actions() {
    const el = document.createElement("div");
    el.setAttribute("class", "modal-actions");
    const cancel = document.createElement("button");
    cancel.setAttribute("type", "button");
    cancel.textContent = "Отмена";
    cancel.addEventListener("click", () => panel.close());
    const apply = document.createElement("button");
    apply.setAttribute("type", "button");
    apply.setAttribute("class", "primary");
    apply.textContent = "Применить";
    apply.addEventListener("click", () => {
      const filter = s.filter ? { aExports: [...s.filter.aExports], bExports: [...s.filter.bExports] } : null;
      s.deps.onApply(filter);
      panel.close();
    });
    el.append(cancel, apply);
    return el;
  }

  // render наполняет заголовок и тело панели содержимым текущего состояния
  // s; вызывается после каждого изменения (переключение фильтра, добавление/
  // удаление экспорта) — reflow() в конце переклэмпивает панель под новый
  // размер (высота растёт при переключении в фильтрованную связь).
  function render() {
    const b = bodyEl();
    if (!b || !s) return;
    titleEl().textContent = `Связь ${s.link.a.device} ↔ ${s.link.b.device}`;
    b.innerHTML = "";
    const toggle = document.createElement("button");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("class", "secondary btn-sm");
    toggle.textContent = s.filter ? "Вернуть обычную" : "Сделать фильтрованной";
    toggle.addEventListener("click", () => {
      if (s.filter) s.filter = null;
      else {
        s.filter = { aExports: [], bExports: [] };
        loadCandidates();
      }
      render();
    });
    b.append(toggle);
    if (s.filter) {
      const grid = document.createElement("div");
      grid.setAttribute("class", "link-panel-grid");
      grid.append(sideColumn("a"), sideColumn("b"));
      b.append(grid);
    } else {
      const hint = document.createElement("p");
      hint.setAttribute("class", "hint");
      hint.textContent = "Обычная связь даёт полную связность между устройствами.";
      b.append(hint);
    }
    b.append(actions());
    panel.reflow();
  }

  // loadCandidates fetches export candidates for both sides of the link
  // currently open. token captures the specific `s` object this fetch was
  // started for: if the panel gets closed/reopened (for the same or a
  // different link) before the fetch settles, `s` is reassigned or nulled,
  // so `s !== token` discards the now-stale response instead of writing it
  // into whatever is open now.
  async function loadCandidates() {
    const token = s;
    const { deps } = s;
    try {
      const [a, b] = await Promise.all([deps.fetchExports("a"), deps.fetchExports("b")]);
      if (s === token) s.candidates = { a, b };
    } catch (e) {
      if (s === token) s.candidates = { a: [], b: [] };
      if (typeof showBanner === "function") showBanner("Не удалось загрузить доступные сети: " + e.message);
    }
    render();
  }

  // show открывает панель для связи link (deps.fetchExports(side) уже
  // замкнут на конкретную пару link.a/link.b — см. Topology.openLinkPanel)
  // рядом с экранной точкой at (правый клик), со сдвигом OFFSET.
  function show(link, deps, at) {
    s = {
      link, deps,
      filter: link.filter ? { aExports: [...link.filter.aExports], bExports: [...link.filter.bExports] } : null,
      subnets: deps.subnets || [],
      candidates: { a: [], b: [] },
    };
    panel.open({ x: at.x + OFFSET.x, y: at.y + OFFSET.y });
    render();
    if (s.filter) loadCandidates();
  }

  function hide() {
    panel.close();
  }

  // attach создаёт панель поверх канваса: getCamera — геттер камеры холста
  // (topology.js's State.camera), нужен для мировой привязки — та же логика,
  // что и у net-edit/device-edit (см. Topology.applyCamera). onClose чистит
  // s, чтобы дальнейший render() (например от уже летящего loadCandidates)
  // не писал в закрытую панель.
  function attach(canvasEl, getCamera) {
    panel = createFloatingPanel({
      panelId: "link-panel",
      headerId: "link-panel-header",
      closeId: "link-panel-close",
      viewportEl: () => canvasEl,
      getCamera,
      fallbackW: 380,
      fallbackH: 320,
      closeOnEscape: true,
      closeOnCanvasClick: () => canvasEl,
      onClose: () => { s = null; },
    });
  }

  function position() {
    if (panel) panel.position();
  }

  return Object.freeze({ show, hide, attach, position });
})();

export { LinkPanel };
```

- [x] **Step 6: Update `topology.js`**

In `openLinkPanel`, drop the now-unneeded canvas-bounds computation (the factory reads the viewport itself):

```js
  function openLinkPanel(link, at) {
    if (isLinkCreatePending(link.a.device, link.b.device)) return;
    LinkPanel.show(link, {
      subnets: State.subnets,
      fetchExports: (side) => Api.get(apiPath(`link-exports?a=${link.a.device}&b=${link.b.device}&side=${side}`)).then((res) => res.entities || []),
      onApply: (filter) => {
        enqueueOp({
          kind: filter ? "set-link-filter" : "clear-link-filter",
          link: { a: { device: link.a.device }, b: { device: link.b.device } },
          ...(filter ? { filter } : {}),
        });
      },
    }, at);
  }
```

Extend `applyCamera()` (as left by Task 2) with one more line:

```js
  function applyCamera() {
    view.invalidate();
    movePopover();
    minimap.update();
    netEditPanel?.position();
    deviceEditPanel?.position();
    LinkPanel.position();
  }
```

In `boot()`, pass the camera getter to `LinkPanel.attach`:

```js
    NetInfo.attach(canvas());
    LinkPanel.attach(canvas(), () => State.camera);
```

- [x] **Step 7: Run to verify `topology_render.test.js` passes**

Run: `cd internal/httpapi/web && node --test topology_render.test.js`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add internal/httpapi/web/link_panel.js internal/httpapi/web/topology.js internal/httpapi/web/topology.html internal/httpapi/web/style.css internal/httpapi/web/topology_render.test.js
git commit -m "refactor(web): move link-panel onto floating_panel.js"
```

---

## Task 4: Diagnose panels (`#diag-panel`, `#spread-panel`) → `floating_panel.js` ✅ complete (commit 0ac021f, review clean)

**Files:**
- Modify: `internal/httpapi/web/diagnose.js`
- Modify: `internal/httpapi/web/diagnose.html`
- Modify: `internal/httpapi/web/style.css`
- Modify: `internal/httpapi/web/diagnose_page.test.js` *(planning gap — the plan's "Step 4: confirm zero edits needed" claim was wrong: 3 tests hardcoded the old local engine's mechanics. Executed anyway: see ledger Task 4 ruling.)*

**Interfaces:**
- Consumes: `createFloatingPanel` (Task 1).
- Produces: nothing new consumed elsewhere — diagnose.js is a leaf page.

- [x] **Step 1: Update `diagnose.html`**

Add the shared class to both panel roots (keep the existing `diag-panel*` classes as modifiers):

```html
      <div id="diag-panel" class="floating-panel diag-panel">
        <header id="diag-panel-header" class="floating-panel-header">
          <strong class="floating-panel-title">Диагностика пути</strong>
          <button type="button" id="diag-panel-close" class="floating-panel-close" title="Закрыть" aria-label="Закрыть">&times;</button>
        </header>
        <div class="floating-panel-body diag-panel-body">
```

```html
      <div id="spread-panel" class="floating-panel diag-panel" hidden>
        <header id="spread-panel-header" class="floating-panel-header">
          <strong class="floating-panel-title">Распространение сети</strong>
          <button type="button" id="spread-panel-close" class="floating-panel-close" title="Закрыть" aria-label="Закрыть">&times;</button>
        </header>
        <div class="floating-panel-body diag-panel-body">
```

(the closing tags and everything inside each `diag-panel-body` div are unchanged).

- [x] **Step 2: Update `style.css`**

Replace the `/* — диагностика пути: плавающее окно параметров и отчёта — */` block's chrome rules (`.diag-panel`, `.diag-panel[hidden]`, `.diag-panel-header`, `.diag-panel-close`, `.diag-panel-close:hover`, `.diag-panel-body` — but NOT the `.diag-path`/`.badge`/etc. rules that follow, which are unrelated report styling and stay) with:

```css
/* — диагностика пути: плавающее окно параметров и отчёта — */
/* .diag-panel — модификатор поверх .floating-panel для #diag-panel/
   #spread-panel: тело со своим вертикальным скроллом (в отличие от
   .net-edit, у этих панелей нет всплывающего поверх .member-suggestions,
   которому нужен был бы overflow: visible). */
.diag-panel-body { overflow-y: auto; }
```

- [x] **Step 3: Update `diagnose.js`**

Add the import, next to the existing `Camera` import:

```js
import { Camera } from "./camera.js";
import { createFloatingPanel } from "./floating_panel.js";
```

Delete the local `createFloatingPanel` function entirely (the block from the `// — плавающие окна параметров ... —` comment through its closing `return { position };` and `}`).

Replace `wirePanels()`:

```js
  // — плавающие окна параметров: тумблер тулбара, перетаскивание, позиция —
  // Каждое окно привязано не к экрану, а к точке мировых координат холста
  // (anchor, floating_panel.js): при панорамировании/зуме камеры оно
  // остаётся на том же месте карты. Тулбар-кнопка сама решает, открывать или
  // закрывать — createFloatingPanel только хранит состояние и красит кнопку
  // через onOpenChange.
  function wirePanels() {
    const diagPanel = createFloatingPanel({
      panelId: "diag-panel", headerId: "diag-panel-header", closeId: "diag-panel-close",
      viewportEl: wrapEl, getCamera: () => state.camera,
      posKey: "firenet-diag-panel-pos-v2", openKey: "firenet-diag-panel-open-v1", defaultOpen: true,
      onOpenChange: (open) => document.getElementById("diag-tool-path").classList.toggle("active", open),
    });
    document.getElementById("diag-tool-path").addEventListener("click", () => {
      if (diagPanel.isOpen()) diagPanel.close(); else diagPanel.open();
    });
    panels.push(diagPanel);

    const spreadPanel = createFloatingPanel({
      panelId: "spread-panel", headerId: "spread-panel-header", closeId: "spread-panel-close",
      viewportEl: wrapEl, getCamera: () => state.camera,
      posKey: "firenet-spread-panel-pos-v1", openKey: "firenet-spread-panel-open-v1", defaultOpen: false,
      onOpenChange: (open) => document.getElementById("diag-tool-spread").classList.toggle("active", open),
    });
    document.getElementById("diag-tool-spread").addEventListener("click", () => {
      if (spreadPanel.isOpen()) spreadPanel.close(); else spreadPanel.open();
    });
    panels.push(spreadPanel);
  }
```

(`panels` stays the module-level array it already is — `setCam`'s `panels.forEach((p) => p.position())` line is untouched, and `createFloatingPanel`'s returned object already exposes `position`).

- [x] **Step 4: Run the diagnose suite to confirm no regression**

Run: `cd internal/httpapi/web && node --test diagnose_page.test.js`
Expected: PASS, with no edits to `diagnose_page.test.js` — it drives the panel purely through DOM events (`fire(ids["diag-tool-path"], "click", ...)`, `ids["diag-panel"].hidden`, `classList.contains("active")`) and the clamp-math test (`"opening the panel snaps it back into the viewport if it drifted off-screen"`, expecting `"892px"/"592px"`) already exercises the exact symmetric-margin formula `floating_panel.js` implements — this is what confirms the new engine is behaviorally identical to the old inline one for these two panels. If anything fails, the mismatch is the signal to fix (do not edit the test to force a pass without understanding why).

- [x] **Step 5: Commit**

```bash
git add internal/httpapi/web/diagnose.js internal/httpapi/web/diagnose.html internal/httpapi/web/style.css
git commit -m "refactor(web): move diag-panel/spread-panel onto floating_panel.js"
```

---

## Final check

- [x] Run the full JS suite once more end to end: `cd internal/httpapi/web && node --test *.test.js`
- [x] `go build ./...` (sanity: no Go changes in this plan, but confirms nothing else broke)
- [x] Read the final `style.css` diff top to bottom to confirm no leftover duplicate rule (e.g. an old `.net-edit-header` or `.diag-panel-header` block accidentally left behind).
