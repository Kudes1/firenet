"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Minimal DOM stub sufficient to drive link_panel.js outside a browser,
// same shape as net_info.test.js but with addEventListener-based controls
// (buttons, selects) so click/change can be fired on them directly.
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    value: "",
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
  return el;
}

function fire(target, type, ev = {}) {
  ev.type = type;
  if (!ev.target) ev.target = target;
  if (!ev.preventDefault) ev.preventDefault = () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
}

// texts walks a node's subtree collecting every textContent set on it,
// in document order — same helper shape as net_info.test.js.
function texts(node) {
  const out = [];
  (function walk(n) {
    if (n._text) out.push(String(n._text));
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

function findAll(node, pred) {
  const out = [];
  (function walk(n) {
    if (pred(n)) out.push(n);
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

function findBtn(node, text) {
  return findAll(node, (n) => n.tag === "button" && String(n.textContent).trim() === text)[0];
}

(async () => {
  // common.js при импорте подписывается на document — стаб нужен до импортов
  global.document = { addEventListener() {} };
  const { LinkPanel } = await import(path.join(__dirname, "link_panel.js"));

  function boot() {
    const canvas = makeEl("canvas");
    const box = makeEl("div");
    box.hidden = true;
    const doc = {
      readyState: "complete",
      listeners: {},
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => (id === "link-panel" ? box : null),
      addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
      removeEventListener(t, fn) {
        const list = doc.listeners[t];
        if (list) doc.listeners[t] = list.filter((f) => f !== fn);
      },
    };
    const banners = [];
    global.document = doc;
    // showBanner приходит из common.js и шлёт событие notify через window
    global.window = { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } };
    return { canvas, doc, box, banners };
  }

  const subnets = [
    { name: "office", cidr: "10.0.0.0/24" },
    { name: "guests", cidr: "10.0.1.0/24" },
  ];

  const plainLink = { a: { device: "r1" }, b: { device: "r2" } };
  const filteredLink = { a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["office"], bExports: [] } };

  function showPanel(page, link, opts = {}) {
    const applied = [];
    const fetched = [];
    LinkPanel.show(link, {
      subnets,
      fetchExports: (side) => {
        fetched.push(side);
        return Promise.resolve((opts.candidates ?? { a: [{ name: "guests", cidr: "10.0.1.0/24" }], b: [] })[side]);
      },
      onApply: (filter) => applied.push(filter),
    }, { x: 100, y: 50 }, { w: 1200, h: 800 });
    return { applied: () => applied, fetched: () => fetched };
  }

  test("show opens a plain link with a toggle to make it filtered", () => {
    const page = boot();
    showPanel(page, plainLink);
    assert.ok(!page.box.hidden, "panel opened");
    assert.match(texts(page.box).join("|"), /r1.*↔.*r2/, "title names both devices");
    assert.ok(findBtn(page.box, "Сделать фильтрованной"), "offers to make the link filtered");
    assert.ok(!findBtn(page.box, "Вернуть обычную"), "no revert button for a plain link");
  });

  test("show opens an already-filtered link with export/import columns and fetches candidates", async () => {
    const page = boot();
    const { fetched } = showPanel(page, filteredLink);
    await Promise.resolve();
    assert.ok(findBtn(page.box, "Вернуть обычную"), "offers to revert to a plain link");
    assert.deepEqual(fetched().sort(), ["a", "b"], "loads candidates for both sides");
    assert.ok(texts(page.box).includes("office"), "existing export shown");
  });

  test("toggling to filtered starts with empty exports and loads candidates", async () => {
    const page = boot();
    const { fetched } = showPanel(page, plainLink);
    fire(findBtn(page.box, "Сделать фильтрованной"), "click");
    await Promise.resolve();
    assert.ok(findBtn(page.box, "Вернуть обычную"), "now shows the revert button");
    assert.deepEqual(fetched().sort(), ["a", "b"], "candidates fetched on toggle");
  });

  test("toggling back to plain drops the filter and export columns", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.box, "Вернуть обычную"), "click");
    assert.ok(findBtn(page.box, "Сделать фильтрованной"), "back to the plain-link view");
    assert.ok(!texts(page.box).includes("office"), "export list is gone");
  });

  test("picking a candidate from the select adds it to that side's export", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    const select = findAll(page.box, (n) => n.tag === "select")[0];
    select.value = "guests";
    fire(select, "change");
    assert.ok(texts(page.box).includes("guests"), "new export listed");
  });

  test("removing an export drops it from the list", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    const del = findAll(page.box, (n) => n.tag === "button" && n.attrs.class === "icon-btn delete")[0];
    assert.ok(del, "remove button present for the existing export");
    fire(del, "click");
    assert.ok(!texts(page.box).includes("office"), "export removed");
  });

  test("adding an export on side a mirrors it as an import on side b", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    assert.match(texts(page.box).join("|"), /Импорт \(из r1\).*office/s, "b's import column mirrors a's export");
  });

  test("apply hands the current filter to onApply and closes the panel", async () => {
    const page = boot();
    const { applied } = showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.box, "Применить"), "click");
    assert.deepEqual(applied(), [{ aExports: ["office"], bExports: [] }]);
    assert.ok(page.box.hidden, "panel closes after apply");
  });

  test("apply on a plain link (after reverting) hands onApply null", async () => {
    const page = boot();
    const { applied } = showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.box, "Вернуть обычную"), "click");
    fire(findBtn(page.box, "Применить"), "click");
    assert.deepEqual(applied(), [null]);
  });

  test("cancel closes the panel without calling onApply", async () => {
    const page = boot();
    const { applied } = showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.box, "Отмена"), "click");
    assert.ok(page.box.hidden, "panel closed");
    assert.deepEqual(applied(), []);
  });

  test("show clamps the panel inside the canvas bounds", () => {
    const page = boot();
    LinkPanel.show(plainLink,
      { subnets: [], fetchExports: () => Promise.resolve([]), onApply: () => {} },
      { x: 5000, y: -50 }, { w: 1200, h: 800 });
    assert.ok(parseInt(page.box.style.left, 10) < 1200, "left stays inside the canvas");
    assert.equal(page.box.style.top, "8px", "top clamps to the margin");
  });

  test("dragging the header moves the panel and further renders keep the new position", () => {
    const page = boot();
    showPanel(page, plainLink);
    assert.equal(page.box.style.left, "114px");
    assert.equal(page.box.style.top, "60px");
    const header = findAll(page.box, (n) => n.attrs.class === "diag-panel-header")[0];
    fire(header, "mousedown", { button: 0, clientX: 114, clientY: 60 });
    fire(page.doc, "mousemove", { clientX: 164, clientY: 90 });
    assert.equal(page.box.style.left, "164px", "panel follows the pointer horizontally");
    assert.equal(page.box.style.top, "90px", "panel follows the pointer vertically");
    fire(page.doc, "mouseup", {});
    fire(findBtn(page.box, "Сделать фильтрованной"), "click");
    assert.equal(page.box.style.left, "164px", "toggling the filter keeps the dragged position");
    assert.equal(page.box.style.top, "90px", "toggling the filter keeps the dragged position");
    fire(page.doc, "mousemove", { clientX: 999, clientY: 999 });
    assert.equal(page.box.style.left, "164px", "movement after mouseup no longer drags the panel");
  });

  test("dragging a panel clamped to the canvas edge tracks the pointer immediately, no dead zone", () => {
    const page = boot();
    LinkPanel.show(plainLink,
      { subnets: [], fetchExports: () => Promise.resolve([]), onApply: () => {} },
      { x: 1000, y: 50 }, { w: 1200, h: 800 });
    assert.equal(page.box.style.left, "820px", "opens clamped to the right edge (1200 - 380 width)");
    const header = findAll(page.box, (n) => n.attrs.class === "diag-panel-header")[0];
    fire(header, "mousedown", { button: 0, clientX: 820, clientY: 60 });
    fire(page.doc, "mousemove", { clientX: 810, clientY: 60 });
    assert.equal(page.box.style.left, "810px", "panel follows a 10px drag away from the edge immediately");
  });

  test("hide closes the window; Escape hides it too", () => {
    const page = boot();
    LinkPanel.attach(page.canvas);
    showPanel(page, plainLink);
    LinkPanel.hide();
    assert.ok(page.box.hidden, "hidden after hide()");
    showPanel(page, plainLink);
    fire(page.doc, "keydown", { key: "Escape" });
    assert.ok(page.box.hidden, "Escape hides the open panel");
  });

  test("attach hides on wheel and background mousedown but not on node mousedown", () => {
    const page = boot();
    LinkPanel.attach(page.canvas);
    showPanel(page, plainLink);
    fire(page.canvas, "wheel", { deltaY: -120 });
    assert.ok(page.box.hidden, "wheel zoom hides the panel");
    const node = makeEl("path");
    showPanel(page, plainLink);
    fire(page.canvas, "mousedown", { button: 0, target: node });
    assert.ok(!page.box.hidden, "node mousedown keeps the panel");
    fire(page.canvas, "mousedown", { button: 0, target: page.canvas });
    assert.ok(page.box.hidden, "background mousedown hides the panel");
  });

  test("failed candidate fetch clears candidates and reports via showBanner", async () => {
    const page = boot();
    LinkPanel.show(filteredLink,
      { subnets, fetchExports: () => Promise.reject(new Error("boom")), onApply: () => {} },
      { x: 0, y: 0 }, { w: 1200, h: 800 });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(page.banners.some((m) => m.message.includes("boom")), "error surfaced via showBanner");
  });
})();
