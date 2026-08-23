"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM stub sufficient to boot topology.js outside a browser and
// catch render-time runtime errors (e.g. wrong API response shapes).
function makeEl(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    dataset: {},
    style: {},
    classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    append(...cs) { this.children.push(...cs); },
    prepend(...cs) { this.children.unshift(...cs); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
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
    createElement: (tag) => makeEl(tag),
    // stable registry: production code resolves widgets by id repeatedly
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
    // clone: production mutates loaded state, responses must stay pristine
    fetch: async (p) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "camera.js", "camera_input.js", "netmap.js", "topo_scene.js", "topology.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  // top-level const bindings live in the context's lexical env; grab them
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { canvas, doc, ids, get, sandbox };
}

function count(node) {
  return (node.children || []).reduce((acc, c) => acc + count(c), 1);
}

// find returns the first descendant (depth-first) matching a predicate
function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

const byTag = (node, tag) => find(node, (n) => n.tag === tag);

// withClass collects all descendants whose class list contains cls
const withClass = (node, cls) =>
  (function walk(n, out = []) {
    if (String(n.attrs.class || "").split(/\s+/).includes(cls)) out.push(n);
    (n.children || []).forEach((c) => walk(c, out));
    return out;
  })(node);

const viewport = (canvas) => find(canvas, (n) => n.tag === "g" && String(n.attrs.class || "").includes("viewport"));
const deviceRects = (canvas) =>
  (function walk(n, out = []) {
    if (String(n.attrs.class || "").includes("node-rect")) out.push(n);
    (n.children || []).forEach((c) => walk(c, out));
    return out;
  })(canvas);

// fire dispatches a DOM event to listeners registered via addEventListener
function fire(target, type, ev) {
  ev.type = type;
  ev.target = target;
  ev.preventDefault ||= () => {};
  ev.stopPropagation ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
}

function texts(node) {
  const out = [];
  (function walk(n) {
    if (n._text) out.push(String(n._text));
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

const responses = {
  "/api/topology": {
    devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
    links: [{ a: { device: "r1" }, b: { device: "r2" } }],
    networks: [{ name: "net1", subnets: ["a"], attach: [{ device: "r1" }] }],
    unions: [],
  },
  "/api/subnets": { subnets: [{ name: "a", cidr: "10.0.0.0/24" }] },
  "/api/layout": {},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("topology renders devices, links and networks without errors", async () => {
  const { canvas, doc } = bootTopology(responses);
  await tick();
  const rendered = texts(canvas);
  assert.ok(rendered.includes("r1 (router)"), "device r1 rendered");
  assert.ok(rendered.includes("r2 (router)"), "device r2 rendered");
  assert.ok(rendered.includes("net1"), "network node rendered");
  assert.ok(rendered.includes("a"), "subnet names shown on network node");
  assert.ok(!rendered.includes("10.0.0.0/24"), "no cidr on network node");
});

test("network subtitle summarizes long subnet lists with a +N tail", async () => {
  const topo = {
    devices: [],
    links: [],
    networks: [{ name: "net1", subnets: ["office", "guests-wifi", "dmz-servers", "vpn"] }],
  };
  const { canvas } = bootTopology({
    ...responses,
    "/api/topology": topo,
    "/api/subnets": { subnets: topo.networks[0].subnets.map((name) => ({ name, cidr: "10.0.0.0/24" })) },
  });
  await tick();
  const summary = texts(canvas).find((t) => t.includes("+"));
  assert.equal(summary, "office, guests-wifi +2");
});

test("device kinds get their distinct shape and glyph, unknown kinds fall back", async () => {
  const topo = {
    devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }, { name: "x1", kind: "future" }],
    links: [],
    networks: [],
  };
  const { canvas } = bootTopology({ ...responses, "/api/topology": topo });
  await tick();
  const rects = deviceRects(canvas);
  assert.equal(rects.length, 3, "three device rects");
  assert.equal(rects[0].attrs.rx, 16, "router is strongly rounded");
  assert.equal(rects[1].attrs.rx, 2, "switch is sharp-cornered");
  assert.equal(rects[2].attrs.rx, 6, "unknown kind falls back to plain rect");
  const glyphs = withClass(canvas, "node-glyph").map((g) => g.attrs.class);
  assert.ok(glyphs.some((c) => c.includes("router")), "router glyph rendered");
  assert.ok(glyphs.some((c) => c.includes("switch")), "switch glyph rendered");
  assert.ok(!glyphs.some((c) => c.includes("future")), "unknown kind has no glyph");
});

test("network node renders as a cloud path inside its bbox", async () => {
  const { canvas } = bootTopology(responses);
  await tick();
  const clouds = withClass(canvas, "subnet-rect");
  assert.equal(clouds.length, 1, "one network shape");
  assert.equal(clouds[0].tag, "path", "network is a path, not a rect");
  const d = clouds[0].attrs.d;
  assert.ok(/^M 1?[\d.]+ /.test(d) && d.includes("Z"), "cloud path is a closed outline");
});

test("topology tolerates empty project", async () => {
  const { canvas, doc } = bootTopology({
    "/api/topology": { devices: [], links: [], networks: [] },
    "/api/subnets": { subnets: [] },
    "/api/layout": {},
  });
  await tick();
  assert.ok(viewport(canvas), "viewport group rendered even for empty project");
});

test("camera from layout is applied to the viewport group", async () => {
  const { canvas, doc } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  assert.equal(viewport(canvas).attrs.transform, "translate(-100 -50) scale(2)");
});

test("wheel zooms around the cursor", async () => {
  const { canvas, doc } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  const before = viewport(canvas).attrs.transform;
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  const after = viewport(canvas).attrs.transform;
  assert.notEqual(after, before, "zoom changed the viewport transform");
  // the world point under the cursor stays under the cursor
  const parse = (t) => { const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(t); return { x: +x, y: +y }; };
  const worldAt = (tr, z) => ({ x: (300 - parse(tr).x) / z, y: (200 - parse(tr).y) / z });
  const w0 = worldAt(before, 2);
  const z1 = /scale\(([\d.]+)\)/.exec(after)[1];
  const w1 = worldAt(after, +z1);
  assert.ok(Math.abs(w1.x - w0.x) < 0.01 && Math.abs(w1.y - w0.y) < 0.01, "cursor-anchored zoom");
});

test("middle-button drag pans the camera", async () => {
  const { canvas, doc } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 1 } },
  });
  await tick();
  fire(canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  assert.equal(viewport(canvas).attrs.transform, "translate(60 30) scale(1)");
});

