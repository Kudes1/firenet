"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// DOM stubs mirror topology_render.test.js; search needs the same boot
// pipeline (common.js + camera.js + topology.js) plus the #topo-search-toggle
// button and the #topo-search input it reveals.
function makeEl(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    dataset: {},
    style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    append(...cs) { this.children.push(...cs); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
    blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text || ""; },
    reset() {},
  };
}

function bootTopology(responses) {
  const canvas = makeEl("svg");
  const ids = {};
  const doc = {
    readyState: "loading",
    listeners: {},
    body: makeEl("body"),
    documentElement: { dataset: {} },
    removeEventListener(t, fn) {
      const list = doc.listeners[t];
      if (list) doc.listeners[t] = list.filter((f) => f !== fn);
    },
    createElementNS: (ns, tag) => makeEl(tag),
    getElementById: (id) => (id === "topo-canvas" ? canvas : (ids[id] ||= makeEl("div"))),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
  };
  const sandbox = {
    document: doc,
    window: {
      addEventListener(t, fn) { (doc.listeners["win-" + t] ||= []).push(fn); },
      dispatchEvent() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent() {},
    confirm: () => false,
    prompt: () => null,
    FormData: class { get() { return ""; } },
    setTimeout,
    clearTimeout,
    Promise,
    console,
    fetch: async (p) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "camera.js", "camera_input.js", "netmap.js", "topology.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  return { canvas, doc, ids, get: (expr) => vm.runInContext(expr, sandbox), sandbox };
}

// withClass collects all descendants whose class list contains cls
const withClass = (node, cls) =>
  (function walk(n, out = []) {
    if (String(n.attrs.class || "").split(/\s+/).includes(cls)) out.push(n);
    (n.children || []).forEach((c) => walk(c, out));
    return out;
  })(node);

const viewport = (canvas) => withClass(canvas, "viewport")[0];

function fire(target, type, ev) {
  ev.type = type;
  ev.target = target;
  ev.preventDefault ||= () => {};
  ev.stopPropagation ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
}

// поиск вводится в поле #topo-search событием input; элемент создаётся в том
// же реестре, откуда его возьмёт production-код
function search(ids, q) {
  const input = (ids["topo-search"] ||= makeEl("input"));
  input.value = q;
  fire(input, "input", {});
}

const responses = {
  "/api/topology": {
    devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }],
    links: [],
    networks: [
      { name: "net1", subnets: ["office"], attach: [] },
      { name: "lan", subnets: [], attach: [] },
    ],
    unions: [{ name: "office-union", devices: ["r1"] }],
  },
  "/api/subnets": {
    subnets: [{ name: "office", cidr: "10.0.0.0/24" }, { name: "guest", cidr: "192.168.5.0/24" }],
  },
  "/api/layout": {},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// узел подсвечивается целиком (rect/path/glyph/label), поэтому считаем формы
const hitShapes = (canvas, cls) => withClass(canvas, cls).filter((n) => String(n.attrs.class).includes("search-hit"));

test("search by device name highlights it and dims the rest", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "sw1");
  assert.equal(hitShapes(canvas, "node-rect").length, 1, "one highlighted device");
  assert.equal(hitShapes(canvas, "subnet-rect").length, 0, "networks untouched");
  assert.equal(withClass(canvas, "search-dim").length > 0, true, "non-matching elements dimmed");
});

test("search is case-insensitive", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "SW1");
  assert.equal(hitShapes(canvas, "node-rect").length, 1, "case-insensitive name match");
});

test("network matches by subnet CIDR substring and highlights the network node", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "10.0.0");
  const hits = hitShapes(canvas, "subnet-rect");
  assert.equal(hits.length, 1, "net1 cloud highlighted via its subnet cidr");
});

test("host IP inside a subnet prefix finds the owning network", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "10.0.0.55");
  assert.equal(hitShapes(canvas, "subnet-rect").length, 1, "net1 found by contained host address");

  search(ids, "10.0.1.1");
  assert.equal(withClass(canvas, "search-hit").length, 0, "address outside every prefix matches nothing");
});

test("empty query clears highlighting and dimming", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "r1");
  search(ids, "");
  assert.equal(withClass(canvas, "search-hit").length, 0);
  assert.equal(withClass(canvas, "search-dim").length, 0);
});

test("no-match query leaves everything dimmed and nothing hit", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "zzz");
  assert.equal(withClass(canvas, "search-hit").length, 0);
  assert.equal(withClass(canvas, "search-dim").length > 0, true, "all elements dimmed");
});

test("first match centers the camera on the node", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "r1");
  // r1 sits at default layout (40,40), center (110,70); canvas stub 1200x800
  assert.equal(viewport(canvas).attrs.transform, "translate(490 330) scale(1)");
});

test("Enter cycles the camera through the matches", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  search(ids, "1"); // r1, sw1 и net1
  assert.equal(viewport(canvas).attrs.transform, "translate(490 330) scale(1)", "camera on the first hit");
  fire(ids["topo-search"], "keydown", { key: "Enter" });
  assert.equal(viewport(canvas).attrs.transform, "translate(290 330) scale(1)", "second hit centered");
  fire(ids["topo-search"], "keydown", { key: "Enter" });
  assert.equal(viewport(canvas).attrs.transform, "translate(480 70) scale(1)", "third hit (net1 at 40,300) centered");
  fire(ids["topo-search"], "keydown", { key: "Enter" });
  assert.equal(viewport(canvas).attrs.transform, "translate(490 330) scale(1)", "wraps back to the first hit");
});

test("search field stays hidden until the magnifier is clicked", async () => {
  const { ids } = bootTopology(responses);
  await tick();
  assert.equal(ids["topo-search"].hidden, true, "input hidden on load");
  fire(ids["topo-search-toggle"], "click", {});
  assert.equal(ids["topo-search"].hidden, false, "magnifier reveals the input");
});

test("a background canvas click resets the search", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  fire(ids["topo-search-toggle"], "click", {});
  search(ids, "r1");
  assert.equal(hitShapes(canvas, "node-rect").length, 1);
  fire(canvas, "click", {}); // target === canvas means an empty-background click
  assert.equal(ids["topo-search"].value, "", "query cleared");
  assert.equal(ids["topo-search"].hidden, true, "field hidden again");
  assert.equal(withClass(canvas, "search-hit").length, 0);
});

test("Escape clears the query and the highlighting", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  fire(ids["topo-search-toggle"], "click", {});
  search(ids, "r1");
  fire(ids["topo-search"], "keydown", { key: "Escape" });
  assert.equal(ids["topo-search"].value, "", "input cleared");
  assert.equal(ids["topo-search"].hidden, true, "input hidden again");
  assert.equal(withClass(canvas, "search-hit").length, 0);
  assert.equal(withClass(canvas, "search-dim").length, 0);
});

test("blurring an empty field hides it, a filled one stays visible", async () => {
  const { ids } = bootTopology(responses);
  await tick();
  fire(ids["topo-search-toggle"], "click", {});
  fire(ids["topo-search"], "blur", {});
  assert.equal(ids["topo-search"].hidden, true, "empty blur hides the input");
  fire(ids["topo-search-toggle"], "click", {});
  search(ids, "r1");
  fire(ids["topo-search"], "blur", {});
  assert.equal(ids["topo-search"].hidden, false, "active query keeps the input visible");
});
