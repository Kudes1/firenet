"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// DOM stubs mirror topology_render.test.js; search needs the same boot
// pipeline (common.js + camera.js + canvas modules + topology.js) plus the
// #topo-search-toggle button and the #topo-search input it reveals.
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    dataset: {},
    _classes: new Set(),
    style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    append(...cs) { this.children.push(...cs); },
    prepend(...cs) { this.children.unshift(...cs); },
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
  el.classList = {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

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

function fire(target, type, ev) {
  ev.type = type;
  if (!ev.target) ev.target = target;
  ev.preventDefault ||= () => {};
  ev.stopPropagation ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
  if (type === "click" && target.onclick) target.onclick(ev);
}

function bootTopology(responses, draftID = "d1") {
  const draftStore = draftID ? { "firenet-draft-id": draftID } : {};
  const calls = [];
  const ctx = makeCtx();
  const canvas = Object.assign(makeEl("canvas"), {
    clientWidth: 1200,
    clientHeight: 800,
    getContext: () => ctx,
  });
  const ids = {};
  const doc = {
    readyState: "loading",
    listeners: {},
    body: makeEl("body"),
    documentElement: { dataset: {} },
    getElementById: (id) => (id === "topo-canvas" ? canvas : (ids[id] ||= makeEl("div"))),
    createElement: (tag) => makeEl(tag),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = doc.listeners[t];
      if (list) doc.listeners[t] = list.filter((f) => f !== fn);
    },
  };
  // управляемые кадры: rAF-очередь + фейковые часы (Enter летит к совпадению
  // твином камеры)
  let clock = 0;
  const rafQueue = [];
  const sandbox = {
    document: doc,
    window: {
      addEventListener(t, fn) { (doc.listeners["win-" + t] ||= []).push(fn); },
      dispatchEvent() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in draftStore ? draftStore[k] : null),
      setItem: (k, v) => { draftStore[k] = v; },
      removeItem: (k) => { delete draftStore[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent() {},
    confirm: () => false,
    prompt: () => null,
    FormData: class { get() { return ""; } },
    Path2D: class {},               // стаб для kind:"glyph"
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    setTimeout,
    clearTimeout,
    Promise,
    console,
    fetch: async (p, opts) => {
      calls.push({ path: p, method: opts?.method || "GET" });
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of [
    "common.js", "camera.js", "minimap.js", "camera_input.js", "netmap.js", "tween.js",
    "canvas_theme.js", "hit_test.js", "canvas_view.js", "topo_scene.js",
    "net_info.js", "link_panel.js", "topology_sync.js", "topology.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  return {
    canvas, ctx, doc, ids, get: (expr) => vm.runInContext(expr, sandbox), sandbox, calls,
    // pump исполняет кадры до исчерпания очереди (твин камеры дошёл до цели)
    pump() {
      while (rafQueue.length) {
        clock += 50;
        rafQueue.splice(0).forEach((fn) => fn(clock));
      }
    },
  };
}

// подсветка поиска на канве: совпавшие получают утолщённый контур (search-hit
// в styled() добавляет +2 к lineWidth), остальные приглушены.
// JSON-прогон: массивы из vm-контекста не сравниваются deepEqual напрямую.
const hitIds = (get) => JSON.parse(get(`JSON.stringify(State.list.filter((i) => i.style.lineWidth > 2).map((i) => i.id))`));
const dimCount = (get) => get(`State.list.filter((i) => (i.style.alpha ?? 1) < 1).length`);
const cam = (get) => JSON.parse(get("JSON.stringify(State.camera)"));

// поиск вводится в поле #topo-search событием input; элемент создаётся в том
// же реестре, откуда его возьмёт production-код
function search(ids, q) {
  const input = (ids["topo-search"] ||= makeEl("input"));
  input.value = q;
  fire(input, "input", {});
}

const responses = {
  "/api/drafts/d1/topology": {
    devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }],
    links: [],
    networks: [
      { name: "net1", subnets: ["office"], attach: [] },
      { name: "lan", subnets: [], attach: [] },
    ],
    unions: [{ name: "office-union", devices: ["r1"] }],
  },
  "/api/drafts/d1/subnets": {
    subnets: [{ name: "office", cidr: "10.0.0.0/24" }, { name: "guest", cidr: "192.168.5.0/24" }],
  },
  "/api/drafts/d1/layout": {},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("search by device name highlights it and dims the rest", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "sw1");
  page.pump(); // твин затемнения проявляется кадрами
  assert.deepEqual(hitIds(page.get), ["device:sw1"], "one highlighted device");
  assert.ok(!hitIds(page.get).some((id) => id.startsWith("network:")), "networks untouched");
  assert.ok(dimCount(page.get) > 0, "non-matching elements dimmed");
});

test("search is case-insensitive", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "SW1");
  assert.deepEqual(hitIds(page.get), ["device:sw1"], "case-insensitive name match");
});

