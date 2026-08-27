"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM stub sufficient to boot diagnose.js outside a browser and
// exercise the report rendering against a stubbed fetch.
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    dataset: {},
    _classes: new Set(),
    style: {
      setProperty(k, v) { this[k] = v; },
      getPropertyValue(k) { return this[k] ?? null; },
    },
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
    toggle: (c, force) => {
      const on = force === undefined ? !el._classes.has(c) : force;
      el._classes[on ? "add" : "delete"](c);
      return on;
    },
  };
  Object.defineProperty(el, "className", {
    get: () => [...el._classes].join(" "),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    enumerable: true,
  });
  return el;
}

// fire dispatches a DOM event to listeners registered via addEventListener
// or assigned as onclick
function fire(target, type, ev) {
  ev.type = type;
  if (!ev.target) ev.target = target;
  ev.preventDefault ||= () => {};
  ev.stopPropagation ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
  if (type === "click" && target.onclick) target.onclick(ev);
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

const topoFixture = {
  devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
  links: [{ a: { device: "r1" }, b: { device: "r2" } }],
  networks: [{ name: "office", subnets: ["a"], attach: [{ device: "r1" }] }],
};

function bootDiagnose(responses, savedStore, draftID = "d1") {
  const draftStore = draftID ? { "firenet-draft-id": draftID } : {};
  const ctx = makeCtx();
  const canvas = Object.assign(makeEl("canvas"), {
    clientWidth: 1200,
    clientHeight: 800,
    getContext: () => ctx,
  });
  const minimap = Object.assign(makeEl("canvas"), { clientWidth: 200, clientHeight: 120, getContext: () => makeCtx() });
  const ids = {};
  const calls = [];
  const store = { ...savedStore };
  const doc = {
    readyState: "loading",
    listeners: {},
    body: makeEl("body"),
    documentElement: { dataset: {} },
    createElement: (tag) => makeEl(tag),
    // stable registry: production code resolves widgets by id repeatedly
    getElementById: (id) => (id === "diag-canvas" ? canvas : id === "diag-minimap" ? minimap : (ids[id] ||= makeEl("div"))),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = doc.listeners[t];
      if (list) doc.listeners[t] = list.filter((f) => f !== fn);
    },
  };
  // управляемые кадры: rAF-очередь + фейковые часы для твинов; кадр исполняет
  // только колбэки, поставленные в очередь до него
  let clock = 0;
  const rafQueue = [];
  const sandbox = {
    document: doc,
    window: {
      addEventListener(t, fn) { (doc.listeners["win-" + t] ||= []).push(fn); },
      dispatchEvent() {},
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: {
      getItem: (k) => (k in draftStore ? draftStore[k] : null),
      setItem: (k, v) => { draftStore[k] = v; },
      removeItem: (k) => { delete draftStore[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent() {},
    confirm: () => false,
    FormData: class { get() { return ""; } },
    Path2D: class {},               // стаб для kind:"glyph"
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    setTimeout,
    clearTimeout,
    Promise,
    console,
    // clone: production mutates loaded state, responses must stay pristine.
    // responses[p] may be a function(body) for endpoints hit with varying
    // payloads (e.g. one /api/diagnose call per spread candidate).
    fetch: async (p, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      calls.push({ path: p, method: opts?.method, body });
      const raw = typeof responses[p] === "function" ? responses[p](body) : responses[p];
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(raw ?? null)) };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of [
    "common.js", "camera.js", "minimap.js", "camera_input.js", "netmap.js", "tween.js",
    "canvas_theme.js", "hit_test.js", "canvas_view.js", "topo_scene.js",
    "net_info.js", "diagnose.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  const frame = () => {
    clock += 50;
    rafQueue.splice(0).forEach((fn) => fn(clock));
  };
  const frames = async (n) => {
    for (let i = 0; i < n; i++) frame();
  };
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { canvas, ctx, minimap, ids, calls, get, sandbox, doc, store, frame, frames };
}

const responses = {
  "/api/drafts/d1/topology": topoFixture,
  "/api/drafts/d1/subnets": { subnets: [{ name: "a", cidr: "10.0.0.0/24" }] },
  "/api/drafts/d1/layout": {},
};

const sampleReport = {
  srcSubnet: "office",
  dstSubnet: "dmz",
  note: "stateless",
  paths: [
    {
      nodes: [
        { kind: 1, name: "office" }, { kind: 0, name: "r1" }, { kind: 0, name: "r2" }, { kind: 1, name: "dmz" },
      ],
      routers: [
        {
          router: "r1", action: "allow", matchedRule: "office-to-dmz", reason: "правило разрешило",
          steps: ["прыжок в цепочку FWD-TO-DMZ", "сработало правило \"office-to-dmz\""],
        },
        { router: "r2", action: "allow", matchedRule: "office-to-dmz", reason: "правило разрешило" },
      ],
      verdict: "allow",
    },
  ],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// — карта: display list, камера, взаимодействие —

test("boot builds the canvas display list and draws a frame", async () => {
  const { ctx, frames, get } = bootDiagnose(responses);
  await tick();
  await frames(1);
  const ids = get("Diagnose.state.list.map((i) => i.id)");
  for (const id of ["device:r1", "device:r2", "network:office", "network:office:label", "attach:office|r1", "link:r1|r2"]) {
    assert.ok(ids.includes(id), `${id} in the display list`);
  }
  assert.ok(ctx.calls.some((c) => c[0] === "setTransform"), "frame drawn through the camera transform");
});

test("diagnostics normalizes empty topology collections from the API", async () => {
  const { get } = bootDiagnose({
    ...responses,
    "/api/drafts/d1/topology": { devices: null, links: null, networks: null, sets: null, unions: null },
    "/api/drafts/d1/subnets": { subnets: null },
  });
  await tick();
  assert.deepEqual(JSON.parse(get("JSON.stringify(Diagnose.state.topology)")), {
    devices: [], links: [], networks: [], sets: [], unions: [],
  });
  assert.equal(get("Diagnose.state.list.length"), 0, "empty topology renders an empty map");
});

test("wheel zooms around the cursor", async () => {
  const { canvas, frames, get } = bootDiagnose({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  await frames(1);
  const before = JSON.parse(get("JSON.stringify(Diagnose.state.camera)"));
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  await frames(1);
  const after = JSON.parse(get("JSON.stringify(Diagnose.state.camera)"));
  assert.ok(after.z > before.z, "zoom changed the camera");
  // the world point under the cursor stays under the cursor
  const worldAt = (cam) => ({ x: (300 - cam.x) / cam.z, y: (200 - cam.y) / cam.z });
  const w0 = worldAt(before);
  const w1 = worldAt(after);
  assert.ok(Math.abs(w1.x - w0.x) < 0.01 && Math.abs(w1.y - w0.y) < 0.01, "cursor-anchored zoom");
});

// same pan buttons as the topology editor: middle + right, left stays free
test("middle- and right-button drags pan the read-only map", async () => {
  const { canvas, doc, frames, get } = bootDiagnose(responses);
  await tick();
  await frames(1);
  fire(canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  await frames(1);
  fire(doc, "mouseup", {});
  assert.deepEqual(JSON.parse(get("JSON.stringify(Diagnose.state.camera)")), { x: 60, y: 30, z: 1 });
  fire(canvas, "mousedown", { button: 2, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 40, clientY: 80 });
  await frames(1);
  fire(doc, "mouseup", { button: 2 });
  assert.deepEqual(JSON.parse(get("JSON.stringify(Diagnose.state.camera)")), { x: 0, y: 10, z: 1 });
});

test("left button stays free: dragging it does not pan the map", async () => {
  const { canvas, doc, frames, get } = bootDiagnose(responses);
  await tick();
  await frames(1);
  fire(canvas, "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  await frames(1);
  fire(doc, "mouseup", {});
  assert.deepEqual(JSON.parse(get("JSON.stringify(Diagnose.state.camera)")), { x: 0, y: 0, z: 1 });
});

test("right-click on the canvas suppresses the native menu", async () => {
  const { canvas } = bootDiagnose(responses);
  await tick();
  let prevented = false;
  fire(canvas, "contextmenu", { button: 2, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "contextmenu is prevented on the sim canvas");
});

test("camera changes are not persisted to /api/layout", async () => {
  const { canvas, doc, calls, frames } = bootDiagnose(responses);
  await tick();
  await frames(1);
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  fire(canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  await frames(1);
  fire(doc, "mouseup", {});
  assert.ok(!calls.some((c) => c.path === "/api/drafts/d1/layout" && c.method === "PUT"), "read-only page never writes layout");
});

test("map shows subnet names, network labels and union frames", async () => {
  const { frames, get } = bootDiagnose({
    ...responses,
    "/api/drafts/d1/topology": {
      devices: topoFixture.devices,
      links: topoFixture.links,
      networks: topoFixture.networks,
      unions: [{ name: "hq", devices: ["r1"], networks: ["office"] }],
    },
  });
  await tick();
  await frames(1);
  const byId = JSON.parse(get(
    "JSON.stringify(Object.fromEntries(Diagnose.state.list.map((i) => [i.id, i])))",
  ));
  assert.ok(byId["union:hq"], "union frame in the display list");
  assert.equal(byId["union:hq:label"].text, "hq");
  assert.equal(byId["network:office:label"].text, "office", "network label rendered");
  const texts = get("Diagnose.state.list.filter((i) => i.text).map((i) => i.text).join('|')");
  assert.doesNotMatch(texts, /10\.0\.0\.0\/24/, "subnet names, not CIDRs");
  assert.match(texts, /r1 \(router\)/, "device label rendered");
});

test("clicking a network on the read-only map shows its subnets", async () => {
  const { canvas, ids, frames } = bootDiagnose(responses);
  await tick();
  await frames(1);
  const info = (ids["net-info"] ||= makeEl("div"));
  info.hidden = true;
  // облако office в дефолтной раскладке занимает (40,300)+(160x60); точка
  // у верхней кромки — в пределах допуска обводки, мимо линий привязки
  fire(canvas, "click", { clientX: 50, clientY: 305 });
  assert.ok(!info.hidden, "network click opens the info window");
  const html = JSON.stringify(info);
  assert.match(html, /office/, "window titled with the network name");
  assert.match(html, /10\.0\.0\.0\/24/, "member CIDR listed");
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  assert.ok(info.hidden, "zooming hides the window");
});

// mousemove приходит чаще кадров дисплея: всплеск движений обязан дать одну
// перерисовку (камера применяется одним setCam на кадр внутри CameraControls)
test("rapid pan moves coalesce into one redraw per frame", async () => {
  const { canvas, doc, ctx, frames } = bootDiagnose(responses);
  await tick();
  await frames(1);
  const draws = () => ctx.calls.filter((c) => c[0] === "clearRect").length;
  const n0 = draws();
  fire(canvas, "mousedown", { button: 2, clientX: 100, clientY: 100 });
  for (let i = 1; i <= 10; i++) fire(doc, "mousemove", { clientX: 100 + i * 10, clientY: 100 });
  assert.equal(draws(), n0, "moves wait for the frame");
  await frames(2); // кадр камеры + запрошенная им перерисовка
  assert.equal(draws(), n0 + 1, "exactly one redraw for the whole burst");
  fire(doc, "mouseup", {});
});

// — кнопка «вписать карту» —

test("fit button flies the camera to frame the whole map", async () => {
  const { ids, frames, get } = bootDiagnose(responses);
  await tick();
  await frames(1);
  fire(ids["diag-fit"], "click", {});
  await frames(10); // 10×50мс покрывают анимацию целиком
  const expected = JSON.parse(get(
    "JSON.stringify(Camera.fitView(Camera.create(), TopoScene.bounds(Diagnose.state.topology, Diagnose.state.layout), 1200, 800, 60))",
  ));
  const cam = JSON.parse(get("JSON.stringify(Diagnose.state.camera)"));
  for (const k of ["x", "y", "z"]) {
    assert.ok(Math.abs(cam[k] - expected[k]) < 1e-9, `camera.${k} settled on fitView (${cam[k]} ≈ ${expected[k]})`);
  }
});

// — отчёт диагностики (DOM) —

test("renderReport builds one card per path with verdict badges", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(sampleReport)})`);
  const cards = ids["diag-paths"].children.filter((c) => c.className === "diag-path");
  assert.equal(cards.length, 1);
  const html = JSON.stringify(ids["diag-paths"]);
  assert.match(html, /badge-ok/);
  assert.match(html, /office-to-dmz/);
});

test("return verdict renders a neutral badge with FORWARD wording", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  const rep = JSON.parse(JSON.stringify(sampleReport));
  rep.paths[0].verdict = "return";
  rep.paths[0].routers[0].action = "return";
  rep.paths[0].routers[0].matchedRule = "bypass";
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const html = JSON.stringify(ids["diag-paths"]);
  assert.match(html, /badge-return/);
  assert.match(html, /возврат в FORWARD/);
});

test("unreachable report renders explicit message", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify({ srcSubnet: "office", dstSubnet: "isolated", note: "", paths: [] })})`);
  assert.match(JSON.stringify(ids["diag-paths"]), /недостижим/i);
  assert.doesNotMatch(String(ids["diag-summary"]._text || ""), /\. $/);
});

test("summary line reports source, destination and path count", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(sampleReport)})`);
  assert.ok(!ids["diag-summary"].hidden);
  assert.match(String(ids["diag-summary"]._text || ""), /office.*dmz.*путей 1/s);
});

// Topology where networks reach routers only through switches — the report
// path then contains synthetic l2 bus nodes instead of device names.
const switchedTopo = {
  devices: [
    { name: "r1", kind: "router" }, { name: "r2", kind: "router" },
    { name: "sw1", kind: "switch" }, { name: "sw2", kind: "switch" },
    { name: "lone", kind: "switch" },
  ],
  links: [
    { a: { device: "sw1" }, b: { device: "r1" } },
    { a: { device: "r1" }, b: { device: "r2" } },
    { a: { device: "r2" }, b: { device: "sw2" } },
    { a: { device: "lone" }, b: { device: "r1" } },
  ],
  networks: [
    { name: "MAIN", subnets: ["main"], attach: [{ device: "sw1" }] },
    { name: "OFFICE", subnets: ["office-net"], attach: [{ device: "sw2" }] },
  ],
};

const switchedReport = {
  srcSubnet: "main",
  dstSubnet: "office-net",
  note: "",
  paths: [{
    nodes: [
      { kind: 1, name: "main" }, { kind: 2, name: "l2-0" }, { kind: 0, name: "r1" },
      { kind: 0, name: "r2" }, { kind: 2, name: "l2-1" }, { kind: 1, name: "office-net" },
    ],
    routers: [],
    verdict: "allow",
  }],
};

test("highlight covers the full path: networks, switches, links and attaches", async () => {
  const { get, frames } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(switchedReport)})`);
  await frames(10);
  const hl = get("Diagnose.expandHighlight(Diagnose.state.result, Diagnose.state.topology)");
  for (const name of ["MAIN", "OFFICE", "sw1", "sw2", "r1", "r2"]) {
    assert.ok(hl.has(name), `${name} belongs to the highlighted path`);
  }
  assert.ok(!hl.has("lone"), "devices off the path stay unhighlighted");
  // канва: приглушены только одиночный свитч, его подписи и его связь
  const dimmed = JSON.parse(get(
    "JSON.stringify(Diagnose.state.list.filter((i) => (i.style.alpha ?? 1) < 1).map((i) => i.id).sort())",
  ));
  assert.deepEqual(dimmed, ["device:lone", "device:lone:glyph", "device:lone:label", "link:lone|r1"]);
});

// Сеть и роутер с одинаковым именем: якоря подсети и роутера совпадают как
// строки, но физическая цепочка «сеть ↔ свитч ↔ роутер» всё равно должна
// попасть в подсветку.
const collidingTopo = {
  devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }],
  links: [{ a: { device: "sw1" }, b: { device: "r1" } }],
  networks: [{ name: "r1", subnets: ["main"], attach: [{ device: "sw1" }] }],
};

const collidingReport = {
  srcSubnet: "main",
  dstSubnet: "main",
  note: "",
  paths: [{
    nodes: [
      { kind: 1, name: "main" }, { kind: 2, name: "sw1" }, { kind: 0, name: "r1" },
    ],
    routers: [],
    verdict: "allow",
  }],
};

test("a network and a router sharing one name still light the switch between them", async () => {
  const { get, frames } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": collidingTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(collidingReport)})`);
  await frames(10);
  const hl = get("Diagnose.expandHighlight(Diagnose.state.result, Diagnose.state.topology)");
  for (const name of ["r1", "sw1"]) {
    assert.ok(hl.has(name), `${name} belongs to the highlighted path`);
  }
  const f = get("Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology)");
  assert.ok(f.ok.has("sw1"), "switch on an allowed route is green");
});

test("form submit posts to /api/diagnose and renders the report", async () => {
  const { ids, calls } = bootDiagnose({ ...responses, "/api/drafts/d1/diagnose": sampleReport });
  await tick();
  // form inputs are resolved by id at submit time; seed the registry
  for (const id of ["diag-src", "diag-dst", "diag-proto", "diag-dstports"]) ids[id] ||= makeEl("input");
  ids["diag-src"].value = "10.0.0.5";
  ids["diag-dst"].value = "10.0.1.7";
  ids["diag-proto"].value = "tcp";
  ids["diag-dstports"].value = "443, 8080";
  fire(ids["diag-form"], "submit", {});
  await tick();
  const post = calls.find((c) => c.path === "/api/drafts/d1/diagnose");
  assert.ok(post && post.method === "POST");
  assert.deepEqual(post.body, { src: "10.0.0.5", dst: "10.0.1.7", proto: "tcp", dstPorts: ["443", "8080"] });
  const cards = ids["diag-paths"].children.filter((c) => c.className === "diag-path");
  assert.equal(cards.length, 1, "report rendered after submit");
});

test("router verdict renders each rule-walk step as a numbered list item", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(sampleReport)})`);
  const lists = (function collect(n) {
    const out = String(n.className || "").split(/\s+/).includes("diag-steps") ? [n] : [];
    (n.children || []).forEach((c) => out.push(...collect(c)));
    return out;
  })(ids["diag-paths"]);
  assert.equal(lists.length, 1, "only the verdict with steps becomes a list");
  const items = (lists[0].children || []).filter((c) => c.tag === "li");
  assert.equal(items.length, 2);
  assert.match(String(items[0]._text), /прыжок в цепочку/);
  assert.match(String(items[1]._text), /office-to-dmz/);
});

test("verdict without steps falls back to the plain reason text", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(sampleReport)})`);
  const paras = ids["diag-paths"].children
    .flatMap((c) => c.children)
    .filter((c) => c.tag === "details")
    .flatMap((d) => d.children)
    .filter((c) => c.tag === "p");
  assert.ok(paras.some((p) => String(p._text).includes("правило разрешило")),
    "reason paragraph kept for legacy reports without steps");
});

