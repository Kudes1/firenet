"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM stub sufficient to boot topology.js outside a browser and
// exercise the canvas editor against a stubbed fetch. Canvas draws are
// synchronous: the sandbox has no requestAnimationFrame, so CanvasView and
// CameraControls fall back to running scheduled work immediately.
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

// fire dispatches a DOM event to listeners registered via addEventListener
function fire(target, type, ev) {
  ev.type = type;
  if (!ev.target) ev.target = target;
  ev.preventDefault ||= () => { ev.defaultPrevented = true; };
  ev.stopPropagation ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
  if (type === "click" && target.onclick) target.onclick(ev);
}

function bootTopology(responses) {
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
    // stable registry: production code resolves widgets by id repeatedly
    getElementById: (id) => (id === "topo-canvas" ? canvas : (ids[id] ||= makeEl("div"))),
    createElement: (tag) => makeEl(tag),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = doc.listeners[t];
      if (list) doc.listeners[t] = list.filter((f) => f !== fn);
    },
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
    Path2D: class {},               // стаб для kind:"glyph"
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    setTimeout,
    clearTimeout,
    Promise,
    console,
    // clone: production mutates loaded state, responses must stay pristine
    fetch: async (p) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of [
    "common.js", "camera.js", "camera_input.js", "netmap.js", "tween.js",
    "canvas_theme.js", "hit_test.js", "canvas_view.js", "topo_scene.js",
    "net_info.js", "topology.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  // top-level const bindings live in the context's lexical env; grab them
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { canvas, ctx, doc, ids, get, sandbox };
}

const texts = (get) => get("State.list.filter((i) => i.text).map((i) => i.text)");
const byId = (get, id) => get(`State.list.find((i) => i.id === ${JSON.stringify(id)})`);

// select tool: click a node (mousedown+mouseup without movement).
// Default layout puts r1 at (40,40), r2 at (240,40), net1 at (40,300);
// with camera z=1 node centers land on these screen points.
const AT = { r1: { x: 110, y: 70 }, r2: { x: 310, y: 70 }, net1: { x: 120, y: 302 } };

function clickNode(page, name, shift) {
  const p = AT[name];
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y, shiftKey: !!shift });
  fire(page.doc, "mouseup", { shiftKey: !!shift });
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
  const { get } = bootTopology(responses);
  await tick();
  const rendered = texts(get);
  assert.ok(rendered.includes("r1 (router)"), "device r1 rendered");
  assert.ok(rendered.includes("r2 (router)"), "device r2 rendered");
  assert.ok(rendered.includes("net1"), "network node rendered");
  assert.ok(rendered.includes("a"), "subnet names shown on network node");
  assert.ok(!rendered.includes("10.0.0.0/24"), "no cidr on network node");
  assert.ok(byId(get, "link:r1|r2"), "device link in the display list");
  assert.ok(byId(get, "attach:net1|r1"), "network attachment in the display list");
});

test("network subtitle summarizes long subnet lists with a +N tail", async () => {
  const topo = {
    devices: [],
    links: [],
    networks: [{ name: "net1", subnets: ["office", "guests-wifi", "dmz-servers", "vpn"] }],
  };
  const { get } = bootTopology({
    ...responses,
    "/api/topology": topo,
    "/api/subnets": { subnets: topo.networks[0].subnets.map((name) => ({ name, cidr: "10.0.0.0/24" })) },
  });
  await tick();
  const summary = texts(get).find((t) => t.includes("+"));
  assert.equal(summary, "office, guests-wifi +2");
});

test("device kinds get their distinct shape and glyph, unknown kinds fall back", async () => {
  const topo = {
    devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }, { name: "x1", kind: "future" }],
    links: [],
    networks: [],
  };
  const { get } = bootTopology({ ...responses, "/api/topology": topo });
  await tick();
  const radii = JSON.parse(get(
    `JSON.stringify(State.list.filter((i) => i.nodeType === "device").map((i) => [i.ref.name, i.geom.r]))`,
  ));
  assert.deepEqual(radii, [["r1", 16], ["sw1", 2], ["x1", 6]], "router rounded, switch sharp, fallback plain");
  const glyphs = JSON.parse(get(`JSON.stringify(State.list.filter((i) => i.kind === "glyph").map((i) => i.id))`));
  assert.deepEqual(glyphs, ["device:r1:glyph", "device:sw1:glyph"], "glyph only for kinds that have one");
});