test("network matches by subnet CIDR substring and highlights the network node", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "10.0.0");
  assert.deepEqual(hitIds(page.get), ["network:net1"], "net1 cloud highlighted via its subnet cidr");
});

test("host IP inside a subnet prefix finds the owning network", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "10.0.0.55");
  assert.deepEqual(hitIds(page.get), ["network:net1"], "net1 found by contained host address");

  search(page.ids, "10.0.1.1");
  assert.deepEqual(hitIds(page.get), [], "address outside every prefix matches nothing");
});

test("empty query clears highlighting and dimming", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "r1");
  search(page.ids, "");
  page.pump(); // дождались затухания затемнения
  assert.deepEqual(hitIds(page.get), []);
  assert.equal(dimCount(page.get), 0);
});

test("no-match query leaves everything dimmed and nothing hit", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "zzz");
  page.pump();
  assert.deepEqual(hitIds(page.get), []);
  assert.ok(dimCount(page.get) > 0, "all elements dimmed");
});

test("first match centers the camera on the node", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "r1");
  page.pump(); // камера долетает коротким твином
  // r1 sits at default layout (40,40), center (110,70); canvas stub 1200x800
  assert.deepEqual(cam(page.get), { x: 490, y: 330, z: 1 });
});

test("search dim fades in and out through state.searchFade", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "r1");
  assert.equal(page.get("State.searchFade"), 0, "fade starts transparent");
  page.pump();
  assert.ok(page.get("State.searchFade") > 0, "dim faded in");
  search(page.ids, "");
  page.pump();
  assert.equal(page.get("State.searchFade"), 0, "clearing fades the dim back out");
});

test("Enter cycles the camera through the matches", async () => {
  const page = bootTopology(responses);
  await tick();
  search(page.ids, "1"); // r1, sw1 и net1
  page.pump(); // первый хит тоже летит твином
  assert.deepEqual(cam(page.get), { x: 490, y: 330, z: 1 }, "camera on the first hit");
  fire(page.ids["topo-search"], "keydown", { key: "Enter" });
  page.pump(); // камера долетает твином
  assert.deepEqual(cam(page.get), { x: 290, y: 330, z: 1 }, "second hit centered");
  fire(page.ids["topo-search"], "keydown", { key: "Enter" });
  page.pump();
  assert.deepEqual(cam(page.get), { x: 480, y: 70, z: 1 }, "third hit (net1 at 40,300) centered");
  fire(page.ids["topo-search"], "keydown", { key: "Enter" });
  page.pump();
  assert.deepEqual(cam(page.get), { x: 490, y: 330, z: 1 }, "wraps back to the first hit");
});

test("search field stays hidden until the magnifier is clicked", async () => {
  const page = bootTopology(responses);
  await tick();
  assert.equal(page.ids["topo-search"].hidden, true, "input hidden on load");
  fire(page.ids["topo-search-toggle"], "click", {});
  assert.equal(page.ids["topo-search"].hidden, false, "magnifier reveals the input");
});

test("a background canvas click resets the search", async () => {
  const page = bootTopology(responses);
  await tick();
  fire(page.ids["topo-search-toggle"], "click", {});
  search(page.ids, "r1");
  assert.deepEqual(hitIds(page.get), ["device:r1"]);
  fire(page.canvas, "click", {}); // empty-background click
  assert.equal(page.ids["topo-search"].value, "", "query cleared");
  assert.equal(page.ids["topo-search"].hidden, true, "field hidden again");
  assert.deepEqual(hitIds(page.get), []);
});

test("Escape clears the query and the highlighting", async () => {
  const page = bootTopology(responses);
  await tick();
  fire(page.ids["topo-search-toggle"], "click", {});
  search(page.ids, "r1");
  fire(page.ids["topo-search"], "keydown", { key: "Escape" });
  assert.equal(page.ids["topo-search"].value, "", "input cleared");
  assert.equal(page.ids["topo-search"].hidden, true, "input hidden again");
  page.pump();
  assert.deepEqual(hitIds(page.get), []);
  assert.equal(dimCount(page.get), 0);
});

test("blurring an empty field hides it, a filled one stays visible", async () => {
  const page = bootTopology(responses);
  await tick();
  fire(page.ids["topo-search-toggle"], "click", {});
  fire(page.ids["topo-search"], "blur", {});
  assert.equal(page.ids["topo-search"].hidden, true, "empty blur hides the input");
  fire(page.ids["topo-search-toggle"], "click", {});
  search(page.ids, "r1");
  fire(page.ids["topo-search"], "blur", {});
  assert.equal(page.ids["topo-search"].hidden, false, "active query keeps the input visible");
});