test("verdict rows look expandable: button-like summary with chevron", async () => {
  const { ids, get } = bootDiagnose(responses);
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(sampleReport)})`);
  const details = ids["diag-paths"].children
    .flatMap((c) => c.children)
    .filter((c) => c.tag === "details");
  assert.ok(details.length >= 2, "both router verdicts rendered");
  for (const d of details) {
    assert.match(String(d.className || ""), /diag-verdict/, "verdict row is marked as expandable");
    const sum = (d.children || []).find((c) => c.tag === "summary");
    assert.ok(sum, "summary present");
    assert.ok((sum.children || []).some((ch) => String(ch.className || "").includes("diag-chevron")),
      "summary carries a disclosure chevron");
  }
});

// — разметка движения трафика (expandFlow + mark на карте) —

const denyReport = {
  srcSubnet: "main",
  dstSubnet: "office-net",
  note: "",
  paths: [{
    nodes: [
      { kind: 1, name: "main" }, { kind: 2, name: "l2-0" }, { kind: 0, name: "r1" },
      { kind: 0, name: "r2" }, { kind: 2, name: "l2-1" }, { kind: 1, name: "office-net" },
    ],
    routers: [
      { router: "r1", action: "allow", matchedRule: "fwd-main", reason: "правило разрешило" },
      { router: "r2", action: "deny", matchedRule: "block-office", reason: "правило запретило" },
    ],
    verdict: "deny",
  }],
};

test("expandFlow colors the route green up to the denying router", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(denyReport)})`);
  const f = get("Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology)");
  for (const name of ["MAIN", "sw1", "r1"]) assert.ok(f.ok.has(name), `${name} is before the deny point`);
  assert.ok(!f.ok.has("r2"), "denying router itself is not green");
  assert.ok(!f.ok.has("OFFICE"), "destination beyond deny stays unlit");
  assert.deepEqual([...f.deny.keys()], ["r2"]);
  assert.equal(f.deny.get("r2").rule, "block-office");
});