test("network node renders as a closed cloud path inside its bbox", async () => {
  const { get } = bootTopology(responses);
  await tick();
  const net = byId(get, "network:net1");
  assert.ok(net, "one network shape");
  assert.equal(net.geom.closed, true, "cloud path is a closed outline");
  assert.ok(net.geom.segs.length > 8, "cloud is drawn from many bulge segments");
});

test("topology tolerates empty project", async () => {
  const { ids, get } = bootTopology({
    "/api/topology": { devices: [], links: [], networks: [] },
    "/api/subnets": { subnets: [] },
    "/api/layout": {},
  });
  await tick();
  assert.equal(get("State.list.length"), 0, "empty display list for empty project");
  assert.ok(ids["topo-delete"].disabled, "trash disabled without nodes");
});

test("camera from layout is applied to the canvas view", async () => {
  const { get } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  assert.deepEqual(JSON.parse(get("JSON.stringify(State.camera)")), { x: -100, y: -50, z: 2 });
});

test("wheel zooms around the cursor", async () => {
  const { canvas, get } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  const before = JSON.parse(get("JSON.stringify(State.camera)"));
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  const after = JSON.parse(get("JSON.stringify(State.camera)"));
  assert.ok(after.z > before.z, "zoom changed the camera");
  // the world point under the cursor stays under the cursor
  const worldAt = (cam) => ({ x: (300 - cam.x) / cam.z, y: (200 - cam.y) / cam.z });
  const w0 = worldAt(before);
  const w1 = worldAt(after);
  assert.ok(Math.abs(w1.x - w0.x) < 0.01 && Math.abs(w1.y - w0.y) < 0.01, "cursor-anchored zoom");
});

test("middle-button drag pans the camera", async () => {
  const { canvas, doc, get } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 1 } },
  });
  await tick();
  fire(canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  assert.deepEqual(JSON.parse(get("JSON.stringify(State.camera)")), { x: 60, y: 30, z: 1 });
});

test("node dragging accounts for camera zoom", async () => {
  const { canvas, doc, get } = bootTopology({
    ...responses,
    "/api/layout": {
      devices: { r1: { x: 100, y: 100 }, r2: { x: 400, y: 100 } },
      networks: { net1: { x: 250, y: 300 } },
      camera: { x: 0, y: 0, z: 2 },
    },
  });
  await tick();
  // r1 occupies (100,100)+(140x60); at zoom 2 its center is on screen (340,260)
  fire(canvas, "mousedown", { button: 0, clientX: 220, clientY: 220 });
  fire(doc, "mousemove", { clientX: 260, clientY: 260 });
  fire(doc, "mouseup", {});
  // 40 screen px at zoom 2 == 20 world px on both axes
  assert.deepEqual(
    JSON.parse(get(`JSON.stringify(State.layout.devices.r1)`)),
    { x: 120, y: 120 },
    "layout moved by the world delta",
  );
  assert.equal(byId(get, "device:r1").geom.x, 120, "display list rebuilt from the new layout");
});

test("toolbar switches the active tool", async () => {
  const { ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-connect"], "click", {});
  assert.equal(ids["tool-connect"].attrs.class, "tool active");
  assert.equal(ids["tool-select"].attrs.class, "tool");
});

test("device tool creates a device at the clicked world position", async () => {
  const { canvas, ids, get } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 2 } },
  });
  await tick();
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 600, clientY: 400 }); // world (300,200), free of nodes
  // naming popover is open
  const input = ids["node-name-input"];
  assert.ok(input, "name input shown");
  input.value = "r3";
  fire(ids["node-name-form"], "submit", {});
  const dev = byId(get, "device:r3");
  assert.ok(dev, "device created");
  // world position of the click: (300, 200); node is centred on the cursor
  assert.equal(dev.geom.x, 300 - 70, "device placed centred at the clicked world point");
  assert.equal(dev.geom.y, 200 - 30);
});

test("network tool creates a network node", async () => {
  const { canvas, ids, get } = bootTopology(responses);
  await tick();
  fire(ids["tool-network"], "click", {});
  fire(canvas, "click", { clientX: 500, clientY: 400 }); // free background spot
  ids["node-name-input"].value = "lan2";
  fire(ids["node-name-form"], "submit", {});
  assert.ok(byId(get, "network:lan2"), "network created");
  // облако центрировано на клике: позиция в layout, геометрия — из него
  const pos = JSON.parse(get(`JSON.stringify(State.layout.networks.lan2)`));
  assert.deepEqual(pos, { x: 500 - 80, y: 400 - 30 }, "cloud centred on the click");
});

