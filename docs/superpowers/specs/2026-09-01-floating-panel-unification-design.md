# Unify canvas floating panels (topology + diagnose)

## Motivation

`net-edit`, `device-edit`, `link-panel` (topology canvas) and
`diag-panel`, `spread-panel` (diagnose canvas) are five independent
implementations of the same concept — a header-plus-body panel that
opens near a point on the canvas, can be dragged by its header, closes
on Escape/empty-canvas-click, and clamps to the viewport. Each carries
its own copy of the open/close/drag/clamp math, and its own near-
identical CSS (`.net-edit*`, `.diag-panel*`, `.link-panel`).

The three topology panels are also behaviorally inconsistent with the
two diagnose panels: topology panels are screen-anchored (fixed
on-screen once opened, ignore camera pan/zoom) while diagnose panels
are world-anchored (follow the map, persist position/open state in
`localStorage`). `link-panel` additionally closes on zoom, which
`net-edit`/`device-edit` don't.

This spec unifies all five into one shared engine and makes their
camera behavior consistent (world-anchored). Table-page `<dialog>`
modals (`devices.js`, `networks.js`, `rules.js`, etc.) are explicitly
**out of scope** for this iteration.

## Scope

**In scope:**
- `net-edit`, `device-edit`, `link-panel` (topology.html/topology.js)
- `diag-panel`, `spread-panel` (diagnose.html/diagnose.js)
- A new shared module owning open/close/drag/clamp/position/persist.
- Making all five panels world-anchored (follow camera pan/zoom).
- CSS unification of the three near-duplicate panel-chrome rule sets.

**Out of scope:**
- Table-page `<dialog>` modals (devices/networks/links/rules/sets/
  subnets/unions/users pages) — centered native `<dialog>`, no drag,
  different concept; a possible future iteration.
- Any change to panel *content* (form fields, draft state, save
  logic) — only the surrounding chrome and positioning move.

## Shared module: `floating_panel.js`

New file next to `camera.js`, no Alpine dependency (Alpine is already
used for panel *content* in devices.js/networks.js, but the chrome
engine stays framework-agnostic so diagnose.js/link_panel.js — which
don't use Alpine — can adopt it without pulling Alpine in).

```js
function createFloatingPanel({
  panelId, headerId, closeId,   // element ids for the chrome
  viewportEl,                   // () => canvas-wrap element, for clamp bounds
  getCamera,                    // () => current camera (for world<->screen)
  posKey = null,                // localStorage key for persisted position; null = don't persist
  openKey = null,                // localStorage key for persisted open state; null = don't persist
  defaultOpen = false,
  margin = 8,
  fallbackW, fallbackH,          // used before the panel has been laid out once
})
```

Returns `{ open(worldPoint), close(), position(), isOpen() }`.

Behavior owned by the factory (identical for all five panels):
- `open(worldPoint)`: sets `anchor = worldPoint` (or the last persisted
  anchor from `posKey` if the caller wants that — see per-panel notes
  below), un-hides the panel, positions it, then clamps it into the
  viewport (`clampToViewport`, same as diagnose.js's `open`-time
  clamp). Persists `openKey` if set.
- `close()`: hides the panel, persists `openKey` if set, ends any
  in-progress drag.
- `position()`: projects `anchor` (world) to screen via
  `Camera.worldToScreen(getCamera(), anchor.x, anchor.y)` and writes
  `style.left/top`. The caller must invoke this after every camera
  change (pan/zoom) — same as diagnose.js's `setCam` calling
  `panels.forEach(p => p.position())`.
- Drag: `mousedown` on `headerId` (button 0, not on `closeId`) starts
  tracking; `mousemove` updates `style.left/top` directly with a live
  clamp to `viewportEl()`'s bounds (matches topology.js's current
  `setupFloatingEditDrag`, tighter than diagnose.js's today, which
  only clamps at open/close — this spec standardizes on live clamping
  during drag); `mouseup` recomputes `anchor` via
  `Camera.screenToWorld` and persists `posKey` if set.
- Close-on-gesture: Escape (any time) and left-click on empty canvas
  close the panel (matches today's `setupFloatingEditClose` /
  `LinkPanel.attach`). Zoom/pan do **not** close the panel — they only
  trigger `position()` via the caller's camera-change hook.

Content (form fields, business logic like `saveDraft()` or the link
filter toggle) stays entirely with the caller; the factory never
touches `panel-body` contents.

## Per-callsite integration

### `topology.js`