test("node dragging accounts for camera zoom", async () => {
  const { canvas, doc } = bootTopology({
    ...responses,
    "/api/layout": {
      devices: { r1: { x: 100, y: 100 }, r2: { x: 400, y: 100 } },
      networks: { net1: { x: 250, y: 300 } },
      camera: { x: 0, y: 0, z: 2 },
    },
  });
  await tick();
  const rect = deviceRects(canvas).find((n) => n.attrs.x === 100);
  assert.ok(rect, "r1 rect found");
  fire(rect, "mousedown", { button: 0, clientX: 220, clientY: 220 });
  fire(doc, "mousemove", { clientX: 260, clientY: 260 });
  fire(doc, "mouseup", {});
  // 40 screen px at zoom 2 == 20 world px; render rebuilt the element
  const moved = deviceRects(canvas).find((n) => n.attrs.x === 120);
  assert.ok(moved, "r1 moved to x=120 in world coords");
});

test("toolbar switches the active tool", async () => {
  const { ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-connect"], "click", {});
  assert.equal(ids["tool-connect"].attrs.class, "tool active");
  assert.equal(ids["tool-select"].attrs.class, "tool");
});

test("device tool creates a device at the clicked world position", async () => {
  const { canvas, doc, ids } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 2 } },
  });
  await tick();
  const wiresBefore = count(canvas);
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  // naming popover is open
  const input = ids["node-name-input"];
  assert.ok(input, "name input shown");
  input.value = "r3";
  fire(ids["node-name-form"], "submit", {});
  const rendered = texts(canvas);
  assert.ok(rendered.includes("r3 (router)"), "device created");
  assert.ok(count(canvas) > wiresBefore, "tree grew");
  // world position of the click: (150, 100); node is centred on the cursor
  const pos = find(canvas, (n) => String(n.attrs.class || "").includes("node-rect") && n.attrs.x === 150 - 70);
  assert.ok(pos, "device placed centred at the clicked world point");
});