test("connect tool links two devices with click-click", async () => {
  // start without the r1–r2 link so the connect tool can create it
  const page = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], links: [] },
  });
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  // node clicks are plain mousedown+mouseup without movement
  clickNode(page, "r1");
  clickNode(page, "r2");
  assert.ok(byId(page.get, "link:r1|r2"), "wire rendered for the new link");
});

test("click selects a node, background click clears selection", async () => {
  const page = bootTopology(responses);
  await tick();
  clickNode(page, "r1");
  assert.equal(page.get("State.selection.size"), 1, "one node selected");
  assert.equal(byId(page.get, "device:r1").style.stroke, "#2563eb", "selection paints the accent stroke");
  fire(page.canvas, "click", { clientX: 900, clientY: 700 });
  assert.equal(page.get("State.selection.size"), 0, "selection cleared");
});

test("clicking a network opens the subnet info window", async () => {
  const page = bootTopology(responses);
  await tick();
  clickNode(page, "net1");
  assert.ok(!page.ids["net-info"].hidden, "info window opened");
  const html = JSON.stringify(page.ids["net-info"]);
  assert.match(html, /net1/, "window titled with the network name");
  assert.match(html, /10\.0\.0\.0\/24/, "member CIDR listed");
  // selecting a device instead closes the window
  clickNode(page, "r1");
  assert.ok(page.ids["net-info"].hidden, "device selection hides the window");
  // background click closes it too
  clickNode(page, "net1");
  fire(page.canvas, "click", { clientX: 900, clientY: 700 });
  assert.ok(page.ids["net-info"].hidden, "background click hides the window");
});

// полный клик браузера по сети: down → up (окно открылось) → click; окно
// обязано пережить завершающий click, адресованный узлу, а не фону
function fullClick(page, name) {
  const p = AT[name];
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y });
  fire(page.doc, "mouseup", {});
  fire(page.canvas, "click", { clientX: p.x, clientY: p.y });
}

test("net info window survives the trailing click fired on its network", async () => {
  const page = bootTopology(responses);
  await tick();
  fullClick(page, "net1");
  assert.ok(!page.ids["net-info"].hidden, "info window stays open after the browser click");
});

test("full background click sequence closes the net info window", async () => {
  const page = bootTopology(responses);
  await tick();
  fullClick(page, "net1");
  assert.ok(!page.ids["net-info"].hidden, "window opened first");
  fire(page.canvas, "mousedown", { button: 0, clientX: 900, clientY: 700 });
  fire(page.doc, "mouseup", {});
  fire(page.canvas, "click", { clientX: 900, clientY: 700 });
  assert.ok(page.ids["net-info"].hidden, "background sequence hides the window");
});

