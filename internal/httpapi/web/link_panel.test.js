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
    hidden: false,
    offsetWidth: 0,
    offsetHeight: 0,
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

  // boot строит #link-panel/-header/-title/-close/-body (та же статичная
  // разметка, что и topology.html) плюс канвас с getBoundingClientRect для
  // createFloatingPanel'а (viewportEl), и сразу вызывает LinkPanel.attach —
  // с новой сигнатурой show()/reflow() опираются на уже привязанный панельный
  // инстанс. Хром (drag/clamp/Escape/клик по фону/мировая привязка) отсюда
  // не тестируется — он общий для всех floating_panel.js-панелей и покрыт
  // floating_panel.test.js; здесь только собственная логика LinkPanel
  // (наполнение title/body, переключение фильтра, экспорт/импорт, apply/
  // cancel, подгрузка кандидатов).
  function boot() {
    const els = {};
    const canvas = makeEl("canvas");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 });
    const doc = {
      readyState: "complete",
      listeners: {},
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => (els[id] ||= makeEl("div")),
      addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
      removeEventListener(t, fn) {
        const list = doc.listeners[t];
        if (list) doc.listeners[t] = list.filter((f) => f !== fn);
      },
    };
    const box = (els["link-panel"] = makeEl("div"));
    els["link-panel-header"] = makeEl("header");
    const title = (els["link-panel-title"] = makeEl("strong"));
    els["link-panel-close"] = makeEl("button");
    const body = (els["link-panel-body"] = makeEl("div"));
    const banners = [];
    global.document = doc;
    // showBanner приходит из common.js и шлёт событие notify через window
    global.window = { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } };
    LinkPanel.attach(canvas, () => ({ x: 0, y: 0, z: 1 }));
    return { canvas, doc, box, title, body, banners };
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
    }, { x: 100, y: 50 });
    return { applied: () => applied, fetched: () => fetched };
  }

  test("show opens a plain link with a toggle to make it filtered, anchored at at+offset", () => {
    const page = boot();
    showPanel(page, plainLink);
    assert.ok(!page.box.hidden, "panel opened");
    assert.equal(page.box.style.left, "114px", "anchored 14px right of the click point");
    assert.equal(page.box.style.top, "60px", "anchored 10px below the click point");
    assert.match(String(page.title.textContent), /r1.*↔.*r2/, "title names both devices");
    assert.ok(findBtn(page.body, "Сделать фильтрованной"), "offers to make the link filtered");
    assert.ok(!findBtn(page.body, "Вернуть обычную"), "no revert button for a plain link");
  });

  test("show opens an already-filtered link with export/import columns and fetches candidates", async () => {
    const page = boot();
    const { fetched } = showPanel(page, filteredLink);
    await Promise.resolve();
    assert.ok(findBtn(page.body, "Вернуть обычную"), "offers to revert to a plain link");
    assert.deepEqual(fetched().sort(), ["a", "b"], "loads candidates for both sides");
    assert.ok(texts(page.body).includes("office"), "existing export shown");
  });

  test("toggling to filtered starts with empty exports and loads candidates", async () => {
    const page = boot();
    const { fetched } = showPanel(page, plainLink);
    fire(findBtn(page.body, "Сделать фильтрованной"), "click");
    await Promise.resolve();
    assert.ok(findBtn(page.body, "Вернуть обычную"), "now shows the revert button");
    assert.deepEqual(fetched().sort(), ["a", "b"], "candidates fetched on toggle");
  });

  test("toggling back to plain drops the filter and export columns", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.body, "Вернуть обычную"), "click");
    assert.ok(findBtn(page.body, "Сделать фильтрованной"), "back to the plain-link view");
    assert.ok(!texts(page.body).includes("office"), "export list is gone");
  });

  test("picking a candidate from the select adds it to that side's export", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    const select = findAll(page.body, (n) => n.tag === "select")[0];
    select.value = "guests";
    fire(select, "change");
    assert.ok(texts(page.body).includes("guests"), "new export listed");
  });

  test("removing an export drops it from the list", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    const del = findAll(page.body, (n) => n.tag === "button" && n.attrs.class === "icon-btn delete")[0];
    assert.ok(del, "remove button present for the existing export");
    fire(del, "click");
    assert.ok(!texts(page.body).includes("office"), "export removed");
  });

  test("adding an export on side a mirrors it as an import on side b", async () => {
    const page = boot();
    showPanel(page, filteredLink);
    await Promise.resolve();
    assert.match(texts(page.body).join("|"), /Импорт \(из r1\).*office/s, "b's import column mirrors a's export");
  });

  test("sides render in canonical order regardless of which end is stored as a", async () => {
    const page = boot();
    const swapped = { a: { device: "r2" }, b: { device: "r1" }, filter: { aExports: ["office"], bExports: [] } };
    const { applied } = showPanel(page, swapped);
    await Promise.resolve();
    assert.match(String(page.title.textContent), /^Связь r1 ↔ r2$/, "title lists devices canonically");
    const t = texts(page.body);
    const first = t.indexOf("r1 → r2");
    const second = t.indexOf("r2 → r1");
    const office = t.indexOf("office");
    assert.ok(first >= 0 && second >= 0, "both column legends present");
    assert.ok(first < second, "alphabetically-first device renders as the left column");
    assert.ok(second < t.lastIndexOf("office"), "r2's export (office) renders in r2's export list");
    fire(findBtn(page.body, "Применить"), "click");
    assert.deepEqual(applied(), [{ aExports: ["office"], bExports: [] }], "apply still reports real sides");
  });

  test("column end classes follow the canonical order even when the first device is stored in b", async () => {
    const page = boot();
    const swapped = { a: { device: "r2" }, b: { device: "r1" }, filter: { aExports: ["office"], bExports: [] } };
    showPanel(page, swapped);
    await Promise.resolve();
    const cols = findAll(page.body, (n) => n.attrs.class === "link-end-col-a" || n.attrs.class === "link-end-col-b");
    assert.deepEqual(cols.map((c) => c.attrs.class), ["link-end-col-a", "link-end-col-b"],
      "col-a renders before col-b");
    assert.match(texts(cols[0]).join("|"), /r1 → r2/, "col-a (end A color) belongs to r1, alphabetically first");
    assert.match(texts(cols[1]).join("|"), /r2 → r1/, "col-b (end B color) belongs to r2");
  });

  test("apply hands the current filter to onApply and closes the panel", async () => {
    const page = boot();
    const { applied } = showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.body, "Применить"), "click");
    assert.deepEqual(applied(), [{ aExports: ["office"], bExports: [] }]);
    assert.ok(page.box.hidden, "panel closes after apply");
  });

  test("apply on a plain link (after reverting) hands onApply null", async () => {
    const page = boot();
    const { applied } = showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.body, "Вернуть обычную"), "click");
    fire(findBtn(page.body, "Применить"), "click");
    assert.deepEqual(applied(), [null]);
  });

  test("cancel closes the panel without calling onApply", async () => {
    const page = boot();
    const { applied } = showPanel(page, filteredLink);
    await Promise.resolve();
    fire(findBtn(page.body, "Отмена"), "click");
    assert.ok(page.box.hidden, "panel closed");
    assert.deepEqual(applied(), []);
  });

  test("failed candidate fetch clears candidates and reports via showBanner", async () => {
    const page = boot();
    LinkPanel.show(filteredLink,
      { subnets, fetchExports: () => Promise.reject(new Error("boom")), onApply: () => {} },
      { x: 0, y: 0 });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(page.banners.some((m) => m.message.includes("boom")), "error surfaced via showBanner");
  });
})();