test("network tool creates a network node", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-network"], "click", {});
  fire(canvas, "click", { clientX: 500, clientY: 400 });
  ids["node-name-input"].value = "lan2";
  fire(ids["node-name-form"], "submit", {});
  assert.ok(texts(canvas).includes("lan2"), "network created");
});

test("connect tool links two devices with click-click", async () => {
  // start without the r1–r2 link so the connect tool can create it
  const { canvas, doc, ids } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], links: [] },
  });
  await tick();
  fire(ids["tool-connect"], "click", {});
  // node clicks are plain mousedown+mouseup without movement
  const click = (rect) => {
    fire(rect, "mousedown", { button: 0, clientX: 10, clientY: 10 });
    fire(doc, "mouseup", {});
  };
  click(deviceRects(canvas)[0]);
  click(deviceRects(canvas)[1]);
  const wires = (function walk(n, out = []) {
    if (n.tag === "path" && String(n.attrs.class || "").split(/\s+/).includes("wire")) out.push(n);
    (n.children || []).forEach((c) => walk(c, out));
    return out;
  })(canvas);
  assert.equal(wires.length, 1, "wire rendered for the new link");
});

// select tool: click a node (mousedown+mouseup without movement)
function selectNode(doc, rect, shift) {
  fire(rect, "mousedown", { button: 0, clientX: 10, clientY: 10, shiftKey: !!shift });
  fire(doc, "mouseup", { shiftKey: !!shift });
}

const selectedRects = (canvas) =>
  deviceRects(canvas).filter((n) => String(n.attrs.class || "").includes("selected"));

test("click selects a node, background click clears selection", async () => {
  const { canvas, doc } = bootTopology(responses);
  await tick();
  selectNode(doc, deviceRects(canvas)[0]);
  assert.equal(selectedRects(canvas).length, 1, "one node selected");
  fire(canvas, "click", { clientX: 900, clientY: 700 });
  assert.equal(selectedRects(canvas).length, 0, "selection cleared");
});