- `setupFloatingEditClose`, `setupFloatingEditDrag`, and the manual
  clamp/position code inside `showNetworkEdit`/`showDeviceEdit` are
  deleted. Three `createFloatingPanel(...)` calls replace them, created
  in `boot()` where `setupFloatingEditDrag(...)` is called today
  (~line 1580-1583). None of the three pass `openKey` — these are
  entity-edit windows, not toggle tools, so open state never persists
  across reloads. `posKey` **is** set for each (drag position persists
  within/across sessions), but `open(at)` always uses the click point
  passed in, not the persisted position — a right-click on an entity
  should always open at the click, matching today's behavior; the
  persisted position only matters for the panel's position immediately
  after a drag, before it's closed.
- `openNetworkEditWindow(name, at)` / `openDeviceEditWindow(name, at)`:
  call `panel.open(Camera.screenToWorld(State.camera, at.x, at.y))`
  instead of `showNetworkEdit(x, y)`/`showDeviceEdit(x, y)`.
- `openLinkPanel(link, at)`: calls `panel.open(...)` the same way;
  `LinkPanel.show/hide` become thin wrappers that also update `s` and
  call `render()`.
- `setCamera()` (~line 306): calls `.position()` on all three panels
  after applying the new camera, mirroring diagnose.js's `setCam`.
- `devices.js` / `networks.js`: `showDeviceEdit`/`closeDeviceEdit`/
  `showNetworkEdit`/`closeNetworkEdit` and the `*_EDIT_W/H/MARGIN`
  constants are deleted. `openDeviceEdit`/`openNetworkEdit` (canvas
  entry points) and `closeEditor()` now delegate to the panel object
  topology.js owns; `openEdit`/`closeModal` (the native-`<dialog>`
  table-page path) are untouched — out of scope.
- `link_panel.js`: `PLACE`, `onDragStart`/`onDragMove`/`onDragEnd`, and
  the manual clamp in `place()` are deleted. `attach(canvas)` drops its
  own wheel/mousedown/Escape handlers (now the factory's job) — this
  also fixes the current inconsistency where `link-panel` alone closes
  on zoom while `net-edit`/`device-edit` don't.

### `diagnose.js`

- The local `createFloatingPanel` is deleted; `wirePanels()` calls the
  imported version with the same `panelId`/`toolId`-driven open logic,
  `posKey`, `openKey`, `defaultOpen` as today — these two **do** keep
  `openKey` (they're toolbar-toggled tools, not entity editors, so
  persisting "was this panel open" across reloads is the existing,
  correct behavior).
- Toolbar button click handling (`diag-tool-path`/`diag-tool-spread`
  toggling) stays in diagnose.js and calls `panel.open(...)` /
  `panel.close()`.

### CSS (`style.css`)

`.net-edit`, `.net-edit-header`, `.net-edit-title`, `.net-edit-close`,
`.net-edit-body`, `.diag-panel`, `.diag-panel-header`,
`.diag-panel-close`, `.diag-panel-body`, and the header/close portions
of `.link-panel` collapse into one shared family:
`.floating-panel`, `.floating-panel-header`, `.floating-panel-title`,
`.floating-panel-close`, `.floating-panel-body`. Panel-specific
overrides (`--net-edit-w`, `.link-panel-grid`, `.diag-panel-body
form`, etc.) stay as modifiers layered on top of the base class.
Markup in `topology.html`/`diagnose.html` and the DOM built by
`link_panel.js`'s `render()` switch to the shared class names.

## Behavior changes (explicit)

- `net-edit`/`device-edit`/`link-panel` now track the map during
  pan/zoom instead of staying screen-fixed.
- Their on-screen position after a drag persists in `localStorage`
  (per panel, not per entity) — reopening the same kind of panel later
  in a fresh page load restores where it was left, though a right-
  click open always re-anchors to the click point first.
- `link-panel` no longer closes on zoom; it now repositions like the
  other four panels.

## Testing

Automated only, per project convention (no manual browser pass):

- New `floating_panel.test.js`: open/close, drag with live clamp,
  world→screen repositioning on camera change, persistence with and
  without `posKey`/`openKey`.
- Update `topology_render.test.js`, `devices_page.test.js`,
  `networks_page.test.js`, `diagnose_page.test.js` for the new call
  sites (`panel.open()` instead of `showNetworkEdit()`, etc.) as
  regression coverage that open-via-right-click, drag, and save-draft
  still work end to end.

## Non-goals / open follow-ups

- Unifying the native `<dialog>` table-page modals with this engine
  (separate future iteration, per explicit scope decision).
- Any visual redesign of panel content beyond the shared chrome
  classes.