test("allowed path lights the whole route including destination", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(switchedReport)})`);
  const f = get("Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology)");
  for (const name of ["MAIN", "sw1", "r1", "r2", "sw2", "OFFICE"]) {
    assert.ok(f.ok.has(name), `${name} is on an allowed route`);
  }
  assert.equal(f.deny.size, 0);
});

test("a denying router never turns green, even via another allowed path", async () => {
  const rep = JSON.parse(JSON.stringify(denyReport));
  rep.paths.push(JSON.parse(JSON.stringify(switchedReport.paths[0])));
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const f = get("Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology)");
  assert.ok(f.deny.has("r2"), "deny verdict wins on the shared route");
  assert.ok(!f.ok.has("r2") && !f.ok.has("OFFICE"), "denied elements are not green");
});

// The drop happens ON the denying router, so the hop leading into it has
// been fully traversed and stays green; only segments past it turn red.
test("hop into the denying router stays green, segments beyond it turn red", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  get(`Diagnose.renderReport(${JSON.stringify(denyReport)})`);
  const mark = get("Diagnose.flowMark(Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology))");
  assert.equal(mark({ a: { device: "sw1" }, b: { device: "r1" } }), "diag-flow-ok", "wire before the deny point");
  assert.equal(mark({ a: { device: "r1" }, b: { device: "r2" } }), "diag-flow-ok", "wire into the deny router is traversed");
  assert.equal(mark({ type: "attach", net: { name: "MAIN" }, device: "sw1" }), "diag-flow-ok", "attach before the deny point");
  assert.equal(mark({ a: { device: "r2" }, b: { device: "sw2" } }), "diag-flow-deny", "wire beyond the deny point");
  assert.equal(mark({ type: "attach", net: { name: "OFFICE" }, device: "sw2" }), "diag-flow-deny", "attach beyond the deny point");
});

// — половинная доступность (returnPathAllowed: false) —

test("expandFlow marks the allowed route half-open when there is no return path", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  const rep = { ...switchedReport, returnPathAllowed: false };
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const f = get("Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology)");
  for (const name of ["MAIN", "sw1", "r1", "r2", "sw2", "OFFICE"]) {
    assert.ok(f.half.has(name), `${name} is marked half-open without a return path`);
  }
  assert.equal(f.ok.size, 0, "a one-way report leaves ok empty — mergeFlows relies on this to know when to promote");
  assert.equal(f.okE.size, 0);
});

test("expandFlow leaves half empty when a return path exists", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  const rep = { ...switchedReport, returnPathAllowed: true };
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const f = get("Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology)");
  assert.equal(f.half.size, 0);
  assert.equal(f.halfE.size, 0);
});

test("flowMark paints allowed segments yellow when there is no return path", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  const rep = { ...switchedReport, returnPathAllowed: false };
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const mark = get("Diagnose.flowMark(Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology))");
  assert.equal(mark({ a: { device: "r1" }, b: { device: "r2" } }), "diag-flow-half", "no return path colors the wire yellow, not green");
  assert.equal(mark({ type: "attach", net: { name: "MAIN" }, device: "sw1" }), "diag-flow-half");
});

test("flowMark keeps deny red even without a return path", async () => {
  const { get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  const rep = { ...denyReport, returnPathAllowed: false };
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const mark = get("Diagnose.flowMark(Diagnose.expandFlow(Diagnose.state.result, Diagnose.state.topology))");
  assert.equal(mark({ a: { device: "r2" }, b: { device: "sw2" } }), "diag-flow-deny", "deny still wins over half");
  assert.equal(mark({ a: { device: "r1" }, b: { device: "r2" } }), "diag-flow-half", "allowed hop turns yellow without a return path");
});

test("renderReport notes the missing return path", async () => {
  const { ids, get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  const rep = { ...switchedReport, returnPathAllowed: false };
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  const html = JSON.stringify(ids["diag-paths"]);
  assert.match(html, /обратн/i);
  assert.match(html, /office-net.*main|main.*office-net/is);
});

test("renderReport says nothing about return paths when one exists", async () => {
  const { ids, get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  const rep = { ...switchedReport, returnPathAllowed: true };
  get(`Diagnose.renderReport(${JSON.stringify(rep)})`);
  assert.doesNotMatch(JSON.stringify(ids["diag-paths"]), /обратн/i);
});

// переход потока анимируется через flowFade: старт прозрачный, финал — полный
test("report flow fades in over animated frames", async () => {
  const { get, frames } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(switchedReport)})`);
  assert.ok(get("Diagnose.state.flowFade") < 1, "transition starts transparent");
  await frames(10);
  assert.equal(get("Diagnose.state.flowFade"), 1, "transition completes");
});