test("marquee selects all intersecting nodes", async () => {
  const { canvas, doc } = bootTopology(responses);
  await tick();
  fire(canvas, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(doc, "mousemove", { clientX: 600, clientY: 200 });
  fire(doc, "mouseup", { clientX: 600, clientY: 200 });
  assert.equal(selectedRects(canvas).length, 2, "both devices selected");
});

test("marquee selection survives the trailing click fired by the browser", async () => {
  const { canvas, doc } = bootTopology(responses);
  await tick();
  fire(canvas, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(doc, "mousemove", { clientX: 600, clientY: 200 });
  fire(doc, "mouseup", { clientX: 600, clientY: 200 });
  // a real browser fires click on the svg after the drag (same down/up target)
  fire(canvas, "click", { clientX: 600, clientY: 200 });
  assert.equal(selectedRects(canvas).length, 2, "selection kept after marquee");
});

test("Del removes selected devices", async () => {
  const { canvas, doc } = bootTopology(responses);
  await tick();
  selectNode(doc, deviceRects(canvas)[0]);
  fire(doc, "keydown", { key: "Delete" });
  const names = texts(canvas);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
});

test("connect tool shows a preview wire while connecting", async () => {
  const { canvas, doc, ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-connect"], "click", {});
  const rect = deviceRects(canvas)[0];
  fire(rect, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(doc, "mouseup", {});
  const svg = canvas;
  fire(svg, "mousemove", { clientX: 500, clientY: 300 });
  const preview = find(canvas, (n) => String(n.attrs.class || "").includes("wire-preview"));
  assert.ok(preview, "preview wire rendered");
});

test("context menu deletes a node", async () => {
  const { canvas, doc, ids } = bootTopology(responses);
  await tick();
  fire(deviceRects(canvas)[0], "contextmenu", { clientX: 60, clientY: 60 });
  const menu = ids["topo-context-menu"];
  assert.ok(menu && !menu.hidden, "menu shown");
  const del = menu.children.find((b) => String(b._text || "").startsWith("Удалить"));
  assert.ok(del, "delete item present");
  del.onclick({ stopPropagation() {} });
  assert.ok(!texts(canvas).includes("r1 (router)"), "r1 removed");
});

test("keyboard shortcuts switch tools", async () => {
  const { doc, ids } = bootTopology(responses);
  await tick();
  fire(doc, "keydown", { key: "c" });
  assert.equal(ids["tool-connect"].attrs.class, "tool active");
  fire(doc, "keydown", { key: "v" });
  assert.equal(ids["tool-select"].attrs.class, "tool active");
});

test("popover cancels on Escape", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  const input = ids["node-name-input"];
  assert.ok(!ids["node-popover"].hidden, "popover open");
  fire(input, "keydown", { key: "Escape" });
  assert.ok(ids["node-popover"].hidden, "popover closed");
});

test("creating a node marks the page dirty for DirtyGuard", async () => {
  const { canvas, doc, ids, get } = bootTopology(responses);
  await tick();
  assert.equal(get("DirtyGuard.isDirty()"), false, "clean after boot");
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  ids["node-name-input"].value = "r3";
  fire(ids["node-name-form"], "submit", {});
  assert.equal(get("DirtyGuard.isDirty()"), true, "unsaved node makes the page dirty");
});

// --- delete button (trash) replaces inline crosses ---

test("no inline delete crosses are rendered on the canvas", async () => {
  const { canvas } = bootTopology(responses);
  await tick();
  assert.equal(withClass(canvas, "node-close").length, 0, "no node-close marks");
  assert.equal(withClass(canvas, "wire-x").length, 0, "no wire-x marks");
});

test("delete button is disabled without selection and enabled by it", async () => {
  const { canvas, doc, ids } = bootTopology(responses);
  await tick();
  const del = ids["topo-delete"];
  assert.ok(!del.hidden, "always visible");
  assert.ok(del.disabled, "disabled with empty selection");
  selectNode(doc, deviceRects(canvas)[0]);
  assert.ok(!del.disabled, "enabled while a node is selected");
  fire(canvas, "click", { clientX: 900, clientY: 700 });
  assert.ok(del.disabled, "disabled again after selection is cleared");
});

test("delete button removes the selected device after confirm", async () => {
  const { canvas, doc, ids, sandbox } = bootTopology(responses);
  sandbox.confirm = () => true;
  await tick();
  selectNode(doc, deviceRects(canvas)[0]);
  fire(ids["topo-delete"], "click", {});
  const names = texts(canvas);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
});

test("declining confirm keeps the selected device", async () => {
  const { canvas, doc, ids } = bootTopology(responses);
  await tick();
  selectNode(doc, deviceRects(canvas)[0]);
  fire(ids["topo-delete"], "click", {});
  assert.ok(texts(canvas).includes("r1 (router)"), "r1 kept when not confirmed");
});

test("every wire gets an invisible wide hit twin carrying the handlers", async () => {
  const { canvas } = bootTopology(responses);
  await tick();
  const hits = withClass(canvas, "wire-hit");
  assert.equal(hits.length, 2, "one hit twin per wire: link + attachment");
  hits.forEach((h) => assert.equal(typeof h.onclick, "function", "hit twin handles clicks"));
  // hit geometry mirrors the visible wire so the capture zone sits on top of it
  const wires = withClass(canvas, "wire");
  const paths = wires.filter((w) => w.tag === "path");
  const hitPaths = hits.filter((h) => h.tag === "path");
  assert.deepEqual(hitPaths.map((h) => h.attrs.d), paths.map((w) => w.attrs.d), "same path geometry");
  // visible wires stay decorative: no own click handler
  wires.forEach((w) => assert.equal(w.onclick, undefined, "visible wire is not clickable itself"));
});

test("filtered links render with wire-filtered class and exports tooltip", async () => {
  const topo = {
    devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
    links: [
      { a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["N1"], bExports: ["N2"] } },
    ],
    networks: [],
  };
  const { canvas } = bootTopology({ ...responses, "/api/topology": topo });
  await tick();
  const filtered = withClass(canvas, "wire-filtered");
  assert.equal(filtered.length, 1, "one filtered wire");
  const titles = [];
  (function walk(n) {
    if (n.tag === "title") titles.push(String(n.textContent));
    (n.children || []).forEach(walk);
  })(canvas);
  assert.ok(titles.some((t) => t.includes("N1") && t.includes("N2")), "tooltip lists exports");
});

test("clicking a wire selects the link and the trash removes it", async () => {
  const { canvas, ids, get } = bootTopology(responses);
  await tick();
  const wire = withClass(canvas, "wire-hit")[0];
  wire.onclick({ shiftKey: false, stopPropagation() {} });
  assert.ok(!ids["topo-delete"].disabled, "link selection enables the trash");
  fire(ids["topo-delete"], "click", {});
  assert.equal(get("State.topology.links.length"), 0, "link removed");
  assert.ok(texts(canvas).includes("r1 (router)"), "devices untouched");
});

test("clicking an attachment line selects it and the trash removes the attach", async () => {
  const { canvas, ids, get } = bootTopology(responses);
  await tick();
  const line = find(canvas, (n) => n.tag === "line" && String(n.attrs.class || "").includes("wire-hit"));
  line.onclick({ shiftKey: false, stopPropagation() {} });
  assert.ok(!ids["topo-delete"].disabled, "attach selection enables the trash");
  fire(ids["topo-delete"], "click", {});
  assert.equal(get("State.topology.networks[0].attach.length"), 0, "attachment removed");
});

// --- union frames ---

// объединение с пустыми списками членов рамки не получает
const unionsResponses = {
  ...responses,
  "/api/topology": {
    ...responses["/api/topology"],
    unions: [{ name: "office", devices: ["r1", "r2"], networks: ["net1"] }],
  },
};

test("union frames render as bounding boxes behind the graph", async () => {
  const { canvas } = bootTopology(unionsResponses);
  await tick();
  const frames = withClass(canvas, "union-frame");
  assert.equal(frames.length, 1, "one frame for the non-empty union");
  const f = frames[0];
  // дефолтная раскладка: r1 (40,40), r2 (240,40), net1 (40,300);
  // bbox 40..380 x 40..360 плюс отступ 30 с каждой стороны
  assert.equal(f.attrs.x, 10);
  assert.equal(f.attrs.y, 10);
  assert.equal(f.attrs.width, 400);
  assert.equal(f.attrs.height, 380);
  const labels = texts(canvas);
  assert.ok(labels.includes("office"), "union name rendered");
});

test("palette colors differ between unions and follow document order", async () => {
  const resp = JSON.parse(JSON.stringify(unionsResponses));
  resp["/api/topology"].unions = [
    { name: "a", devices: ["r1"] },
    { name: "b", devices: ["r2"] },
  ];
  const { canvas } = bootTopology(resp);
  await tick();
  const frames = withClass(canvas, "union-frame");
  assert.equal(frames.length, 2);
  assert.notEqual(frames[0].attrs.stroke, frames[1].attrs.stroke);
  assert.equal(frames[0].attrs["data-union"], "a");
});

test("frames sit behind wires and nodes", async () => {
  const { canvas } = bootTopology(unionsResponses);
  await tick();
  const vp = find(canvas, (n) => String(n.attrs.class || "").includes("viewport"));
  const kinds = vp.children.map((c) => String(c.attrs.class || ""));
  const firstFrame = kinds.findIndex((k) => k.includes("union-frame"));
  const firstWire = kinds.findIndex((k) => k.includes("wire"));
  assert.ok(firstFrame !== -1 && firstWire !== -1 && firstFrame < firstWire, "frame precedes wires in child order");
});

test("no union frames when topology has none", async () => {
  const { canvas } = bootTopology(responses);
  await tick();
  assert.equal(withClass(canvas, "union-frame").length, 0);
});

// --- union assignment via the context menu ---

test("context menu assigns a node to a union and removes it back", async () => {
  const { canvas, ids, get } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  const rect = deviceRects(canvas)[0]; // r1
  fire(rect, "contextmenu", { clientX: 60, clientY: 60 });
  const menu = ids["topo-context-menu"];
  const assign = find(menu, (b) => String(b._text || "").includes("office"));
  assert.ok(assign, "assign item listed in the union submenu");
  assign.onclick({ stopPropagation() {} });
  assert.equal(get("JSON.stringify(State.topology.unions[0].devices)"), '["r1"]', "member recorded");

  fire(deviceRects(canvas)[0], "contextmenu", { clientX: 60, clientY: 60 });
  const unassign = find(menu, (b) => String(b._text || "").includes("Убрать"));
  unassign.onclick({ stopPropagation() {} });
  assert.equal(get("JSON.stringify(State.topology.unions[0].devices)"), "[]", "membership cleared");
});

test("union submenu lists locations and shows a placeholder when none are available", async () => {
  const { canvas, ids } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], unions: [{ name: "office", devices: ["r1"] }] },
  });
  await tick();
  const rect = deviceRects(canvas)[0]; // r1
  fire(rect, "contextmenu", { clientX: 60, clientY: 60 });
  const sub = find(ids["topo-context-menu"], (n) => String(n.attrs.class || "").includes("submenu"));
  assert.ok(sub, "submenu rendered");
  const empty = find(sub, (b) => String(b._text || "").includes("нет доступных"));
  assert.ok(empty && empty.disabled, "placeholder shown and disabled when all unions hold the node");

  fire(deviceRects(canvas)[1], "contextmenu", { clientX: 60, clientY: 60 }); // r2
  const listed = find(
    find(ids["topo-context-menu"], (n) => String(n.attrs.class || "").includes("submenu")),
    (b) => String(b._text || "").includes("office"),
  );
  assert.ok(listed && !listed.disabled, "union listed for a node outside it");
});

