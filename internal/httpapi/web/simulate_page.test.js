"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM stub sufficient to boot simulate.js outside a browser and
// exercise the report rendering against a stubbed fetch.
function makeEl(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    dataset: {},
    style: {
      setProperty(k, v) { this[k] = v; },
      getPropertyValue(k) { return this[k] ?? null; },
    },
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

function texts(node) {
  const out = [];
  (function walk(n) {
    if (n._text) out.push(String(n._text));
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

const topoFixture = {
  devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
  links: [{ a: { device: "r1" }, b: { device: "r2" } }],
  networks: [{ name: "office", subnets: ["a"], attach: [{ device: "r1" }] }],
};

function bootSimulate(responses, savedStore) {
  const canvas = makeEl("svg");
  const ids = {};
  const calls = [];
  const store = { ...savedStore };
  const doc = {
    readyState: "loading",
    listeners: {},
    body: makeEl("body"),
    documentElement: { dataset: {} },
    createElementNS: (ns, tag) => makeEl(tag),
    createElement: (tag) => makeEl(tag),
    // stable registry: production code resolves widgets by id repeatedly
    getElementById: (id) => (id === "sim-canvas" ? canvas : (ids[id] ||= makeEl("div"))),
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
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent() {},
    confirm: () => false,
    FormData: class { get() { return ""; } },
    setTimeout,
    clearTimeout,
    Promise,
    console,
    // clone: production mutates loaded state, responses must stay pristine
    fetch: async (p, opts) => {
      calls.push({ path: p, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responses[p] ?? null)) };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "camera.js", "camera_input.js", "netmap.js", "net_info.js", "topo_scene.js", "simulate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { canvas, ids, calls, get, sandbox, doc, store };
}

const responses = {
  "/api/topology": topoFixture,
  "/api/subnets": { subnets: [{ name: "a", cidr: "10.0.0.0/24" }] },
  "/api/layout": {},
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
        { router: "r1", action: "allow", matchedRule: "office-to-dmz", reason: "правило разрешило" },
        { router: "r2", action: "allow", matchedRule: "office-to-dmz", reason: "правило разрешило" },
      ],
      verdict: "allow",
    },
  ],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const viewport = (canvas) => canvas.children.find((c) => c.attrs.class === "viewport");

test("wheel zooms around the cursor", async () => {
  const { canvas } = bootSimulate({
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

test("left-button drag pans the read-only map", async () => {
  const { canvas, doc } = bootSimulate(responses);
  await tick();
  fire(canvas, "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  assert.equal(viewport(canvas).attrs.transform, "translate(60 30) scale(1)");
});

test("camera changes are not persisted to /api/layout", async () => {
  const { canvas, doc, calls } = bootSimulate(responses);
  await tick();
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  fire(canvas, "mousedown", { button: 0, clientX: 100, clientY: 100 });
  fire(doc, "mousemove", { clientX: 160, clientY: 130 });
  fire(doc, "mouseup", {});
  await tick();
  assert.ok(!calls.some((c) => c.path === "/api/layout" && c.method === "PUT"), "read-only page never writes layout");
});

test("map matches the topology editor: subnet names and union frames", async () => {
  const { canvas } = bootSimulate({
    ...responses,
    "/api/topology": {
      devices: topoFixture.devices,
      links: topoFixture.links,
      networks: topoFixture.networks,
      unions: [{ name: "hq", devices: ["r1"], networks: ["office"] }],
    },
  });
  await tick();
  const html = JSON.stringify(canvas);
  assert.doesNotMatch(html, /10\.0\.0\.0\/24/, "subnet names, not CIDRs");
  assert.match(html, /union-frame/);
  assert.match(html, /"data-union":"hq"/);
  assert.match(html, /office/, "network label rendered");
});

const firstByClass = (node, cls) => {
  if (String(node.attrs.class || "").split(/\s+/).includes(cls)) return node;
  for (const c of node.children || []) {
    const hit = firstByClass(c, cls);
    if (hit) return hit;
  }
  return null;
};

test("clicking a network on the read-only map shows its subnets", async () => {
  const { canvas, ids } = bootSimulate(responses);
  await tick();
  const info = (ids["net-info"] ||= makeEl("div"));
  info.hidden = true;
  fire(firstByClass(canvas, "subnet-rect"), "click", {});
  assert.ok(!info.hidden, "network click opens the info window");
  const html = JSON.stringify(info);
  assert.match(html, /office/, "window titled with the network name");
  assert.match(html, /10\.0\.0\.0\/24/, "member CIDR listed");
  fire(canvas, "wheel", { clientX: 300, clientY: 200, deltaY: -120 });
  assert.ok(info.hidden, "zooming hides the window");
});

test("renderReport builds one card per path with verdict badges", async () => {
  const { ids, get } = bootSimulate(responses);
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(sampleReport)})`);
  const cards = ids["sim-paths"].children.filter((c) => c.className === "sim-path");
  assert.equal(cards.length, 1);
  const html = JSON.stringify(ids["sim-paths"]);
  assert.match(html, /badge-ok/);
  assert.match(html, /office-to-dmz/);
});

test("return verdict renders a neutral badge with FORWARD wording", async () => {
  const { ids, get } = bootSimulate(responses);
  await tick();
  const rep = JSON.parse(JSON.stringify(sampleReport));
  rep.paths[0].verdict = "return";
  rep.paths[0].routers[0].action = "return";
  rep.paths[0].routers[0].matchedRule = "bypass";
  get(`Simulate.renderReport(${JSON.stringify(rep)})`);
  const html = JSON.stringify(ids["sim-paths"]);
  assert.match(html, /badge-return/);
  assert.match(html, /возврат в FORWARD/);
});

test("unreachable report renders explicit message", async () => {
  const { ids, get } = bootSimulate(responses);
  await tick();
  get(`Simulate.renderReport(${JSON.stringify({ srcSubnet: "office", dstSubnet: "isolated", note: "", paths: [] })})`);
  assert.match(JSON.stringify(ids["sim-paths"]), /недостижим/i);
  assert.doesNotMatch(String(ids["sim-summary"]._text || ""), /\. $/);
});

test("summary line reports source, destination and path count", async () => {
  const { ids, get } = bootSimulate(responses);
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(sampleReport)})`);
  assert.ok(!ids["sim-summary"].hidden);
  assert.match(String(ids["sim-summary"]._text || ""), /office.*dmz.*путей 1/s);
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
  const { canvas, ids, get } = bootSimulate({ ...responses, "/api/topology": switchedTopo });
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(switchedReport)})`);
  const hl = get("Simulate.expandHighlight(Simulate.state.result, Simulate.state.topology)");
  for (const name of ["MAIN", "OFFICE", "sw1", "sw2", "r1", "r2"]) {
    assert.ok(hl.has(name), `${name} belongs to the highlighted path`);
  }
  assert.ok(!hl.has("lone"), "devices off the path stay unhighlighted");
  // DOM: only the lone switch, its wire and its labels remain dimmed
  const kids = viewport(canvas).children;
  const dimmed = kids.filter((c) => String(c.attrs.class || "").includes("sim-dim"));
  assert.equal(dimmed.filter((c) => c.tag === "line").length, 0, "attaches are lit");
  assert.equal(dimmed.filter((c) => String(c.attrs.class).startsWith("subnet-rect")).length, 0, "end networks are lit");
  assert.equal(dimmed.filter((c) => String(c.attrs.class).startsWith("wire")).length, 1, "only the off-path link is dimmed");
  assert.equal(dimmed.filter((c) => String(c.attrs.class).startsWith("node-rect")).length, 1, "only the off-path device is dimmed");
});

test("form submit posts to /api/simulate and renders the report", async () => {
  const { ids, calls } = bootSimulate({ ...responses, "/api/simulate": sampleReport });
  await tick();
  // form inputs are resolved by id at submit time; seed the registry
  for (const id of ["sim-src", "sim-dst", "sim-proto", "sim-dstports"]) ids[id] ||= makeEl("input");
  ids["sim-src"].value = "10.0.0.5";
  ids["sim-dst"].value = "10.0.1.7";
  ids["sim-proto"].value = "tcp";
  ids["sim-dstports"].value = "443, 8080";
  fire(ids["sim-form"], "submit", {});
  await tick();
  const post = calls.find((c) => c.path === "/api/simulate");
  assert.ok(post && post.method === "POST");
  assert.deepEqual(post.body, { src: "10.0.0.5", dst: "10.0.1.7", proto: "tcp", dstPorts: ["443", "8080"] });
  const cards = ids["sim-paths"].children.filter((c) => c.className === "sim-path");
  assert.equal(cards.length, 1, "report rendered after submit");
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

const allByClass = (node, cls) => {
  const out = [];
  const has = (n) => String(n.attrs.class || "").split(/\s+/).includes(cls);
  (function walk(n) {
    if (has(n)) out.push(n);
    (n.children || []).forEach(walk);
  })(node);
  return out;
};

test("expandFlow colors the route green up to the denying router", async () => {
  const { get } = bootSimulate({ ...responses, "/api/topology": switchedTopo });
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(denyReport)})`);
  const f = get("Simulate.expandFlow(Simulate.state.result, Simulate.state.topology)");
  for (const name of ["MAIN", "sw1", "r1"]) assert.ok(f.ok.has(name), `${name} is before the deny point`);
  assert.ok(!f.ok.has("r2"), "denying router itself is not green");
  assert.ok(!f.ok.has("OFFICE"), "destination beyond deny stays unlit");
  assert.deepEqual([...f.deny.keys()], ["r2"]);
  assert.equal(f.deny.get("r2").rule, "block-office");
});

test("allowed path lights the whole route including destination", async () => {
  const { get } = bootSimulate({ ...responses, "/api/topology": switchedTopo });
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(switchedReport)})`);
  const f = get("Simulate.expandFlow(Simulate.state.result, Simulate.state.topology)");
  for (const name of ["MAIN", "sw1", "r1", "r2", "sw2", "OFFICE"]) {
    assert.ok(f.ok.has(name), `${name} is on an allowed route`);
  }
  assert.equal(f.deny.size, 0);
});

test("a denying router never turns green, even via another allowed path", async () => {
  const rep = JSON.parse(JSON.stringify(denyReport));
  rep.paths.push(JSON.parse(JSON.stringify(switchedReport.paths[0])));
  const { get } = bootSimulate({ ...responses, "/api/topology": switchedTopo });
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(rep)})`);
  const f = get("Simulate.expandFlow(Simulate.state.result, Simulate.state.topology)");
  assert.ok(f.deny.has("r2"), "deny verdict wins on the shared route");
  assert.ok(!f.ok.has("r2") && !f.ok.has("OFFICE"), "denied elements are not green");
});

