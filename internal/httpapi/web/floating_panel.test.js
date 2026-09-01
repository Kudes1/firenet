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