test("context menu keeps union items above the danger delete item", async () => {
  const { canvas, ids } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  fire(deviceRects(canvas)[0], "contextmenu", { clientX: 60, clientY: 60 });
  const menu = ids["topo-context-menu"];
  const buttons = menu.children.map((c) => (c.tag === "div" ? c.children[0] : c));
  assert.ok(String(buttons[0]._text).includes("Добавить в объединение"), "union submenu first");
  assert.ok(!buttons[0].disabled, "submenu button is enabled");
  const del = buttons[buttons.length - 1];
  assert.ok(String(del._text).startsWith("Удалить"), "delete item last");
  assert.ok(String(del.attrs.class || "").includes("danger"), "delete styled as danger");
  assert.ok(!String(buttons[0].attrs.class || "").includes("danger"), "union item is not danger-colored");
});

test("deleting a node scrubs it from union membership", async () => {
  const { canvas, doc, sandbox } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], unions: [{ name: "office", devices: ["r1"] }] },
  });
  sandbox.confirm = () => true;
  await tick();
  selectNode(doc, deviceRects(canvas)[0]);
  fire(doc, "keydown", { key: "Delete" });
  assert.equal(vm.runInContext("JSON.stringify(State.topology.unions[0].devices)", sandbox), "[]", "r1 dropped from union");
});

test("network nodes get union assignment in the context menu too", async () => {
  const { canvas, ids, get } = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], unions: [{ name: "office" }] },
  });
  await tick();
  const cloud = withClass(canvas, "subnet-rect")[0];
  fire(cloud, "contextmenu", { clientX: 60, clientY: 60 });
  const assign = find(ids["topo-context-menu"], (b) => String(b._text || "").includes("office"));
  assert.ok(assign, "network can be assigned");
  assign.onclick({ stopPropagation() {} });
  assert.equal(get("JSON.stringify(State.topology.unions[0].networks)"), '["net1"]', "network member recorded");
});