test("map paints flow segments and marks the deny point with a tooltip", async () => {
  const { canvas, get } = bootSimulate({ ...responses, "/api/topology": switchedTopo });
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(denyReport)})`);
  const okWires = allByClass(canvas, "sim-flow-ok");
  assert.ok(okWires.some((w) => w.tag === "path"), "wires up to the deny point are green");
  assert.ok(okWires.some((w) => w.tag === "line"), "attaches up to the deny point are green");
  const denied = allByClass(canvas, "sim-flow-deny");
  const rects = denied.filter((n) => n.tag === "rect");
  assert.equal(rects.length, 1, "exactly one device carries the deny marker");
  const title = (rects[0].children || []).find((c) => c.tag === "title");
  assert.ok(title, "deny device has a tooltip");
  assert.match(String(title._text || ""), /block-office/, "tooltip names the rule");
});

// — разделитель «форма ↔ карта» —

test("clampFormWidth keeps the panel between its bounds", async () => {
  const { get } = bootSimulate(responses);
  await tick();
  const clamp = (w, total) => get(`Simulate.clampFormWidth(${w}, ${total})`);
  assert.equal(clamp(100, 1200), 320);
  assert.equal(clamp(5000, 1200), 864);
  assert.equal(clamp(420.6, 1200), 421);
});

test("splitter drag resizes the form panel and persists the width", async () => {
  const { ids, doc, store } = bootSimulate(responses);
  await tick();
  fire(ids["sim-splitter"], "mousedown", { button: 0, clientX: 600 });
  fire(doc, "mousemove", { clientX: 700 });
  fire(doc, "mouseup", {});
  assert.equal(ids["sim-layout"].style["--sim-form-w"], "520px");
  assert.equal(JSON.parse(store["firenet-sim-split-v1"]), 520);
});

test("saved panel width is restored on boot", async () => {
  const { ids } = bootSimulate(responses, { "firenet-sim-split-v1": JSON.stringify(600) });
  await tick();
  assert.equal(ids["sim-layout"].style["--sim-form-w"], "600px");
});

test("double click resets the splitter to the default width", async () => {
  const { ids, store } = bootSimulate(responses, { "firenet-sim-split-v1": JSON.stringify(600) });
  await tick();
  fire(ids["sim-splitter"], "dblclick", {});
  assert.equal(ids["sim-layout"].style["--sim-form-w"], "420px");
  assert.ok(!("firenet-sim-split-v1" in store));
});
