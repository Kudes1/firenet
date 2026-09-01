"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Minimal DOM stub sufficient to boot topology.js outside a browser and
// exercise the canvas editor against a stubbed fetch. Animation frames go
// through a controllable rAF queue with fake clocks: page.pump() advances
// time and drains pending frames (camera tweens, node pop, canvas redraws).
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
(async () => {
  // common.js при импорте подписывается на document — стаб нужен до любых импортов
  global.document ||= { addEventListener() {} };
  // зависимости topology.js импортируются как ES-модули; topology.js — внутри
  // bootTopology с cache-busting'ом (каждый тест ждёт свежий State)
  await import(path.join(__dirname, "camera_input.js"));
  await import(path.join(__dirname, "tween.js"));
  await import(path.join(__dirname, "canvas_view.js"));
  await import(path.join(__dirname, "net_info.js"));
  await import(path.join(__dirname, "topology_sync.js"));
  const { Camera } = await import(path.join(__dirname, "camera.js"));
  const { Minimap } = await import(path.join(__dirname, "minimap.js"));
  const { CanvasTheme } = await import(path.join(__dirname, "canvas_theme.js"));
  const { HitTest } = await import(path.join(__dirname, "hit_test.js"));
  const { TopoScene } = await import(path.join(__dirname, "topo_scene.js"));

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

// canonicalPair/layoutKey/linkAt mirror the server's link identity
// (endpoint pair, not array position) closely enough for the fake below.
const canonicalPair = (a, b) => (a > b ? [b, a] : [a, b]);
const layoutKey = (a, b) => canonicalPair(a, b).join("|");
const linkAt = (links, a, b) => links.findIndex((l) => layoutKey(l.a.device, l.b.device) === layoutKey(a, b));
const dropStr = (arr, s) => (arr || []).filter((v) => v !== s);

// applyOperationFake is a minimal host-side mirror of
// internal/httpapi/topology_operations.go's applyTopologyOperation (and,
// independently, topology.js's own client-side applyTopologyOp) — good
// enough to stand in for the server in these tests without hand-writing a
// canned response per operation. Mutates store.topology/store.layout in
// place; unknown kinds are a no-op like the real server would 422 before
// ever getting here.
function applyOperationFake(store, op) {
  const topo = store.topology;
  const layout = store.layout;
  switch (op.kind) {
    case "create-device": topo.devices.push(op.device); break;
    case "delete-device": {
      topo.devices = topo.devices.filter((d) => d.name !== op.deviceName);
      topo.links = topo.links.filter((l) => {
        if (l.a.device === op.deviceName || l.b.device === op.deviceName) {
          delete layout.links[layoutKey(l.a.device, l.b.device)];
          return false;
        }
        return true;
      });
      topo.networks.forEach((n) => { n.attach = (n.attach || []).filter((a) => a.device !== op.deviceName); });
      (topo.unions || []).forEach((u) => { u.devices = dropStr(u.devices, op.deviceName); });
      delete layout.devices[op.deviceName];
      break;
    }
    case "update-device": {
      const i = topo.devices.findIndex((d) => d.name === op.deviceName);
      if (i < 0) break; // unknown device: server 422s, fake mirrors the no-op
      topo.devices[i] = { ...op.device };
      break;
    }
    case "create-network": topo.networks.push(op.network); break;
    case "update-network": {
      const i = topo.networks.findIndex((n) => n.name === op.networkName);
      if (i < 0) break; // unknown network: server 422s, fake mirrors the no-op
      topo.networks[i] = { ...op.network, attach: topo.networks[i].attach || [] };
      break;
    }
    case "delete-network":
      topo.networks = topo.networks.filter((n) => n.name !== op.networkName);
      topo.links.forEach((l) => {
        if (!l.filter) return;
        l.filter.aExports = dropStr(l.filter.aExports, op.networkName);
        l.filter.bExports = dropStr(l.filter.bExports, op.networkName);
      });
      (topo.unions || []).forEach((u) => { u.networks = dropStr(u.networks, op.networkName); });
      delete layout.networks[op.networkName];
      break;
    case "create-link": topo.links.push(op.link); break;
    case "delete-link": {
      const i = linkAt(topo.links, op.link.a.device, op.link.b.device);
      if (i >= 0) { delete layout.links[layoutKey(op.link.a.device, op.link.b.device)]; topo.links.splice(i, 1); }
      break;
    }
    case "set-link-filter": {
      const i = linkAt(topo.links, op.link.a.device, op.link.b.device);
      if (i >= 0) topo.links[i] = { ...topo.links[i], filter: op.filter };
      break;
    }
    case "clear-link-filter": {
      const i = linkAt(topo.links, op.link.a.device, op.link.b.device);
      if (i >= 0) { const { filter, ...rest } = topo.links[i]; topo.links[i] = rest; }
      break;
    }
    case "create-union": (topo.unions ||= []).push(op.union); break;
    case "delete-union": topo.unions = (topo.unions || []).filter((u) => u.name !== op.unionName); break;
    case "attach-network": {
      const n = topo.networks.find((x) => x.name === op.networkName);
      if (n) n.attach = [...(n.attach || []), op.attach];
      break;
    }
    case "detach-network": {
      const n = topo.networks.find((x) => x.name === op.networkName);
      if (n) n.attach = (n.attach || []).filter((a) => a.device !== op.attach.device);
      break;
    }
    case "union-add-device": {
      const u = (topo.unions || []).find((x) => x.name === op.unionName);
      if (u) u.devices = [...(u.devices || []), op.deviceName];
      break;
    }
    case "union-remove-device": {
      const u = (topo.unions || []).find((x) => x.name === op.unionName);
      if (u) u.devices = dropStr(u.devices, op.deviceName);
      break;
    }
    case "union-add-network": {
      const u = (topo.unions || []).find((x) => x.name === op.unionName);
      if (u) u.networks = [...(u.networks || []), op.networkName];
      break;
    }
    case "union-remove-network": {
      const u = (topo.unions || []).find((x) => x.name === op.unionName);
      if (u) u.networks = dropStr(u.networks, op.networkName);
      break;
    }
    case "set-device-position": layout.devices[op.deviceName] = op.position; break;
    case "set-network-position": layout.networks[op.networkName] = op.position; break;
    case "set-link-waypoints": layout.links[layoutKey(op.link.a.device, op.link.b.device)] = op.waypoints; break;
    case "set-camera": layout.camera = op.camera; break;
    default: break;
  }
}

async function bootTopology(responses, draftID = "d1", localStore = {}) {
  const draftStore = draftID ? { "firenet-draft-id": draftID } : {};
  const calls = [];
  const events = [];
  const ctx = makeCtx();
  const canvas = Object.assign(makeEl("canvas"), {
    clientWidth: 1200,
    clientHeight: 800,
    getContext: () => ctx,
  });
  const minimapCtx = makeCtx();
  const minimapCanvas = Object.assign(makeEl("canvas"), {
    clientWidth: 180,
    clientHeight: 120,
    getContext: () => minimapCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 180, height: 120 }),
  });
  const syncStatus = makeEl("span");
  const ids = {};
  const doc = {
    readyState: "loading",
    listeners: {},
    body: makeEl("body"),
    documentElement: { dataset: {} },
    // stable registry: production code resolves widgets by id repeatedly
    getElementById: (id) =>
      id === "topo-canvas" ? canvas : id === "topo-minimap" ? minimapCanvas
        : id === "topo-sync-status" ? syncStatus : (ids[id] ||= makeEl("div")),
    createElement: (tag) => makeEl(tag),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = doc.listeners[t];
      if (list) doc.listeners[t] = list.filter((f) => f !== fn);
    },
  };
  // управляемые кадры: rAF-очередь + фейковые часы для твинов и pop
  let clock = 0;
  const rafQueue = [];
  // opsStore backs the default POST .../topology/operations response: a
  // mutable clone of whatever the topology/layout GET fixtures resolve to,
  // advanced by applyOperationFake on every posted op. Lazily seeded on the
  // first POST so it reflects the fixtures exactly as boot() read them.
  // A test that needs to control the exact server response (e.g. one
  // exercising the server's canonical link order) still can — this only
  // fires when `responses` has no explicit entry for the operations path.
  const opsPath = `/api/drafts/${draftID}/topology/operations`;
  const opsBatchPath = `${opsPath}/batch`;
  let opsStore = null;
  const seedOpsStore = () => {
    if (opsStore) return;
    const topoResp = typeof responses[`/api/drafts/${draftID}/topology`] === "function"
      ? responses[`/api/drafts/${draftID}/topology`]() : responses[`/api/drafts/${draftID}/topology`];
    const layoutResp = typeof responses[`/api/drafts/${draftID}/layout`] === "function"
      ? responses[`/api/drafts/${draftID}/layout`]() : responses[`/api/drafts/${draftID}/layout`];
    const t = topoResp || {};
    const l = layoutResp || {};
    opsStore = {
      topology: JSON.parse(JSON.stringify({
        devices: t.devices || [], links: t.links || [], networks: t.networks || [], sets: t.sets || [], unions: t.unions || [],
      })),
      layout: JSON.parse(JSON.stringify({ devices: l.devices || {}, networks: l.networks || {}, links: l.links || {}, camera: l.camera || null })),
    };
  };
  global.document = doc;
  global.window = {
    addEventListener(t, fn) { (doc.listeners["win-" + t] ||= []).push(fn); },
    dispatchEvent(ev) { events.push(ev); },
  };
  global.localStorage = {
    getItem: (k) => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = v; },
  };
  global.sessionStorage = {
    getItem: (k) => (k in draftStore ? draftStore[k] : null),
    setItem: (k, v) => { draftStore[k] = v; },
    removeItem: (k) => { delete draftStore[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  global.confirm = () => false;
  global.prompt = () => null;
  global.FormData = class { get() { return ""; } };
  global.Path2D = class {};               // стаб для kind:"glyph"
  global.getComputedStyle = () => ({ getPropertyValue: () => "" });
  global.performance = { now: () => clock };
  global.requestAnimationFrame = (fn) => rafQueue.push(fn);
  // clone: production mutates loaded state, responses must stay pristine
  global.fetch = async (p, opts) => {
    calls.push({ path: p, method: opts?.method || "GET", body: opts?.body });
    if (p === opsPath && opts?.method === "POST" && !(opsPath in responses)) {
      seedOpsStore();
      applyOperationFake(opsStore, JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(opsStore)) };
    }
    if (p === opsBatchPath && opts?.method === "POST" && !(opsBatchPath in responses)) {
      seedOpsStore();
      JSON.parse(opts.body).operations.forEach((op) => applyOperationFake(opsStore, op));
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(opsStore)) };
    }
    const response = typeof responses[p] === "function" ? responses[p](opts) : responses[p];
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(response ?? null)) };
  };
  // cache-busting: каждый bootTopology ждёт свежие State и DirtyGuard
  const { Topology, State, applyTopologyOp } = await import(path.join(__dirname, "topology.js") + `?t=${Date.now()}-${Math.random()}`);
  var bootDirtyGuard = (await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`)).DirtyGuard;
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  const get = (expr) => new Function("State", "Topology", "Camera", "TopoScene", "HitTest", "Minimap", "CanvasTheme", "applyTopologyOp", "DirtyGuard", "window", "document", `return (${expr});`)(State, Topology, Camera, TopoScene, HitTest, Minimap, CanvasTheme, applyTopologyOp, bootDirtyGuard, global.window, doc);
  // pump исполняет кадры до исчерпания очереди (твин дошёл до цели)
  const pump = () => {
    while (rafQueue.length) {
      clock += 50;
      rafQueue.splice(0).forEach((fn) => fn(clock));
    }
  };
  return { canvas, ctx, doc, ids, get, pump, minimapCanvas, minimapCtx, calls, events };
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
  "/api/drafts/d1/topology": {
    devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
    links: [{ a: { device: "r1" }, b: { device: "r2" } }],
    networks: [{ name: "net1", subnets: ["a"], attach: [{ device: "r1" }] }],
    unions: [],
  },
  "/api/drafts/d1/subnets": { subnets: [{ name: "a", cidr: "10.0.0.0/24" }] },
  "/api/drafts/d1/layout": {},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("topology renders devices, links and networks without errors", async () => {
  const { get } = await bootTopology(responses);
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
  const { get } = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": topo,
    "/api/drafts/d1/subnets": { subnets: topo.networks[0].subnets.map((name) => ({ name, cidr: "10.0.0.0/24" })) },
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
  const { get } = await bootTopology({ ...responses, "/api/drafts/d1/topology": topo });
  await tick();
  const radii = JSON.parse(get(
    `JSON.stringify(State.list.filter((i) => i.nodeType === "device").map((i) => [i.ref.name, i.geom.r]))`,
  ));
  assert.deepEqual(radii, [["r1", 16], ["sw1", 2], ["x1", 6]], "router rounded, switch sharp, fallback plain");
  const glyphs = JSON.parse(get(`JSON.stringify(State.list.filter((i) => i.kind === "glyph").map((i) => i.id))`));
  assert.deepEqual(glyphs, ["device:r1:glyph", "device:sw1:glyph"], "glyph only for kinds that have one");
});

test("client projection removes deleted network from filtered-link exports", async () => {
  const { get } = await bootTopology(responses);
  await tick();
  const snapshot = {
    topology: {
      devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
      networks: [{ name: "office", subnets: [], attach: [] }, { name: "dmz", subnets: [], attach: [] }],
      links: [
        { a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["office"], bExports: ["dmz"] } },
        { a: { device: "r2" }, b: { device: "r1" }, filter: { aExports: ["dmz"], bExports: ["office"] } },
      ],
      sets: [], unions: [],
    },
    layout: { devices: {}, networks: {}, links: {}, camera: null },
  };
  const op = { kind: "delete-network", networkName: "office" };
  const next = JSON.parse(get(`JSON.stringify(applyTopologyOp(${JSON.stringify(snapshot)}, ${JSON.stringify(op)}))`));

  assert.deepEqual(next.topology.links[0].filter, { aExports: [], bExports: ["dmz"] });
  assert.deepEqual(next.topology.links[1].filter, { aExports: ["dmz"], bExports: [] });
  assert.deepEqual(snapshot.topology.links[0].filter.aExports, ["office"], "input snapshot stays unchanged");
});

test("network node renders as a closed cloud path inside its bbox", async () => {
  const { get } = await bootTopology(responses);
  await tick();
  const net = byId(get, "network:net1");
  assert.ok(net, "one network shape");
  assert.equal(net.geom.closed, true, "cloud path is a closed outline");
  assert.ok(net.geom.segs.length > 8, "cloud is drawn from many bulge segments");
});

test("topology tolerates empty project", async () => {
  const { ids, get } = await bootTopology({
    "/api/drafts/d1/topology": { devices: [], links: [], networks: [] },
    "/api/drafts/d1/subnets": { subnets: [] },
    "/api/drafts/d1/layout": {},
  });
  await tick();
  assert.equal(get("State.list.length"), 0, "empty display list for empty project");
  assert.ok(ids["topo-delete"].disabled, "trash disabled without nodes");
});

test("topology normalizes null collections from an empty draft", async () => {
  const { get } = await bootTopology({
    "/api/drafts/d1/topology": { devices: null, links: null, networks: null, sets: null, unions: null },
    "/api/drafts/d1/subnets": { subnets: null },
    "/api/drafts/d1/layout": {},
  });
  await tick();
  assert.deepEqual(JSON.parse(get("JSON.stringify(State.topology)")), {
    devices: [], links: [], networks: [], sets: [], unions: [],
  });
});

test("topology normalizes null collections returned by the operations endpoint", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { devices: [], links: [], networks: [], sets: [], unions: [] },
    "/api/drafts/d1/topology/operations": {
      topology: { devices: null, links: null, networks: null, sets: null, unions: null },
      layout: { devices: null, networks: null, links: null, camera: null },
    },
  });
  await tick();
  fire(page.ids["tool-device"], "click", {});
  fire(page.canvas, "click", { clientX: 300, clientY: 200 });
  page.ids["node-name-input"].value = "r3";
  fire(page.ids["node-name-form"], "submit", {});
  await tick();
  assert.deepEqual(JSON.parse(page.get("JSON.stringify(State.topology)")), {
    devices: [], links: [], networks: [], sets: [], unions: [],
  });
});

test("camera from layout is applied to the canvas view", async () => {
  const { get } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  assert.deepEqual(JSON.parse(get("JSON.stringify(State.camera)")), { x: -100, y: -50, z: 2 });
});

test("local camera supersedes the server layout for the same draft", async () => {
  const localStore = { "firenet-topology-camera:d1": JSON.stringify({ x: 40, y: 30, z: 1.5 }) };
  const { get } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  }, "d1", localStore);
  await tick();

  assert.deepEqual(JSON.parse(get("JSON.stringify(State.camera)")), { x: 40, y: 30, z: 1.5 });
});

test("wheel zooms around the cursor", async () => {
  const { canvas, get, pump } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: -100, y: -50, z: 2 } },
  });
  await tick();
  const before = JSON.parse(get("JSON.stringify(State.camera)"));
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  pump(); // зум применяется кадром rAF
  const after = JSON.parse(get("JSON.stringify(State.camera)"));
  assert.ok(after.z > before.z, "zoom changed the camera");
  // the world point under the cursor stays under the cursor
  const worldAt = (cam) => ({ x: (300 - cam.x) / cam.z, y: (200 - cam.y) / cam.z });
  const w0 = worldAt(before);
  const w1 = worldAt(after);
  assert.ok(Math.abs(w1.x - w0.x) < 0.01 && Math.abs(w1.y - w0.y) < 0.01, "cursor-anchored zoom");
});

test("middle-button drag pans the camera", async () => {
  const { canvas, doc, get, pump } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 1 } },
  });
  await tick();
  fire(canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  pump(); // пан применяется кадром rAF
  assert.deepEqual(JSON.parse(get("JSON.stringify(State.camera)")), { x: 60, y: 30, z: 1 });
});

test("panning the camera stores its position locally without a topology operation", async () => {
  const localStore = {};
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 1 } },
  }, "d1", localStore);
  await tick();

  fire(page.canvas, "mousedown", { button: 1, clientX: 100, clientY: 100 });
  fire(page.doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(page.doc, "mouseup", {});
  page.pump();

  assert.deepEqual(JSON.parse(localStore["firenet-topology-camera:d1"]), { x: 60, y: 30, z: 1 });
  assert.deepEqual(postedOps(page), []);
});

test("node dragging accounts for camera zoom", async () => {
  const { canvas, doc, get } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": {
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
  const { ids } = await bootTopology(responses);
  await tick();
  fire(ids["tool-connect"], "click", {});
  assert.equal(ids["tool-connect"].attrs.class, "tool active");
  assert.equal(ids["tool-select"].attrs.class, "tool");
});

test("topology shows a saved sync icon before its initial requests finish", async () => {
  const page = await bootTopology(responses);

  const status = page.doc.getElementById("topo-sync-status");
  assert.equal(status.attrs["data-status"], "saved");
  assert.equal(status.attrs["aria-label"], "Сохранено");
  assert.match(status.innerHTML, /<svg\b/);
});

test("device tool creates a device at the clicked world position", async () => {
  const { canvas, ids, get, pump } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 2 } },
  });
  await tick();
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 600, clientY: 400 }); // world (300,200), free of nodes
  // naming popover is open
  const input = ids["node-name-input"];
  assert.ok(input, "name input shown");
  input.value = "r3";
  fire(ids["node-name-form"], "submit", {});
  pump(); // pop-анимация добегает: геометрия финальная
  const dev = byId(get, "device:r3");
  assert.ok(dev, "device created");
  assert.equal(ids["tool-device"].attrs.class, "tool active", "device tool remains active after creation");
  // world position of the click: (300, 200); node is centred on the cursor
  assert.equal(dev.geom.x, 300 - 70, "device placed centred at the clicked world point");
  assert.equal(dev.geom.y, 200 - 30);
});

test("network tool creates a network node", async () => {
  const { canvas, ids, get } = await bootTopology(responses);
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
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], links: [] },
  });
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  // node clicks are plain mousedown+mouseup without movement
  clickNode(page, "r1");
  clickNode(page, "r2");
  assert.ok(byId(page.get, "link:r1|r2"), "wire rendered for the new link");
});

test("connect tool opens the edit panel for a link on right-click", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(edit, "edit item shown in connect mode");
  fire(edit, "click", {});
  assert.ok(!page.ids["link-panel"].hidden, "link panel opened");
});

test("click selects a node, background click clears selection", async () => {
  const page = await bootTopology(responses);
  await tick();
  clickNode(page, "r1");
  assert.equal(page.get("State.selection.size"), 1, "one node selected");
  assert.equal(byId(page.get, "device:r1").style.stroke, "#2563eb", "selection paints the accent stroke");
  fire(page.canvas, "click", { clientX: 900, clientY: 700 });
  assert.equal(page.get("State.selection.size"), 0, "selection cleared");
});

test("clicking a network opens the subnet info window", async () => {
  const page = await bootTopology(responses);
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
  const page = await bootTopology(responses);
  await tick();
  fullClick(page, "net1");
  assert.ok(!page.ids["net-info"].hidden, "info window stays open after the browser click");
});

test("full background click sequence closes the net info window", async () => {
  const page = await bootTopology(responses);
  await tick();
  fullClick(page, "net1");
  assert.ok(!page.ids["net-info"].hidden, "window opened first");
  fire(page.canvas, "mousedown", { button: 0, clientX: 900, clientY: 700 });
  fire(page.doc, "mouseup", {});
  fire(page.canvas, "click", { clientX: 900, clientY: 700 });
  assert.ok(page.ids["net-info"].hidden, "background sequence hides the window");
});

test("marquee selects all intersecting nodes", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(page.doc, "mousemove", { clientX: 600, clientY: 200 });
  fire(page.doc, "mouseup", { clientX: 600, clientY: 200 });
  assert.equal(page.get("State.selection.size"), 2, "both devices selected");
});

test("marquee selection survives the trailing click fired by the browser", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  fire(page.doc, "mousemove", { clientX: 600, clientY: 200 });
  fire(page.doc, "mouseup", { clientX: 600, clientY: 200 });
  // a real browser fires click on the canvas after the drag (same down/up target)
  fire(page.canvas, "click", { clientX: 600, clientY: 200 });
  assert.equal(page.get("State.selection.size"), 2, "selection kept after marquee");
});

test("Del removes selected devices", async () => {
  const page = await bootTopology(responses);
  await tick();
  clickNode(page, "r1");
  fire(page.doc, "keydown", { key: "Delete" });
  const names = texts(page.get);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
});

test("connect tool shows a preview wire while connecting", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "r1"); // pending = r1
  fire(page.canvas, "mousemove", { clientX: 500, clientY: 300 });
  page.pump(); // превью рисуется оверлеем канвы кадром rAF
  // пунктир [6,4] есть только у превью связи
  assert.ok(
    page.ctx.calls.some((c) => c[0] === "setLineDash" && String(c[1][0]) === "6,4"),
    "dashed preview wire painted",
  );
});

test("connect tool links network-first: net click then device click attaches", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      networks: [{ name: "net1", subnets: ["a"], attach: [] }],
    },
  });
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "net1");
  clickNode(page, "r2");
  assert.ok(byId(page.get, "attach:net1|r2"), "attach created from the network-first sequence");
});

test("connect tool rejects network-to-network with an explicit banner", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      links: [],
      networks: [
        { name: "net1", subnets: ["a"], attach: [] },
        { name: "net2", subnets: [], attach: [] },
      ],
    },
  });
  await tick();
  // перехват баннеров: showBanner шлёт событие notify через window
  global.CustomEvent = class { constructor(type, opts) { this.detail = opts && opts.detail; } };
  const banners = [];
  global.__banners = banners;
  page.get("window.dispatchEvent = (e) => __banners.push(e.detail.message)");
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "net1");
  fire(page.canvas, "mousedown", { button: 0, clientX: 320, clientY: 330 }); // net2: второе облако (240..400, 300..360)
  fire(page.doc, "mouseup", {});
  assert.deepEqual(banners, ["Сети net1 и net2 не могут быть соединены напрямую"], "explicit error shown");
  assert.equal(page.get("State.topology.links.length"), 0, "no link between networks");
  // pending сброшен: новое движение мыши не рисует превью связи
  const dashes = () => page.ctx.calls.filter((c) => c[0] === "setLineDash" && String(c[1][0]) === "6,4").length;
  const before = dashes();
  fire(page.canvas, "mousemove", { clientX: 500, clientY: 300 });
  page.pump();
  assert.equal(dashes(), before, "no dashed preview after the rejection");
});

test("connect tool previews from a network and cancels on repeated click", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "net1"); // pending = net1
  fire(page.canvas, "mousemove", { clientX: 500, clientY: 300 });
  page.pump();
  const dashes = () => page.ctx.calls.filter((c) => c[0] === "setLineDash" && String(c[1][0]) === "6,4").length;
  assert.ok(dashes() > 0, "dashed preview painted from the network");
  const before = dashes();
  clickNode(page, "net1"); // повторный клик отменяет pending
  fire(page.canvas, "mousemove", { clientX: 520, clientY: 310 });
  page.pump();
  assert.equal(dashes(), before, "no new preview dash after cancel");
});

// контекстное меню: правый клик по канве в режиме select открывает меню
// объекта под курсором; рекурсивный поиск по дереву меню (подменю — это
// div.ctx-sub внутри меню)
function findBtn(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children) {
    const f = findBtn(c, pred);
    if (f) return f;
  }
  return null;
}
// элемент меню создаётся production-кодом лениво; прекоммитим его в реестр
// в состоянии «закрыто», как в html
const ctxMenu = (page) => {
  const el = (page.ids["topo-context-menu"] ||= makeEl("div"));
  if (el.hidden === undefined) el.hidden = true;
  return el;
};

test("context menu deletes a node", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const menu = ctxMenu(page);
  assert.ok(menu && !menu.hidden, "menu shown");
  const del = findBtn(menu, (b) => String(b.textContent).startsWith("Удалить"));
  assert.ok(del, "delete item present");
  fire(del, "click", {});
  assert.ok(!texts(page.get).includes("r1 (router)"), "r1 removed");
});

test("filtered link menu item names it a filtered wire", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      links: [{ a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["a"], bExports: [] } }],
    },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 }); // середина связи r1–r2
  const del = findBtn(ctxMenu(page), (b) => String(b.textContent).startsWith("Удалить"));
  assert.ok(del, "menu opened on the wire");
  assert.match(String(del.textContent), /Удалить фильтрованная связь r1–r2/, "filtered prefix restored");
});

test("clean right-click on a node opens its menu after release", async () => {
  const page = await bootTopology(responses);
  await tick();
  // press-order platforms (Linux): contextmenu fires while RMB is still held
  fire(page.canvas, "mousedown", { button: 2, clientX: AT.r1.x, clientY: AT.r1.y });
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  assert.ok(ctxMenu(page).hidden, "menu waits for a clean release");
  fire(page.doc, "mouseup", { button: 2 });
  assert.ok(!ctxMenu(page).hidden, "menu shown on clean right-click");
  const del = findBtn(ctxMenu(page), (b) => String(b.textContent).startsWith("Удалить"));
  assert.ok(del, "delete item present");
});

test("right-button drag does not open the node menu", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "mousedown", { button: 2, clientX: AT.r1.x, clientY: AT.r1.y });
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  fire(page.doc, "mousemove", { clientX: AT.r1.x + 100, clientY: AT.r1.y + 60 });
  fire(page.doc, "mouseup", { button: 2 });
  assert.ok(ctxMenu(page).hidden, "no menu after a drag");
});

test("native context menu is suppressed on the canvas", async () => {
  const page = await bootTopology(responses);
  await tick();
  // right-click anywhere (background or node): no native browser menu
  const ev = {};
  fire(page.canvas, "contextmenu", ev);
  assert.ok(ev.defaultPrevented, "canvas contextmenu prevented");
});

test("keyboard shortcuts switch tools", async () => {
  const { ids, doc } = await bootTopology(responses);
  await tick();
  fire(doc, "keydown", { key: "c" });
  assert.equal(ids["tool-connect"].attrs.class, "tool active");
  fire(doc, "keydown", { key: "v" });
  assert.equal(ids["tool-select"].attrs.class, "tool active");
});

test("popover stays inside the canvas near the edges", async () => {
  const { canvas, ids } = await bootTopology(responses);
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
  const { canvas, ids } = await bootTopology(responses);
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
  const { canvas, doc, ids, pump } = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 1 } },
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
  pump(); // пан применяется кадром rAF
  assert.equal(pop.style.left, "360px", "popover shifted with the pan (+60)");
  assert.equal(pop.style.top, "230px", "popover shifted with the pan (+30)");
});

test("popover cancels on Escape", async () => {
  const { canvas, ids } = await bootTopology(responses);
  await tick();
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  const input = ids["node-name-input"];
  assert.ok(!ids["node-popover"].hidden, "popover open");
  fire(input, "keydown", { key: "Escape" });
  assert.ok(ids["node-popover"].hidden, "popover closed");
});

// Every edit now persists immediately through the operations queue instead
// of a bulk Save button, so DirtyGuard is never armed for this page: no
// "leave without saving?" prompt can fire after a confirmed command.
test("no unsaved-navigation prompt after a confirmed command: DirtyGuard is never armed on this page", async () => {
  const { canvas, ids, get } = await bootTopology(responses);
  await tick();
  assert.equal(get("DirtyGuard.isDirty()"), false, "clean after boot");
  fire(ids["tool-device"], "click", {});
  fire(canvas, "click", { clientX: 300, clientY: 200 });
  ids["node-name-input"].value = "r3";
  fire(ids["node-name-form"], "submit", {});
  await tick();
  assert.ok(byId(get, "device:r3"), "node created and persisted");
  assert.equal(get("DirtyGuard.isDirty()"), false, "DirtyGuard.arm was never called on /ui/topology");
});

// --- delete button (trash) ---

test("delete button is disabled without selection and enabled by it", async () => {
  const page = await bootTopology(responses);
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
  const page = await bootTopology(responses);
  global.confirm = () => true;
  await tick();
  clickNode(page, "r1");
  fire(page.ids["topo-delete"], "click", {});
  const names = texts(page.get);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
});

test("deleting a device cascades to its links and network attachments", async () => {
  const page = await bootTopology(responses);
  global.confirm = () => true;
  await tick();
  clickNode(page, "r1");
  fire(page.ids["topo-delete"], "click", {});
  assert.equal(page.get("State.topology.links.length"), 0, "link to r1 removed");
  assert.equal(page.get("State.topology.networks[0].attach.length"), 0, "attach to r1 removed");
});

test("deleting a multi-object selection sends one batch request, not one per object", async () => {
  const page = await bootTopology(responses);
  global.confirm = () => true;
  await tick();
  clickNode(page, "r1");
  clickNode(page, "net1", true);
  fire(page.ids["topo-delete"], "click", {});
  await tick();

  const opsCalls = page.calls.filter((c) => c.method === "POST" && c.path === "/api/drafts/d1/topology/operations");
  const batchCalls = page.calls.filter((c) => c.method === "POST" && c.path === "/api/drafts/d1/topology/operations/batch");
  assert.equal(opsCalls.length, 0, "no per-op requests for a multi-select delete");
  assert.equal(batchCalls.length, 1, "exactly one batch request");
  const ops = JSON.parse(batchCalls[0].body).operations;
  assert.deepEqual(ops.map((op) => op.kind), ["delete-device", "delete-network"]);

  const names = texts(page.get);
  assert.ok(!names.includes("r1 (router)"), "r1 removed");
  assert.ok(names.includes("r2 (router)"), "r2 kept");
  assert.equal(page.get("State.topology.networks.length"), 0, "net1 removed");
  assert.equal(page.get("State.topology.links.length"), 0, "link to r1 removed with it");
});

test("declining confirm keeps the selected device", async () => {
  const page = await bootTopology(responses);
  await tick();
  clickNode(page, "r1");
  fire(page.ids["topo-delete"], "click", {});
  assert.ok(texts(page.get).includes("r1 (router)"), "r1 kept when not confirmed");
});

// wires carry pickable geometry instead of invisible hit twins

test("wires and attachments are pickable along their path", async () => {
  const { get } = await bootTopology(responses);
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
  const page = await bootTopology(responses);
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
  const page = await bootTopology(responses);
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
  "/api/drafts/d1/topology": {
    ...responses["/api/drafts/d1/topology"],
    unions: [{ name: "office", devices: ["r1", "r2"], networks: ["net1"] }],
  },
};

test("union frames render as bounding boxes behind the graph", async () => {
  const { get } = await bootTopology(unionsResponses);
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
  resp["/api/drafts/d1/topology"].unions = [
    { name: "a", devices: ["r1"] },
    { name: "b", devices: ["r2"] },
  ];
  const { get } = await bootTopology(resp);
  await tick();
  const frames = JSON.parse(get(
    `JSON.stringify(State.list.filter((i) => i.id.startsWith("union:") && !i.id.includes(":label")).map((i) => [i.ref.name, i.style.stroke]))`,
  ));
  assert.deepEqual(frames.map(([n]) => n), ["a", "b"], "document order");
  assert.notEqual(frames[0][1], frames[1][1], "palette colors differ");
});

test("frames sit behind wires and nodes", async () => {
  const { get } = await bootTopology(unionsResponses);
  await tick();
  const order = get(`State.list.map((i) => i.id)`);
  assert.ok(order.indexOf("union:office") < order.indexOf("link:r1|r2"), "frame precedes wires in paint order");
});

test("no union frames when topology has none", async () => {
  const { get } = await bootTopology(responses);
  await tick();
  assert.equal(get(`State.list.filter((i) => i.id.startsWith("union:")).length`), 0);
});

// --- union assignment via the context menu ---

test("context menu assigns a node to a union and removes it back", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y }); // r1
  const assign = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("office"));
  assert.ok(assign, "assign item listed in the union submenu");
  fire(assign, "click", {});
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].devices")), '["r1"]', "member recorded");

  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const unassign = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("Убрать"));
  fire(unassign, "click", {});
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].devices")), "[]", "membership cleared");
});

test("union submenu lists locations and shows a placeholder when none are available", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: ["r1"] }] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y }); // r1
  const sub = findBtn(
    ctxMenu(page),
    (n) => n.tag !== "button" && String(n.attrs.class || "").includes("submenu"),
  );
  assert.ok(sub, "submenu rendered");
  const empty = findBtn(sub, (b) => b.tag === "button" && String(b.textContent).includes("нет доступных"));
  assert.ok(empty && empty.disabled, "placeholder shown and disabled when all unions hold the node");

  fire(page.canvas, "contextmenu", { clientX: AT.r2.x, clientY: AT.r2.y }); // r2
  const listed = findBtn(
    ctxMenu(page),
    (n) => n.tag !== "button" && String(n.attrs.class || "").includes("submenu"),
  );
  assert.ok(listed, "submenu rendered for r2");
  const item = findBtn(listed, (b) => b.tag === "button" && String(b.textContent).includes("office"));
  assert.ok(item && !item.disabled, "union listed for a node outside it");
});

test("union submenu with several candidates shows a search field that filters the list", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      unions: [{ name: "dmz", devices: [] }, { name: "lan", devices: [] }, { name: "office", devices: [] }],
    },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const sub = findBtn(
    ctxMenu(page),
    (n) => n.tag !== "button" && String(n.attrs.class || "").includes("submenu"),
  );
  const input = sub.children.find((c) => c.tag === "input");
  assert.ok(input, "search field rendered for several candidates");
  const names = () => sub.children.filter((c) => c.tag === "button" && !c.hidden).map((b) => String(b.textContent));

  input.value = "dm";
  fire(input, "input", {});
  assert.deepEqual(names(), ["В объединение «dmz»"], "only the matching union stays visible");

  input.value = "";
  fire(input, "input", {});
  assert.deepEqual(names(), ["В объединение «dmz»", "В объединение «lan»", "В объединение «office»"], "clearing restores the full list");
});

test("union submenu with a single candidate renders no search field", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const sub = findBtn(
    ctxMenu(page),
    (n) => n.tag !== "button" && String(n.attrs.class || "").includes("submenu"),
  );
  assert.ok(!sub.children.some((c) => c.tag === "input"), "no search field for a single candidate");
});

test("context menu keeps union items above the danger delete item", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const menu = ctxMenu(page);
  const buttons = menu.children.map((c) => (c.tag === "div" ? c.children[0] : c));
  assert.ok(String(buttons[0].textContent) === "Редактировать", "edit item first");
  const sub = buttons[1];
  assert.ok(String(sub.textContent).includes("Добавить в объединение"), "union submenu after edit");
  assert.ok(!sub.disabled, "submenu button is enabled");
  const del = buttons[buttons.length - 1];
  assert.ok(String(del.textContent).startsWith("Удалить"), "delete item last");
  assert.ok(String(del.attrs.class || "").includes("danger"), "delete styled as danger");
  assert.ok(!String(sub.attrs.class || "").includes("danger"), "union item is not danger-colored");
});

test("network nodes get union assignment in the context menu too", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office" }] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y });
  const assign = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("office"));
  assert.ok(assign, "network can be assigned");
  fire(assign, "click", {});
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].networks")), '["net1"]', "network member recorded");
});

test("context menu assigns every selected node to a union at once", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  clickNode(page, "r1");
  clickNode(page, "r2", true); // shift-click extends selection to both routers
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y }); // right-click one of the selected nodes
  const assign = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("office"));
  assert.ok(assign, "assign item listed in the union submenu");
  fire(assign, "click", {});
  assert.equal(
    JSON.stringify([...page.get("State.topology.unions[0].devices")].sort()),
    '["r1","r2"]',
    "both selected devices recorded",
  );
});

test("context menu removes every selected node from its union at once", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: ["r1", "r2"] }] },
  });
  await tick();
  clickNode(page, "r1");
  clickNode(page, "r2", true);
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const unassign = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("Убрать"));
  assert.ok(unassign, "remove item listed for a member of the selection");
  fire(unassign, "click", {});
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].devices")), "[]", "both selected devices cleared");
});

test("context menu on an unselected node still targets only that node", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: [] }] },
  });
  await tick();
  clickNode(page, "r1");
  clickNode(page, "r2", true); // r1 and r2 selected...
  fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y }); // ...but right-click hits net1, outside the selection
  const assign = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("office"));
  fire(assign, "click", {});
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].devices")), "[]", "unrelated selected devices untouched");
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].networks")), '["net1"]', "only the right-clicked network joins");
});

test("deleting a node scrubs it from union membership", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], unions: [{ name: "office", devices: ["r1"] }] },
  });
  await tick();
  clickNode(page, "r1");
  fire(page.doc, "keydown", { key: "Delete" });
  assert.equal(JSON.stringify(page.get("State.topology.unions[0].devices")), "[]", "r1 dropped from union");
});

// --- hover: курсор и тултип экспорта фильтрованной связи ---

const filteredResponses = {
  ...responses,
  "/api/drafts/d1/topology": {
    ...responses["/api/drafts/d1/topology"],
    links: [{ a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["office"], bExports: ["dmz"] } }],
  },
};

test("hover sets the cursor by target kind", async () => {
  const page = await bootTopology(filteredResponses);
  await tick();
  fire(page.canvas, "mousemove", { clientX: AT.r1.x, clientY: AT.r1.y });
  assert.equal(page.canvas.style.cursor, "grab", "grab over a node");
  fire(page.canvas, "mousemove", { clientX: 900, clientY: 700 });
  assert.equal(page.canvas.style.cursor, "default", "default over background");
  const mid = JSON.parse(page.get(`JSON.stringify((() => {
    const s = State.list.find((i) => i.id === "link:r1|r2").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })())`));
  fire(page.canvas, "mousemove", { clientX: mid.x, clientY: mid.y });
  assert.equal(page.canvas.style.cursor, "pointer", "pointer over a wire");
});

test("clicking a filtered wire pins a both-direction exports tooltip", async () => {
  const page = await bootTopology(filteredResponses);
  await tick();
  page.pump();
  const mid = JSON.parse(page.get(`JSON.stringify((() => {
    const s = State.list.find((i) => i.id === "link:r1|r2").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })())`));
  const tip = page.ids["topo-tooltip"];
  fire(page.canvas, "mousemove", { clientX: mid.x, clientY: mid.y });
  assert.ok(tip.hidden, "hover alone keeps the tooltip hidden");
  fire(page.canvas, "click", { clientX: mid.x, clientY: mid.y });
  assert.ok(!tip.hidden, "click pins the tooltip");
  const html = tip.innerHTML;
  assert.match(html, /<b>r1<\/b> → <b>r2<\/b>/, "a-side route header");
  assert.match(html, /<b>r2<\/b> → <b>r1<\/b>/, "b-side route header");
  assert.match(html, /owner-badge">office</, "a-side exports as badges");
  assert.match(html, /owner-badge">dmz</, "b-side exports as badges");
  assert.ok(!/<div class="hint">ничего</.test(html), "both sides have exports");
  fire(page.canvas, "mouseleave", {});
  assert.ok(tip.hidden, "leaving the canvas unpins the tooltip");
});

// --- кнопка «вписать карту» и pop появления узлов ---

test("fit button flies the camera to the scene bounds", async () => {
  const page = await bootTopology(responses);
  await tick();
  page.pump();
  const expected = JSON.parse(page.get(
    `JSON.stringify(Camera.fitView(State.camera, TopoScene.bounds(State.topology, State.layout), 1200, 800, 60))`,
  ));
  fire(page.ids["topo-fit"], "click", {});
  page.pump(); // камера долетает твином
  assert.deepEqual(JSON.parse(page.get("JSON.stringify(State.camera)")), expected);
});

// --- миникарта ---

test("minimap stays hidden when the scene fits the viewport", async () => {
  const page = await bootTopology(responses);
  await tick();
  page.pump();
  assert.equal(page.minimapCanvas.hidden, true);
});

test("minimap appears when the scene overflows the viewport", async () => {
  const page = await bootTopology({ ...responses, "/api/drafts/d1/layout": { camera: { x: 0, y: 0, z: 5 } } });
  await tick();
  page.pump();
  assert.equal(page.minimapCanvas.hidden, false);
});

test("clicking the minimap recenters the page camera on the clicked point, keeping zoom", async () => {
  const page = await bootTopology({ ...responses, "/api/drafts/d1/layout": { camera: { x: 0, y: 0, z: 5 } } });
  await tick();
  page.pump();
  const expected = JSON.parse(page.get(`
    JSON.stringify((() => {
      const b = TopoScene.bounds(State.topology, State.layout);
      const map = Minimap.layout(b, 180, 120, 10);
      const w = Camera.screenToWorld(map, 90, 60);
      const r = document.getElementById("topo-canvas").getBoundingClientRect();
      return { x: r.width / 2 - w.x * State.camera.z, y: r.height / 2 - w.y * State.camera.z, z: State.camera.z };
    })())
  `));
  fire(page.minimapCanvas, "mousedown", { button: 0, clientX: 90, clientY: 60 });
  page.pump();
  assert.deepEqual(JSON.parse(page.get("JSON.stringify(State.camera)")), expected);
});

test("a freshly created node pops in and settles", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/layout": { devices: {}, networks: {}, camera: { x: 0, y: 0, z: 2 } },
  });
  await tick();
  fire(page.ids["tool-device"], "click", {});
  fire(page.canvas, "click", { clientX: 600, clientY: 400 }); // world (300,200)
  page.ids["node-name-input"].value = "r3";
  fire(page.ids["node-name-form"], "submit", {});
  // сразу после создания узел меньше и прозрачнее финального состояния
  const fresh = JSON.parse(page.get(`JSON.stringify(State.list.find((i) => i.id === "device:r3"))`));
  assert.ok((fresh.style.alpha ?? 1) < 1 || fresh.geom.w < 140, "node starts popped-down");
  page.pump(); // анимация 180 мс добегает до полного размера
  const settled = JSON.parse(page.get(`JSON.stringify(State.list.find((i) => i.id === "device:r3"))`));
  assert.equal(settled.geom.w, 140, "full-size box after the pop");
  assert.equal(settled.style.alpha ?? 1, 1, "fully opaque after the pop");
});

// --- редактирование точек изгиба связи ---

// midpoint of the default r1–r2 link (centers (110,70) and (310,70) at z=1)
const LINK_MID = { x: 210, y: 70 };

test("double-click on a link adds a waypoint and switches it to a poly", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "dblclick", { clientX: LINK_MID.x, clientY: LINK_MID.y });
  const link = byId(page.get, "link:r1|r2");
  assert.ok(link.geom.poly, "link now renders as a poly");
  assert.deepEqual(
    JSON.parse(page.get(`JSON.stringify(State.list.find((i) => i.id === "link:r1|r2").geom.poly[1])`)),
    LINK_MID,
    "waypoint placed at the click position",
  );
  assert.equal(page.get("State.selection.size"), 1, "adding a waypoint selects the link");
  assert.ok(byId(page.get, "linkpt:r1|r2:0:0"), "waypoint handle rendered for the selected link");
});

test("double-click on a waypoint handle removes it", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "dblclick", { clientX: LINK_MID.x, clientY: LINK_MID.y });
  fire(page.canvas, "dblclick", { clientX: LINK_MID.x, clientY: LINK_MID.y });
  const link = byId(page.get, "link:r1|r2");
  assert.ok(link.geom.segs, "link falls back to the auto curve without waypoints");
  assert.equal(page.get(`State.layout.links["r1|r2"][0].length`), 0, "waypoint removed from layout");
});

test("dragging a waypoint handle updates its position and rebuilds the display list", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "dblclick", { clientX: LINK_MID.x, clientY: LINK_MID.y });
  fire(page.canvas, "mousedown", { button: 0, clientX: LINK_MID.x, clientY: LINK_MID.y });
  fire(page.doc, "mousemove", { clientX: LINK_MID.x, clientY: LINK_MID.y - 30 });
  fire(page.doc, "mouseup", {});
  const moved = { x: LINK_MID.x, y: LINK_MID.y - 30 };
  assert.deepEqual(
    JSON.parse(page.get(`JSON.stringify(State.layout.links["r1|r2"][0][0])`)),
    moved,
    "waypoint moved to the dragged position",
  );
  assert.deepEqual(
    JSON.parse(page.get(`JSON.stringify(State.list.find((i) => i.id === "link:r1|r2").geom.poly[1])`)),
    moved,
    "display list reflects the drag",
  );
});

// --- link panel: ПКМ по связи → «Редактировать» открывает плавающую панель ---

function domTexts(node) {
  const out = [];
  (function walk(n) {
    if (n._text) out.push(String(n._text));
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

test("right-click on a link offers Редактировать and opens the link panel at the click point", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 }); // середина связи r1–r2
  const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(edit, "edit item present on a link");
  fire(edit, "click", {});
  const panel = page.ids["link-panel"];
  assert.ok(panel && !panel.hidden, "panel opened");
  assert.match(domTexts(panel).join("|"), /r1.*↔.*r2/, "title names both link devices");
  assert.equal(panel.style.left, "224px", "anchored near the click point");
});

test("link panel uses the diagnostic header and close action", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  const panel = page.ids["link-panel"];
  const header = panel.children.find((el) => el.tag === "header" && el.attrs.class === "diag-panel-header");
  assert.ok(header, "panel has the diagnostic-style header");
  const close = header.children.find((el) => el.attrs.class === "diag-panel-close");
  assert.ok(close, "header has a close button");
  fire(close, "click", {});
  assert.ok(panel.hidden, "close button hides the panel");
});

test("applying a filter from the link panel persists it via set-link-filter, addressed by endpoint pair", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/link-exports?a=r1&b=r2&side=a": { entities: [{ name: "office", cidr: "10.0.0.0/24" }] },
    "/api/drafts/d1/link-exports?a=r1&b=r2&side=b": { entities: [] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  const panel = page.ids["link-panel"];
  fire(findBtn(panel, (b) => String(b.textContent).trim() === "Сделать фильтрованной"), "click", {});
  await tick();
  assert.ok(page.calls.some((c) => /link-exports\?a=r1&b=r2&side=a/.test(c.path)), "candidates fetched by endpoint pair");
  const select = findBtn(panel, (n) => n.tag === "select");
  select.value = "office";
  fire(select, "change", {});
  fire(findBtn(panel, (b) => String(b.textContent).trim() === "Применить"), "click", {});
  // local projection updates immediately, before the write round-trips
  assert.deepEqual(
    JSON.parse(page.get("JSON.stringify(State.topology.links[0].filter)")),
    { aExports: ["office"], bExports: [] },
    "filter applied to the projected topology",
  );
  assert.ok(panel.hidden, "panel closes after apply");
  await tick();
  const posted = page.calls.filter((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST");
  assert.equal(posted.length, 1, "one set-link-filter operation sent");
  assert.deepEqual(
    JSON.parse(page.get("JSON.stringify(State.topology.links[0].filter)")),
    { aExports: ["office"], bExports: [] },
    "filter still reflected after the server confirms",
  );
});

test("clearing a filter from the link panel sends clear-link-filter", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      links: [{ a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["office"], bExports: [] } }],
    },
    "/api/drafts/d1/link-exports?a=r1&b=r2&side=a": { entities: [] },
    "/api/drafts/d1/link-exports?a=r1&b=r2&side=b": { entities: [] },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  const panel = page.ids["link-panel"];
  fire(findBtn(panel, (b) => String(b.textContent).trim() === "Вернуть обычную"), "click", {});
  fire(findBtn(panel, (b) => String(b.textContent).trim() === "Применить"), "click", {});
  assert.equal(page.get("State.topology.links[0].filter"), undefined, "filter cleared in the projection");
  await tick();
  const opCall = page.calls.find((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST");
  assert.ok(opCall, "clear-link-filter operation sent");
});

test("cancel closes the link panel without touching the topology", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
  const panel = page.ids["link-panel"];
  fire(findBtn(panel, (b) => String(b.textContent).trim() === "Отмена"), "click", {});
  assert.ok(panel.hidden, "panel closed");
  assert.equal(page.get("State.topology.links[0].filter"), undefined, "no changes recorded");
});

// «Редактировать» на только что созданной связи недоступно, пока create-link
// не подтверждён сервером — настройка фильтра требует сохранённой топологии
// (design spec, "Клиентский поток").
test("editing a just-created link is unavailable until its create-link operation confirms", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": { ...responses["/api/drafts/d1/topology"], links: [] },
  });
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "r1");
  clickNode(page, "r2");
  // Checked synchronously, before the fetch microtask settles: write() is
  // in flight (default fake server's response is still an unresolved
  // promise at this point), so the create-link op is genuinely pending.
  assert.ok(page.calls.some((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST"), "create-link posted");
  fire(page.ids["tool-select"], "click", {}); // context menu only opens in "select" mode
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(edit, "menu item still present");
  assert.ok(edit.disabled, "disabled while the create is still pending");
  fire(edit, "click", {});
  assert.ok(page.ids["link-panel"].hidden, "panel does not open for a pending link");
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 210, clientY: 70 });
  const edit2 = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(!edit2.disabled, "edit becomes available once the create confirms");
});

// --- net-edit: ПКМ по сети → «Редактировать» открывает плавающее окно сети ---

// installNetEditAlpine подменяет globalThis.Alpine двойником: канал между
// topology.js и Alpine-компонентом networksPage (окно #net-edit) — обычные
// вызовы методов инстанса, двойник их записывает и раздаёт стаб-состояние.
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

test("right-click on a network offers Редактировать and opens the floating net-edit window with canvas data", async () => {
  const page = await bootTopology(responses);
  await tick();
  const alpine = installNetEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y });
    const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
    assert.ok(edit, "edit item present on a network");
    fire(edit, "click", {});
    assert.deepEqual(alpine.calls[0]?.slice(0, 2), ["openNetworkEdit", "net1"], "editor opened for the clicked network");
    assert.deepEqual(alpine.calls[0][2], { x: AT.net1.x, y: AT.net1.y }, "window anchored at the click point");
    assert.deepEqual(alpine.instance.networks, [{ name: "net1", subnets: ["a"], description: undefined }], "canvas networks injected");
    assert.deepEqual(alpine.instance.subnets, [{ name: "a", cidr: "10.0.0.0/24" }], "canvas subnets injected");
    assert.equal(typeof alpine.instance._savePort, "function", "save routed through the canvas sync queue");
  } finally {
    alpine.done();
  }
});

// «Редактировать» на только что созданной сети недоступно, пока create-network
// не подтверждён сервером — как и для связи (design spec, "Клиентский поток").
test("editing a just-created network is unavailable until its create-network operation confirms", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.ids["tool-network"], "click", {});
  fire(page.canvas, "click", { clientX: 500, clientY: 400 });
  page.ids["node-name-input"].value = "lan2";
  fire(page.ids["node-name-form"], "submit", {});
  fire(page.ids["tool-select"], "click", {});
  // синхронно, до оседания fetch-микротаска: create-network ещё в полёте
  fire(page.canvas, "contextmenu", { clientX: 500, clientY: 400 });
  const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(edit, "menu item still present");
  assert.ok(edit.disabled, "disabled while the create is still pending");
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 500, clientY: 400 });
  const edit2 = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(!edit2.disabled, "edit becomes available once the create confirms");
});

test("read-only tab: Редактировать on a network does not open the net-edit window", async () => {
  const roResponses = {
    "/api/versions/current/topology": { devices: [], links: [], networks: [{ name: "net1", subnets: [], attach: [] }], sets: [], unions: [] },
    "/api/versions/current/subnets": { subnets: [] },
    "/api/versions/current/layout": {},
  };
  const page = await bootTopology(roResponses, null);
  await tick();
  const alpine = installNetEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y });
    const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
    assert.ok(edit, "menu item present");
    fire(edit, "click", {});
    assert.equal(alpine.calls.length, 0, "read-only tab never opens the editor");
  } finally {
    alpine.done();
  }
});

test("net-edit window closes on Escape and on canvas mousedown", async () => {
  const page = await bootTopology(responses);
  await tick();
  const box = page.doc.getElementById("net-edit");
  box.hidden = false;
  fire(page.doc, "keydown", { key: "Escape" });
  assert.ok(box.hidden, "Escape hides the window");
  box.hidden = false;
  fire(page.canvas, "mousedown", { button: 0, clientX: 400, clientY: 300 });
  assert.ok(box.hidden, "canvas press hides the window");
  box.hidden = false;
  fire(page.canvas, "mousedown", { button: 2, clientX: 400, clientY: 300 });
  assert.ok(!box.hidden, "right-button pan does not hide the window");
});

test("net-edit window can be dragged by its header, clamped to the canvas bounds", async () => {
  const page = await bootTopology(responses);
  await tick();
  const box = page.doc.getElementById("net-edit");
  box.hidden = false;
  box.style.left = "100px";
  box.style.top = "50px";
  fire(page.doc.getElementById("net-edit-header"), "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(page.doc, "mousemove", { clientX: 140, clientY: 130 });
  assert.equal(box.style.left, "140px", "window follows the cursor horizontally");
  assert.equal(box.style.top, "80px", "window follows the cursor vertically");
  // canvas is 1200x800 (see makeEl's default getBoundingClientRect); with no
  // real offsetWidth/offsetHeight in this DOM stub the drag falls back to
  // net-edit's fixed 520x560 size (topology.js's createFloatingPanel
  // fallbackW/fallbackH for #net-edit), clamping the window well short of
  // the far edge.
  fire(page.doc, "mousemove", { clientX: 5000, clientY: 5000 });
  assert.equal(box.style.left, "672px", "left clamped so the window stays on the canvas, margin kept on the far edge too");
  assert.equal(box.style.top, "232px", "top clamped so the window stays on the canvas, margin kept on the far edge too");
  fire(page.doc, "mouseup", {});
  fire(page.doc, "mousemove", { clientX: 999, clientY: 999 });
  assert.equal(box.style.left, "672px", "drag stops listening for mousemove after mouseup");
});

test("net-edit header mousedown on the close button does not start a drag", async () => {
  const page = await bootTopology(responses);
  await tick();
  const box = page.doc.getElementById("net-edit");
  box.hidden = false;
  box.style.left = "100px";
  box.style.top = "50px";
  fire(page.doc.getElementById("net-edit-close"), "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(page.doc, "mousemove", { clientX: 300, clientY: 300 });
  assert.equal(box.style.left, "100px", "close button press does not move the window");
  assert.equal(box.style.top, "50px", "close button press does not move the window");
});

test("net-edit save port applies update-network through the canvas sync queue", async () => {
  const page = await bootTopology(responses);
  await tick();
  const alpine = installNetEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y });
    fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
    const snapshot = await alpine.instance._savePort({ kind: "update-network", networkName: "net1", network: { name: "hq", subnets: ["a"] } });
    await tick();
    assert.ok(page.calls.some((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST"), "op posted by the canvas queue");
    assert.equal(page.get("State.topology.networks[0].name"), "hq", "canvas state updated");
    assert.equal(snapshot.topology.networks[0].name, "hq", "port resolves with the confirmed snapshot");
  } finally {
    alpine.done();
  }
});

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

// --- device-edit: ПКМ по устройству → «Редактировать» открывает плавающее окно устройства ---

// installDeviceEditAlpine зеркалит installNetEditAlpine для окна #device-edit
// и devicesPage.
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

test("right-click on a device offers Редактировать and opens the floating device-edit window with canvas data", async () => {
  const page = await bootTopology(responses);
  await tick();
  const alpine = installDeviceEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
    const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
    assert.ok(edit, "edit item present on a device");
    fire(edit, "click", {});
    assert.deepEqual(alpine.calls[0]?.slice(0, 2), ["openDeviceEdit", "r1"], "editor opened for the clicked device");
    assert.deepEqual(alpine.calls[0][2], { x: AT.r1.x, y: AT.r1.y }, "window anchored at the click point");
    assert.deepEqual(alpine.instance.devices, [
      { name: "r1", kind: "router", description: "", union: "" },
      { name: "r2", kind: "router", description: "", union: "" },
    ], "canvas devices injected");
    assert.deepEqual(alpine.instance.unions, [], "canvas unions injected");
    assert.equal(typeof alpine.instance._savePort, "function", "save routed through the canvas sync queue");
  } finally {
    alpine.done();
  }
});

test("editing a just-created device is unavailable until its create-device operation confirms", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.ids["tool-device"], "click", {});
  fire(page.canvas, "click", { clientX: 500, clientY: 400 });
  page.ids["node-name-input"].value = "r3";
  fire(page.ids["node-name-form"], "submit", {});
  fire(page.ids["tool-select"], "click", {});
  // синхронно, до оседания fetch-микротаска: create-device ещё в полёте
  fire(page.canvas, "contextmenu", { clientX: 500, clientY: 400 });
  const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(edit, "menu item still present");
  assert.ok(edit.disabled, "disabled while the create is still pending");
  await tick();
  fire(page.canvas, "contextmenu", { clientX: 500, clientY: 400 });
  const edit2 = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
  assert.ok(!edit2.disabled, "edit becomes available once the create confirms");
});

test("read-only tab: Редактировать on a device does not open the device-edit window", async () => {
  const roResponses = {
    "/api/versions/current/topology": { devices: [{ name: "r1", kind: "router" }], links: [], networks: [], sets: [], unions: [] },
    "/api/versions/current/subnets": { subnets: [] },
    "/api/versions/current/layout": {},
  };
  const page = await bootTopology(roResponses, null);
  await tick();
  const alpine = installDeviceEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
    const edit = findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать");
    assert.ok(edit, "menu item present");
    fire(edit, "click", {});
    assert.equal(alpine.calls.length, 0, "read-only tab never opens the editor");
  } finally {
    alpine.done();
  }
});

test("device-edit window closes on Escape and on canvas mousedown", async () => {
  const page = await bootTopology(responses);
  await tick();
  const box = page.doc.getElementById("device-edit");
  box.hidden = false;
  fire(page.doc, "keydown", { key: "Escape" });
  assert.ok(box.hidden, "Escape hides the window");
  box.hidden = false;
  fire(page.canvas, "mousedown", { button: 0, clientX: 400, clientY: 300 });
  assert.ok(box.hidden, "canvas press hides the window");
  box.hidden = false;
  fire(page.canvas, "mousedown", { button: 2, clientX: 400, clientY: 300 });
  assert.ok(!box.hidden, "right-button pan does not hide the window");
});

test("device-edit window can be dragged by its header, clamped to the canvas bounds", async () => {
  const page = await bootTopology(responses);
  await tick();
  const box = page.doc.getElementById("device-edit");
  box.hidden = false;
  box.style.left = "100px";
  box.style.top = "50px";
  fire(page.doc.getElementById("device-edit-header"), "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(page.doc, "mousemove", { clientX: 140, clientY: 130 });
  assert.equal(box.style.left, "140px", "window follows the cursor horizontally");
  assert.equal(box.style.top, "80px", "window follows the cursor vertically");
  fire(page.doc, "mousemove", { clientX: 5000, clientY: 5000 });
  assert.equal(box.style.left, "672px", "left clamped so the window stays on the canvas, margin kept on the far edge too");
  assert.equal(box.style.top, "412px", "top clamped so the window stays on the canvas, margin kept on the far edge too");
  fire(page.doc, "mouseup", {});
  fire(page.doc, "mousemove", { clientX: 999, clientY: 999 });
  assert.equal(box.style.left, "672px", "drag stops listening for mousemove after mouseup");
});

test("device-edit header mousedown on the close button does not start a drag", async () => {
  const page = await bootTopology(responses);
  await tick();
  const box = page.doc.getElementById("device-edit");
  box.hidden = false;
  box.style.left = "100px";
  box.style.top = "50px";
  fire(page.doc.getElementById("device-edit-close"), "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(page.doc, "mousemove", { clientX: 300, clientY: 300 });
  assert.equal(box.style.left, "100px", "close button press does not move the window");
  assert.equal(box.style.top, "50px", "close button press does not move the window");
});

test("device-edit save port applies update-device through the canvas sync queue", async () => {
  const page = await bootTopology(responses);
  await tick();
  const alpine = installDeviceEditAlpine(page);
  try {
    fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
    fire(findBtn(ctxMenu(page), (b) => String(b.textContent) === "Редактировать"), "click", {});
    const snapshot = await alpine.instance._savePort([{ kind: "update-device", deviceName: "r1", device: { name: "core-1", kind: "router" } }]);
    await tick();
    assert.ok(page.calls.some((c) => c.path === "/api/drafts/d1/topology/operations/batch" && c.method === "POST"), "batch posted by the canvas queue");
    assert.equal(page.get("State.topology.devices[0].name"), "core-1", "canvas state updated");
    assert.equal(snapshot.topology.devices[0].name, "core-1", "port resolves with the confirmed snapshot");
  } finally {
    alpine.done();
  }
});

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

test("read-only (no active draft) never persists edits: no operations POST, no local projection change", async () => {
  const roResponses = {
    "/api/versions/current/topology": { devices: [], links: [], networks: [], sets: [], unions: [] },
    "/api/versions/current/subnets": { subnets: [] },
    "/api/versions/current/layout": {},
  };
  const page = await bootTopology(roResponses, null);
  await tick();
  fire(page.ids["tool-device"], "click", {});
  fire(page.canvas, "click", { clientX: 300, clientY: 200 });
  page.ids["node-name-input"].value = "r3";
  fire(page.ids["node-name-form"], "submit", {});
  await tick();
  assert.ok(!page.calls.some((c) => c.method === "POST"), "read-only tab never posts an operation");
  assert.equal(page.get("State.topology.devices.length"), 0, "no local edit either — nothing to persist");
});

test("read-only topology disables editing tools and keeps select mode", async () => {
  const roResponses = {
    "/api/versions/current/topology": { devices: [], links: [], networks: [], sets: [], unions: [] },
    "/api/versions/current/subnets": { subnets: [] },
    "/api/versions/current/layout": {},
  };
  const page = await bootTopology(roResponses, null);
  await tick();

  for (const tool of ["select", "connect", "device", "network"]) {
    assert.equal(page.ids[`tool-${tool}`].disabled, true, `${tool} is disabled`);
    fire(page.ids[`tool-${tool}`], "click", {});
  }
  fire(page.doc, "keydown", { key: "c" });

  assert.equal(page.get("State.tool"), "select", "read-only mode cannot change the active tool");
});

// --- операции: точный состав отправленных команд ---

// postedOps returns every operation posted to the operations endpoint, in
// send order — whether sent individually or as part of an atomic batch
// (topology/operations/batch, flattened here to its `operations` list) —
// the queue drains strictly sequentially (topology_sync.js), so this is
// also the wire order.
const postedOps = (page) => page.calls
  .filter((c) => c.method === "POST" && (c.path === "/api/drafts/d1/topology/operations" || c.path === "/api/drafts/d1/topology/operations/batch"))
  .flatMap((c) => { const body = JSON.parse(c.body); return body.operations || [body]; });

test("attaching a device to a network sends attach-network", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      networks: [{ name: "net1", subnets: ["a"], attach: [] }],
    },
  });
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  clickNode(page, "net1");
  clickNode(page, "r2");
  await tick();
  assert.deepEqual(postedOps(page), [
    { kind: "attach-network", networkName: "net1", attach: { device: "r2" } },
  ]);
});

// Deleting a device together with its own link/attachment must not also
// send delete-link/detach-network for those — the server's delete-device
// cascade already drops them, and a redundant op would 422 ("unknown
// link"/"not attached"). See deleteSelection's ruling in topology.js.
test("deleting a device selected together with its link/attach sends only delete-device — no doomed follow-up ops", async () => {
  const page = await bootTopology(responses); // r1-r2 link, net1 attached to r1
  await tick();
  clickNode(page, "r1"); // select r1
  // select the link and the attachment alongside r1 directly on State.selection
  page.get(`
    (() => {
      const l = State.list.find((i) => i.id === "link:r1|r2").ref;
      const a = State.list.find((i) => i.id === "attach:net1|r1").ref;
      State.selection.add(l);
      State.selection.add(a);
    })()
  `);
  global.confirm = () => true;
  fire(page.ids["topo-delete"], "click", {});
  await tick();
  assert.deepEqual(postedOps(page), [
    { kind: "delete-device", deviceName: "r1" },
  ]);
});

test("deleting a link that does not involve a deleted device sends its own delete-link", async () => {
  const page = await bootTopology(responses); // r1-r2 link
  await tick();
  const p = page.get(`(() => {
    const s = State.list.find((i) => i.id === "link:r1|r2").geom.segs[0];
    return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
  })()`);
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y });
  fire(page.doc, "mouseup", {});
  global.confirm = () => true;
  fire(page.ids["topo-delete"], "click", {});
  await tick();
  assert.deepEqual(postedOps(page), [
    { kind: "delete-link", link: { a: { device: "r1" }, b: { device: "r2" } } },
  ]);
});

test("reassigning union membership sends remove-from-old then add-to-new", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      unions: [{ name: "a", devices: ["r1"] }, { name: "b", devices: [] }],
    },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const assignB = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("«b»"));
  fire(assignB, "click", {});
  await tick();
  assert.deepEqual(postedOps(page), [
    { kind: "union-remove-device", unionName: "a", deviceName: "r1" },
    { kind: "union-add-device", unionName: "b", deviceName: "r1" },
  ]);
});

// --- stale object references in context-menu closures (a publish happens
// between menu-open and menu-click: any node drag, or any other queued op
// confirming, synchronously swaps State.topology with fresh clone
// instances — see cloneSnapshot/TopologySync.publish) ---

test("context menu delete survives a publish that happened after the menu opened (stale object reference)", async () => {
  const page = await bootTopology(responses); // r1-r2 link, net1 attached to r1
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.net1.x, clientY: AT.net1.y }); // menu captures net1
  const del = findBtn(ctxMenu(page), (b) => String(b.textContent).startsWith("Удалить"));
  assert.ok(del, "delete item present");

  // A publish happens while the menu is still open: dragging r1 enqueues
  // set-device-position, which synchronously swaps State.topology with
  // freshly cloned instances, staling the net1 reference the menu's delete
  // item captured at build time.
  fire(page.canvas, "mousedown", { button: 0, clientX: AT.r1.x, clientY: AT.r1.y });
  fire(page.doc, "mousemove", { clientX: AT.r1.x + 20, clientY: AT.r1.y + 10 });
  fire(page.doc, "mouseup", {});

  fire(del, "click", {}); // must not throw, and must actually delete net1
  await tick();
  assert.ok(!texts(page.get).includes("net1"), "net1 actually removed, not silently dropped");
  assert.ok(
    postedOps(page).some((op) => op.kind === "delete-network" && op.networkName === "net1"),
    "delete-network op sent for net1",
  );
});

test("context menu union assignment survives a publish that happened after the menu opened (stale target index)", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      unions: [{ name: "a", devices: ["r1"] }, { name: "b", devices: [] }],
    },
  });
  await tick();
  fire(page.canvas, "contextmenu", { clientX: AT.r1.x, clientY: AT.r1.y });
  const assignB = findBtn(ctxMenu(page), (b) => String(b.textContent).includes("«b»"));
  assert.ok(assignB, "assign-to-b item present");

  // A publish happens while the menu is still open: dragging r2 enqueues
  // set-device-position, swapping State.topology.unions with fresh
  // instances, staling the target union object/index the menu captured.
  fire(page.canvas, "mousedown", { button: 0, clientX: AT.r2.x, clientY: AT.r2.y });
  fire(page.doc, "mousemove", { clientX: AT.r2.x + 20, clientY: AT.r2.y + 10 });
  fire(page.doc, "mouseup", {});

  fire(assignB, "click", {});
  await tick();
  assert.deepEqual(
    postedOps(page).filter((op) => op.kind.startsWith("union-")),
    [
      { kind: "union-remove-device", unionName: "a", deviceName: "r1" },
      { kind: "union-add-device", unionName: "b", deviceName: "r1" },
    ],
    "membership actually reassigned to b, not silently stripped from every union",
  );
});

test("dragging a node sends one coalesced set-device-position, not one per mousemove", async () => {
  const page = await bootTopology(responses);
  await tick();
  const p = AT.r1;
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y });
  fire(page.doc, "mousemove", { clientX: p.x + 10, clientY: p.y + 5 });
  fire(page.doc, "mousemove", { clientX: p.x + 25, clientY: p.y + 15 });
  fire(page.doc, "mousemove", { clientX: p.x + 40, clientY: p.y + 20 });
  fire(page.doc, "mouseup", {});
  await tick();
  const ops = postedOps(page);
  assert.equal(ops.length, 1, "one operation for the whole drag, not per mousemove");
  assert.equal(ops[0].kind, "set-device-position");
  assert.deepEqual(ops[0].deviceName, "r1");
  assert.deepEqual(ops[0].position, { x: 40 + 40, y: 40 + 20 }); // r1 starts at (40,40)
});

test("two quick drags queued before the first write resolves coalesce into a single trailing write", async () => {
  const page = await bootTopology(responses);
  await tick();
  const p = AT.r1;
  // First drag: enqueues and starts sending immediately (queue empties into
  // "sending" before this synchronous block ends).
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x, clientY: p.y });
  fire(page.doc, "mousemove", { clientX: p.x + 10, clientY: p.y + 10 });
  fire(page.doc, "mouseup", {});
  // Second and third drags happen before any microtask runs: both queue
  // while the first write is still in flight, so moveKey coalescing
  // (topology_sync.js) collapses them into one trailing operation.
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x + 10, clientY: p.y + 10 });
  fire(page.doc, "mousemove", { clientX: p.x + 20, clientY: p.y + 15 });
  fire(page.doc, "mouseup", {});
  fire(page.canvas, "mousedown", { button: 0, clientX: p.x + 20, clientY: p.y + 15 });
  fire(page.doc, "mousemove", { clientX: p.x + 35, clientY: p.y + 25 });
  fire(page.doc, "mouseup", {});
  await tick();
  const ops = postedOps(page);
  assert.equal(ops.length, 2, "first drag sends immediately, the next two coalesce into one trailing write");
  assert.equal(ops[1].position.x, 40 + 35, "final write carries the last queued position");
});

test("waypoint drag sends one coalesced set-link-waypoints, not one per mousemove", async () => {
  const page = await bootTopology(responses);
  await tick();
  fire(page.canvas, "dblclick", { clientX: LINK_MID.x, clientY: LINK_MID.y });
  await tick(); // the addWaypoint op's own write settles before dragging starts
  const before = postedOps(page).length; // addWaypoint already sent its own set-link-waypoints
  fire(page.canvas, "mousedown", { button: 0, clientX: LINK_MID.x, clientY: LINK_MID.y });
  fire(page.doc, "mousemove", { clientX: LINK_MID.x, clientY: LINK_MID.y - 10 });
  fire(page.doc, "mousemove", { clientX: LINK_MID.x, clientY: LINK_MID.y - 20 });
  fire(page.doc, "mousemove", { clientX: LINK_MID.x, clientY: LINK_MID.y - 30 });
  fire(page.doc, "mouseup", {});
  await tick();
  const ops = postedOps(page).slice(before);
  assert.equal(ops.length, 1, "drag itself sends one operation, not one per mousemove");
  assert.equal(ops[0].kind, "set-link-waypoints");
  assert.deepEqual(ops[0].link, { a: { device: "r1" }, b: { device: "r2" } });
});

// Ответ сервера — канонический источник истины: даже если клиент отправлял
// связи в одном порядке, ответ с иным (каноническим) порядком должен
// полностью заменить локальную проекцию, а не просто дополнить её — иначе
// массивный индекс (a не канонический ключ) снова стал бы нестабильной
// идентичностью связи (design spec).
test("the server's canonical response order replaces the client's local optimistic append order", async () => {
  const page = await bootTopology({
    ...responses,
    "/api/drafts/d1/topology": {
      ...responses["/api/drafts/d1/topology"],
      devices: [...responses["/api/drafts/d1/topology"].devices, { name: "r3", kind: "router" }],
    },
    "/api/drafts/d1/layout": { devices: { r1: { x: 40, y: 40 }, r2: { x: 240, y: 40 }, r3: { x: 440, y: 40 } }, networks: {}, links: {} },
    "/api/drafts/d1/topology/operations": (opts) => {
      const op = JSON.parse(opts.body);
      // Client applies create-link locally by appending; the server instead
      // hands back the new link FIRST (its own canonical sort) — the
      // confirmed order must win over the local append order.
      return {
        topology: {
          devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }, { name: "r3", kind: "router" }],
          links: [op.link, { a: { device: "r1" }, b: { device: "r2" } }],
          networks: [{ name: "net1", subnets: ["a"], attach: [{ device: "r1" }] }],
          sets: [], unions: [],
        },
        layout: { devices: { r1: { x: 40, y: 40 }, r2: { x: 240, y: 40 }, r3: { x: 440, y: 40 } }, networks: {}, links: {}, camera: null },
      };
    },
  });
  await tick();
  fire(page.ids["tool-connect"], "click", {});
  fire(page.canvas, "mousedown", { button: 0, clientX: 510, clientY: 70 }); // r3 center: box (440,40)+140x60
  fire(page.doc, "mouseup", {});
  fire(page.canvas, "mousedown", { button: 0, clientX: AT.r2.x, clientY: AT.r2.y });
  fire(page.doc, "mouseup", {});
  await tick();
  assert.deepEqual(
    page.get(`JSON.stringify(State.topology.links.map((l) => l.a.device + "-" + l.b.device))`),
    JSON.stringify(["r3-r2", "r1-r2"]),
    "confirmed order matches the server's response, not the client's local append order",
  );
});
})();