test("marquee selects all intersecting nodes", async () => {
  const page = bootTopology(responses);
  await tick();
  fire(page.canvas, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(page.doc, "mousemove", { clientX: 600, clientY: 200 });
  fire(page.doc, "mouseup", { clientX: 600, clientY: 200 });
  assert.equal(page.get("State.selection.size"), 2, "both devices selected");
});

test("marquee selection survives the trailing click fired by the browser", async () => {
  const page = bootTopology(responses);
  await tick();
  fire(page.canvas, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(page.doc, "mousemove", { clientX: 600, clientY: 200 });
  fire(page.doc, "mouseup", { clientX: 600, clientY: 200 });
  // a real browser fires click on the canvas after the drag (same down/up target)
  fire(page.canvas, "click", { clientX: 600, clientY: 200 });
  assert.equal(page.get("State.selection.size"), 2, "selection kept after marquee");
});

test("Del removes selected devices", async () => {
  const page = bootTopology(responses);
  await tick();
  clickNode(page, "r1");
  fire(page.doc, "keydown", { key: "Delete" });
  const names = texts(page.get);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
});

test("connect tool shows a preview wire while connecting", async () => {
  const page = bootTopology(responses);
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "r1"); // pending = r1
  fire(page.canvas, "mousemove", { clientX: 500, clientY: 300 });
  // превью рисуется оверлеем канвы: пунктир [6,4] есть только у него
  assert.ok(
    page.ctx.calls.some((c) => c[0] === "setLineDash" && String(c[1][0]) === "6,4"),
    "dashed preview wire painted",
  );
});

test("context menu deletes a node", { skip: "задача 10: контекстное меню переезжает на HitTest.pick канвы" }, () => {});

test("clean right-click on a node opens its menu after release", { skip: "задача 10: контекстное меню на канве" }, () => {});

test("right-button drag does not open the node menu", { skip: "задача 10: контекстное меню на канве" }, () => {});

test("native context menu is suppressed on the canvas", async () => {
  const page = bootTopology(responses);
  await tick();
  // right-click anywhere (background or node): no native browser menu
  const ev = {};
  fire(page.canvas, "contextmenu", ev);
  assert.ok(ev.defaultPrevented, "canvas contextmenu prevented");
});

test("keyboard shortcuts switch tools", async () => {
  const { ids, doc } = bootTopology(responses);
  await tick();
  fire(doc, "keydown", { key: "c" });
  assert.equal(ids["tool-connect"].attrs.class, "tool active");
  fire(doc, "keydown", { key: "v" });
  assert.equal(ids["tool-select"].attrs.class, "tool active");
});

test("popover stays inside the canvas near the edges", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-device"], "click", {});
  // measured popover size (as offsetWidth/offsetHeight in a real browser)
  const pop = ids["node-popover"];
  pop.offsetWidth = 240;
  pop.offsetHeight = 48;
  fire(canvas, "click", { clientX: 1180, clientY: 780 });
  assert.equal(pop.style.left, "952px", "right edge pulled inside (1200-240-8)");
  assert.equal(pop.style.top, "744px", "bottom edge pulled inside (800-48-8)");
  // an interior click keeps the popover at the cursor
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  assert.equal(pop.style.left, "300px");
  assert.equal(pop.style.top, "200px");
});

test("popover clamp measures real size after unhide", async () => {
  const { canvas, ids } = bootTopology(responses);
  await tick();
  fire(ids["tool-device"], "click", {});
  const pop = ids["node-popover"];
  pop.hidden = true;
  // like a real browser: a hidden element measures 0; the device form
  // (input + select + OK) is wider than the old 240px fallback
  Object.defineProperty(pop, "offsetWidth", { get() { return this.hidden ? 0 : 300; } });
  Object.defineProperty(pop, "offsetHeight", { get() { return this.hidden ? 0 : 60; } });
  fire(canvas, "click", { clientX: 1180, clientY: 780 });
  assert.equal(pop.style.left, "892px", "right edge pulled inside (1200-300-8)");
  assert.equal(pop.style.top, "732px", "bottom edge pulled inside (800-60-8)");
});