test("map paints flow segments and marks the deny point with a tooltip", async () => {
  const { get, frames } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(denyReport)})`);
  await frames(10); // дождались полного прогрева потока (flowFade = 1)
  const theme = JSON.parse(get("JSON.stringify(CanvasTheme.create({}))"));
  const byStroke = (color) => JSON.parse(get(
    `JSON.stringify(Diagnose.state.list.filter((i) => /^(link:|attach:)/.test(i.id) && i.style.stroke === ${JSON.stringify(color)}).map((i) => i.id).sort())`,
  ));
  assert.ok(get("Diagnose.state.list.every((i) => !('wire' in (i.style || {})))"),
    "the internal wire flag never leaks into public styles");
  assert.deepEqual(byStroke(theme.flowOk), ["attach:MAIN|sw1", "link:r1|r2", "link:r1|sw1"],
    "wires and attaches up to the deny point are green");
  assert.deepEqual(byStroke(theme.flowDeny), ["attach:OFFICE|sw2", "link:r2|sw2"],
    "segments beyond the deny point are red");
  const denied = JSON.parse(get(`JSON.stringify(Diagnose.state.list.find((i) => i.id === "device:r2"))`));
  assert.equal(denied.style.stroke, theme.flowDeny, "deny device outlined red");
  assert.match(denied.meta.tooltip, /block-office/, "deny tooltip names the rule");
  assert.match(denied.meta.tooltip, /правило запретило/, "deny tooltip carries the reason");
});

test("hovering the denying router shows a delayed tooltip", async () => {
  const { canvas, ids, frames, get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(denyReport)})`);
  await frames(10);
  const tip = ids["diag-tooltip"];
  // r2 в дефолтной раскладке — второе устройство, (240,40)+(140x60)
  fire(canvas, "mousemove", { clientX: 250, clientY: 50 });
  assert.ok(tip.hidden, "tooltip waits out the delay");
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(!tip.hidden, "tooltip appears after the delay");
  assert.match(String(tip._text), /block-office/);
  assert.equal(tip.style.left, "264px", "tooltip sits beside the cursor");
  assert.equal(tip.style.top, "64px");
  fire(canvas, "mouseleave", {});
  assert.ok(tip.hidden, "leaving the canvas hides the tooltip");
  // повторный hover и уход на пустое место: тултип прячется сразу
  fire(canvas, "mousemove", { clientX: 250, clientY: 50 });
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(!tip.hidden, "tooltip shown again over the deny router");
  fire(canvas, "mousemove", { clientX: 1000, clientY: 400 });
  assert.ok(tip.hidden, "moving onto empty space hides the shown tooltip");
});

test("reset toolbar button is disabled until a diagnosis produces a result", async () => {
  const { ids, frames, get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  assert.equal(ids["diag-tool-reset"].disabled, true, "nothing to reset yet");
  get(`Diagnose.renderReport(${JSON.stringify(switchedReport)})`);
  assert.equal(ids["diag-tool-reset"].disabled, false, "a report is now showing");
  fire(ids["diag-tool-reset"], "click", {});
  assert.equal(ids["diag-tool-reset"].disabled, true, "disabled again once reset");
});

test("reset button clears the report and the map highlight", async () => {
  const { ids, frames, get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(switchedReport)})`);
  await frames(10);
  assert.ok(ids["diag-paths"].children.length > 0, "report rendered before reset");
  fire(ids["diag-tool-reset"], "click", {});
  assert.equal(get("Diagnose.state.result"), null);
  assert.equal(get("Diagnose.state.hl"), null);
  assert.equal(get("Diagnose.state.flow"), null);
  assert.equal(ids["diag-summary"].hidden, true);
  assert.equal(ids["diag-paths"].children.length, 0);
  const dimmed = get("Diagnose.state.list.some((i) => (i.style.alpha ?? 1) < 1)");
  assert.ok(!dimmed, "nothing stays dimmed once the highlight is cleared");
});

test("reset during the flow fade-in does not get overwritten by the stale animation", async () => {
  const { ids, frames, get } = bootDiagnose({ ...responses, "/api/drafts/d1/topology": switchedTopo });
  await tick();
  await frames(1);
  get(`Diagnose.renderReport(${JSON.stringify(switchedReport)})`);
  fire(ids["diag-tool-reset"], "click", {});
  await frames(10);
  assert.equal(get("Diagnose.state.flowFade"), 0, "stale flow tween no longer drives flowFade");
});

// — плавающее окно параметров —

test("panel opens by default and the toolbar toggle is active", async () => {
  const { ids } = bootDiagnose(responses);
  await tick();
  assert.equal(ids["diag-panel"].hidden, false);
  assert.ok(ids["diag-tool-path"].classList.contains("active"));
});

test("toolbar toggle closes and reopens the panel", async () => {
  const { ids } = bootDiagnose(responses);
  await tick();
  fire(ids["diag-tool-path"], "click", {});
  assert.equal(ids["diag-panel"].hidden, true);
  assert.ok(!ids["diag-tool-path"].classList.contains("active"));
  fire(ids["diag-tool-path"], "click", {});
  assert.equal(ids["diag-panel"].hidden, false);
  assert.ok(ids["diag-tool-path"].classList.contains("active"));
});

test("close button hides the panel and deactivates the toggle", async () => {
  const { ids } = bootDiagnose(responses);
  await tick();
  fire(ids["diag-panel-close"], "click", {});
  assert.equal(ids["diag-panel"].hidden, true);
  assert.ok(!ids["diag-tool-path"].classList.contains("active"));
});

test("opening the panel snaps it back into the viewport if it drifted off-screen", async () => {
  const { ids } = bootDiagnose(responses);
  await tick();
  const panel = ids["diag-panel"];
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  panel.style.left = "5000px";
  panel.style.top = "5000px";
  fire(ids["diag-tool-path"], "click", {}); // закрыли
  fire(ids["diag-tool-path"], "click", {}); // открыли снова — окно должно подтянуться в видимую область
  assert.equal(panel.style.left, "892px");
  assert.equal(panel.style.top, "592px");
});

test("opening the panel leaves it in place when it's already within the viewport", async () => {
  const { ids } = bootDiagnose(responses);
  await tick();
  const panel = ids["diag-panel"];
  panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  panel.style.left = "100px";
  panel.style.top = "50px";
  fire(ids["diag-tool-path"], "click", {});
  fire(ids["diag-tool-path"], "click", {});
  assert.equal(panel.style.left, "100px");
  assert.equal(panel.style.top, "50px");
});

test("dragging the header moves the panel and persists its position", async () => {
  const { ids, doc, store } = bootDiagnose(responses);
  await tick();
  fire(ids["diag-panel-header"], "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  assert.equal(ids["diag-panel"].style.left, "60px");
  assert.equal(ids["diag-panel"].style.top, "30px");
  assert.deepEqual(JSON.parse(store["firenet-diag-panel-pos-v2"]), { x: 60, y: 30 });
});

test("saved panel position is restored on boot", async () => {
  const { ids } = bootDiagnose(responses, { "firenet-diag-panel-pos-v2": JSON.stringify({ x: 200, y: 80 }) });
  // boot clamps an initially-open panel into the viewport; give it a
  // realistic footprint so a saved position well within 1200x800 survives.
  (ids["diag-panel"] ||= makeEl("div")).getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  await tick();
  assert.equal(ids["diag-panel"].style.left, "200px");
  assert.equal(ids["diag-panel"].style.top, "80px");
});

// — запоминание введённых параметров формы —

test("editing a form field persists all fields to localStorage", async () => {
  const { ids, store } = bootDiagnose(responses);
  await tick();
  for (const id of ["diag-src", "diag-dst", "diag-proto", "diag-dstports"]) ids[id] ||= makeEl("input");
  ids["diag-src"].value = "10.0.0.5";
  ids["diag-dst"].value = "10.0.1.7";
  ids["diag-proto"].value = "tcp";
  ids["diag-dstports"].value = "443, 8080";
  fire(ids["diag-src"], "input", {});
  assert.deepEqual(JSON.parse(store["firenet-diag-form-v1"]), {
    "diag-src": "10.0.0.5", "diag-dst": "10.0.1.7", "diag-proto": "tcp", "diag-dstports": "443, 8080",
  });
});

test("saved form values are restored on boot", async () => {
  const saved = { "diag-src": "10.0.0.5", "diag-dst": "10.0.1.7", "diag-proto": "udp", "diag-dstports": "53" };
  const { ids } = bootDiagnose(responses, { "firenet-diag-form-v1": JSON.stringify(saved) });
  await tick();
  assert.equal(ids["diag-src"].value, "10.0.0.5");
  assert.equal(ids["diag-dst"].value, "10.0.1.7");
  assert.equal(ids["diag-proto"].value, "udp");
  assert.equal(ids["diag-dstports"].value, "53");
});

// — распространение сети (инструмент «Распространение сети») —

test("resolveSpreadSources resolves a subnet name to its base IP", async () => {
  const { get } = bootDiagnose(responses);
  await tick();
  const out = JSON.parse(get(
    'JSON.stringify(Diagnose.resolveSpreadSources("main", [{name:"main",cidr:"10.0.0.0/24"},{name:"office-net",cidr:"10.0.1.0/24"}], []))',
  ));
  assert.deepEqual(out, [{ ip: "10.0.0.0", subnetName: "main" }]);
});

test("resolveSpreadSources resolves a network name to every attached subnet", async () => {
  const { get } = bootDiagnose(responses);
  await tick();
  const out = JSON.parse(get(
    'JSON.stringify(Diagnose.resolveSpreadSources("HQ", ' +
    '[{name:"main",cidr:"10.0.0.0/24"},{name:"office-net",cidr:"10.0.1.0/24"}], ' +
    '[{name:"HQ",subnets:["main","office-net"]}]))',
  ));
  assert.deepEqual(out, [{ ip: "10.0.0.0", subnetName: "main" }, { ip: "10.0.1.0", subnetName: "office-net" }]);
});

test("resolveSpreadSources treats unmatched input as a literal IP", async () => {
  const { get } = bootDiagnose(responses);
  await tick();
  const out = JSON.parse(get('JSON.stringify(Diagnose.resolveSpreadSources("10.0.0.5", [{name:"main",cidr:"10.0.0.0/24"}], []))'));
  assert.deepEqual(out, [{ ip: "10.0.0.5", subnetName: null }]);
});

test("mergeFlows unions ok/deny/edge/half sets from several reports and promotes half to ok when another pair round-trips through the same element", async () => {
  const { get } = bootDiagnose(responses);
  await tick();
  const out = JSON.parse(get(`JSON.stringify((() => {
    // f1: one-way-only pair — "a" and "r1" (and the edge between them) are
    // only reachable, no return route (expandFlow's real invariant: a
    // one-way report leaves ok/okE empty and puts everything in half/halfE).
    const f1 = { hl: new Set(["a", "r1"]), ok: new Set(), deny: new Map(), okE: new Set(), denyE: new Set(), half: new Set(["a", "r1"]), halfE: new Set(["a\\0r1"]) };
    // f2: a different pair that round-trips through "a" and the same edge
    // fully (e.g. a second gateway with a mirrored route back) — this must
    // win over f1's half marking for the elements they share.
    const f2 = { hl: new Set(["a", "r2"]), ok: new Set(["a"]), deny: new Map([["r2", { rule: "x", reason: "y" }]]), okE: new Set(["a\\0r1"]), denyE: new Set(["a\\0r2"]), half: new Set(), halfE: new Set() };
    const m = Diagnose.mergeFlows([f1, f2]);
    return {
      hl: [...m.hl].sort(), ok: [...m.ok].sort(), denyKeys: [...m.deny.keys()], okE: [...m.okE], denyE: [...m.denyE],
      half: [...m.half], halfE: [...m.halfE],
    };
  })())`));
  assert.deepEqual(out.hl, ["a", "r1", "r2"]);
  assert.deepEqual(out.ok, ["a"], "\"a\" is promoted to full green: f2 shows a return path through it");
  assert.deepEqual(out.denyKeys, ["r2"]);
  assert.deepEqual(out.okE, ["a\0r1"], "the shared edge is promoted too");
  assert.deepEqual(out.denyE, ["a\0r2"]);
  assert.deepEqual(out.half, ["r1"], "\"r1\" stays half: no other pair shows a return path through it");
  assert.deepEqual(out.halfE, [], "the edge no longer has any un-promoted half mark left");
});

const spreadSubnets = {
  subnets: [
    { name: "main", cidr: "10.0.0.0/24" },
    { name: "office-net", cidr: "10.0.1.0/24" },
    { name: "dmz", cidr: "10.0.2.0/24" },
    { name: "branch-net", cidr: "10.0.3.0/24" },
  ],
};
const spreadTopo = {
  devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
  links: [{ a: { device: "r1" }, b: { device: "r2" } }],
  networks: [
    { name: "MAIN", subnets: ["main"], attach: [{ device: "r1" }] },
    { name: "OFFICE", subnets: ["office-net"], attach: [{ device: "r1" }] },
    { name: "DMZ", subnets: ["dmz"], attach: [{ device: "r2" }] },
    // BRANCH — второй сосед r1 (как office-net), но с returnPathAllowed:false:
    // проверяет, что общий узел/ребро r1↔main красится зелёным, раз через
    // него же ходит и полноценная двусторонняя пара (office-net).
    { name: "BRANCH", subnets: ["branch-net"], attach: [{ device: "r1" }] },
  ],
};
const spreadResponses = {
  ...responses,
  "/api/drafts/d1/topology": spreadTopo,
  "/api/drafts/d1/subnets": spreadSubnets,
  "/api/drafts/d1/diagnose": (body) => {
    if (body.src === "10.0.1.0") {
      return {
        srcSubnet: "office-net", dstSubnet: "main", note: "", paths: [{
          nodes: [{ kind: 1, name: "office-net" }, { kind: 0, name: "r1" }, { kind: 1, name: "main" }],
          routers: [{ router: "r1", action: "allow", reason: "ok" }], verdict: "allow",
        }],
      };
    }
    if (body.src === "10.0.2.0") {
      return {
        srcSubnet: "dmz", dstSubnet: "main", note: "", paths: [{
          nodes: [{ kind: 1, name: "dmz" }, { kind: 0, name: "r2" }, { kind: 0, name: "r1" }, { kind: 1, name: "main" }],
          routers: [
            { router: "r2", action: "deny", matchedRule: "block-dmz", reason: "запрещено" },
            { router: "r1", action: "allow", reason: "ok" },
          ],
          verdict: "deny",
        }],
      };
    }
    if (body.src === "10.0.3.0") {
      return {
        srcSubnet: "branch-net", dstSubnet: "main", note: "", returnPathAllowed: false, paths: [{
          nodes: [{ kind: 1, name: "branch-net" }, { kind: 0, name: "r1" }, { kind: 1, name: "main" }],
          routers: [{ router: "r1", action: "allow", reason: "ok" }], verdict: "allow",
        }],
      };
    }
    throw new Error("unexpected src " + body.src);
  },
};

test("the source datalist lists every network and subnet name", async () => {
  const { ids, frames } = bootDiagnose(spreadResponses);
  await tick();
  await frames(1);
  const names = ids["spread-sources"].children.map((o) => o.value).sort();
  assert.deepEqual(names, ["BRANCH", "DMZ", "MAIN", "OFFICE", "branch-net", "dmz", "main", "office-net"]);
});

test("spread panel starts closed while the path panel starts open", async () => {
  const { ids } = bootDiagnose(spreadResponses);
  await tick();
  assert.equal(ids["diag-panel"].hidden, false);
  assert.equal(ids["spread-panel"].hidden, true);
  fire(ids["diag-tool-spread"], "click", {});
  assert.equal(ids["spread-panel"].hidden, false);
  assert.ok(ids["diag-tool-spread"].classList.contains("active"));
});

test("spread form queries every other subnet and highlights what's reachable", async () => {
  const { ids, calls, frames, get } = bootDiagnose(spreadResponses);
  await tick();
  await frames(1);
  ids["spread-src"] ||= makeEl("input");
  ids["spread-src"].value = "main";
  fire(ids["spread-form"], "submit", {});
  await tick();
  const posts = calls.filter((c) => c.path === "/api/drafts/d1/diagnose");
  assert.equal(posts.length, 3, "one call per non-source subnet");
  assert.deepEqual(
    posts.map((c) => c.body).sort((a, b) => a.src.localeCompare(b.src)),
    [
      { src: "10.0.1.0", dst: "10.0.0.0", proto: "", dstPorts: [] },
      { src: "10.0.2.0", dst: "10.0.0.0", proto: "", dstPorts: [] },
      { src: "10.0.3.0", dst: "10.0.0.0", proto: "", dstPorts: [] },
    ],
  );
  await frames(10);
  const ok = JSON.parse(get("JSON.stringify([...Diagnose.state.flow.ok])"));
  const half = JSON.parse(get("JSON.stringify([...Diagnose.state.flow.half])"));
  const deny = JSON.parse(get("JSON.stringify([...Diagnose.state.flow.deny.keys()])"));
  const denyE = JSON.parse(get("JSON.stringify([...Diagnose.state.flow.denyE])"));
  // подсети адресуются на карте по имени владеющей сети (MAIN/OFFICE/DMZ),
  // не по собственному имени подсети — как и в диагностике одного пути.
  assert.ok(ok.includes("MAIN"), "the inspected network itself is lit");
  assert.ok(ok.includes("OFFICE") && ok.includes("r1"), "office-net already routes to main — fully lit");
  assert.ok(deny.includes("r2"), "r2 is where dmz's route toward main is blocked");
  assert.ok(denyE.includes("r1\0r2"), "propagation beyond the deny boundary is not lit");
  // branch-net has no return path of its own, but office-net round-trips
  // through the very same r1: the shared node must come out green, not
  // yellow — only branch-net itself, which nothing else vouches for, stays
  // half-open.
  assert.ok(ok.includes("r1"), "r1 is promoted to green: office-net already round-trips through it");
  assert.ok(half.includes("BRANCH"), "branch-net itself has no return path and nothing promotes it");
  assert.ok(!half.includes("r1"), "r1 is not left half-open just because branch-net alone can't reach back");
  assert.ok(!ids["spread-summary"].hidden);
  assert.match(String(ids["spread-summary"]._text || ""), /main/);
  // достижимость считает физический путь, а не вердикт фаервола: к dmz путь
  // есть (хоть и deny), поэтому он тоже в счётчике.
  assert.match(String(ids["spread-summary"]._text || ""), /4 из 4/);
});

test("reset button also clears the spread result", async () => {
  const { ids, calls, frames, get } = bootDiagnose(spreadResponses);
  await tick();
  await frames(1);
  ids["spread-src"] ||= makeEl("input");
  ids["spread-src"].value = "main";
  fire(ids["spread-form"], "submit", {});
  await tick();
  await frames(10);
  assert.equal(ids["diag-tool-reset"].disabled, false);
  fire(ids["diag-tool-reset"], "click", {});
  assert.equal(get("Diagnose.state.hl"), null);
  assert.equal(get("Diagnose.state.flow"), null);
  assert.equal(ids["spread-summary"].hidden, true);
  assert.equal(ids["diag-tool-reset"].disabled, true);
});