test("popover follows camera panning like the scene", async () => {
  const { canvas, doc, ids } = bootTopology({
    ...responses,
    "/api/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 1 } },
  });
  await tick();
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  const pop = ids["node-popover"];
  assert.equal(pop.style.left, "300px");
  assert.equal(pop.style.top, "200px");
  fire(canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  assert.equal(pop.style.left, "360px", "popover shifted with the pan (+60)");
  assert.equal(pop.style.top, "230px", "popover shifted with the pan (+30)");
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

// --- delete button (trash) ---

test("delete button is disabled without selection and enabled by it", async () => {
  const page = bootTopology(responses);
  await tick();
  const del = page.ids["topo-delete"];
  assert.ok(!del.hidden, "always visible");
  assert.ok(del.disabled, "disabled with empty selection");
  clickNode(page, "r1");
  assert.ok(!del.disabled, "enabled while a node is selected");
  fire(page.canvas, "click", { clientX: 900, clientY: 700 });
  assert.ok(del.disabled, "disabled again after selection is cleared");
});

test("delete button removes the selected device after confirm", async () => {
  const page = bootTopology(responses);
  page.sandbox.confirm = () => true;
  await tick();
  clickNode(page, "r1");
  fire(page.ids["topo-delete"], "click", {});
  const names = texts(page.get);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
});

test("declining confirm keeps the selected device", async () => {
  const page = bootTopology(responses);
  await tick();
  clickNode(page, "r1");
  fire(page.ids["topo-delete"], "click", {});
  assert.ok(texts(page.get).includes("r1 (router)"), "r1 kept when not confirmed");
});

// wires carry pickable geometry instead of invisible hit twins

test("wires and attachments are pickable along their path", async () => {
  const { get } = bootTopology(responses);
  await tick();
  const midLink = get(`(() => {
    const s = State.list.find((i) => i.id === "link:r1|r2").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })()`);
  assert.equal(HitTestId(get, midLink), "link:r1|r2", "link picked along the wire");
  const midAttach = get(`(() => {
    const s = State.list.find((i) => i.id === "attach:net1|r1").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })()`);
  assert.equal(HitTestId(get, midAttach), "attach:net1|r1", "attachment picked along the line");
});

function HitTestId(get, p) {
  return get(`HitTest.pick(State.list, ${JSON.stringify(p)}, 1)?.id ?? null`);
}

// mousedown on a wire selects the link; the trash then removes it
test("clicking a wire selects the link and the trash removes it", async () => {
  const page = bootTopology(responses);
  await tick();
  const p = page.get(`(() => {
    const s = State.list.find((i) => i.id === "link:r1|r2").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })()`);
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y });
  fire(page.doc, "mouseup", {});
  assert.ok(!page.ids["topo-delete"].disabled, "link selection enables the trash");
  fire(page.ids["topo-delete"], "click", {});
  assert.equal(page.get("State.topology.links.length"), 0, "link removed");
  assert.ok(texts(page.get).includes("r1 (router)"), "devices untouched");
});

test("clicking an attachment line selects it and the trash removes the attach", async () => {
  const page = bootTopology(responses);
  await tick();
  const p = page.get(`(() => {
    const s = State.list.find((i) => i.id === "attach:net1|r1").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })()`);
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y });
  fire(page.doc, "mouseup", {});
  assert.ok(!page.ids["topo-delete"].disabled, "attach selection enables the trash");
  fire(page.ids["topo-delete"], "click", {});
  assert.equal(page.get("State.topology.networks[0].attach.length"), 0, "attachment removed");
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
  const { get } = bootTopology(unionsResponses);
  await tick();
  const frame = byId(get, "union:office");
  assert.ok(frame, "one frame for the non-empty union");
  // дефолтная раскладка: r1 (40,40), r2 (240,40), net1 (40,300);
  // bbox 40..380 x 40..360 плюс отступ 30 с каждой стороны
  assert.deepEqual(
    JSON.parse(get(`JSON.stringify(State.list.find((i) => i.id === "union:office").geom)`)),
    { x: 10, y: 10, w: 400, h: 380, r: 14 },
  );
  assert.ok(texts(get).includes("office"), "union name rendered");
});

test("palette colors differ between unions and follow document order", async () => {
  const resp = JSON.parse(JSON.stringify(unionsResponses));
  resp["/api/topology"].unions = [
    { name: "a", devices: ["r1"] },
    { name: "b", devices: ["r2"] },
  ];
  const { get } = bootTopology(resp);
  await tick();
  const frames = JSON.parse(get(
    `JSON.stringify(State.list.filter((i) => i.id.startsWith("union:") && !i.id.includes(":label")).map((i) => [i.ref.name, i.style.stroke]))`,
  ));
  assert.deepEqual(frames.map(([n]) => n), ["a", "b"], "document order");
  assert.notEqual(frames[0][1], frames[1][1], "palette colors differ");
});

test("frames sit behind wires and nodes", async () => {
  const { get } = bootTopology(unionsResponses);
  await tick();
  const order = get(`State.list.map((i) => i.id)`);
  assert.ok(order.indexOf("union:office") < order.indexOf("link:r1|r2"), "frame precedes wires in paint order");
});

test("no union frames when topology has none", async () => {
  const { get } = bootTopology(responses);
  await tick();
  assert.equal(get(`State.list.filter((i) => i.id.startsWith("union:")).length`), 0);
});

// --- union assignment via the context menu (returns in task 10) ---

test("context menu assigns a node to a union and removes it back", { skip: "задача 10: меню объединений на канве" }, () => {});

test("union submenu lists locations and shows a placeholder when none are available", { skip: "задача 10: меню объединений на канве" }, () => {});

test("context menu keeps union items above the danger delete item", { skip: "задача 10: меню объединений на канве" }, () => {});

test("network nodes get union assignment in the context menu too", { skip: "задача 10: меню объединений на канве" }, () => {});

test("deleting a node scrubs it from union membership", async () => {
  const page = bootTopology({
    ...responses,
    "/api/topology": { ...responses["/api/topology"], unions: [{ name: "office", devices: ["r1"] }] },
  });
  await tick();
  clickNode(page, "r1");
  fire(page.doc, "keydown", { key: "Delete" });
  assert.equal(vm.runInContext("JSON.stringify(State.topology.unions[0].devices)", page.sandbox), "[]", "r1 dropped from union");
});
