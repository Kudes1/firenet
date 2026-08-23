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

const topoFixture = {
  devices: [{ name: "r1", kind: "router" }, { name: "r2", kind: "router" }],
  links: [{ a: { device: "r1" }, b: { device: "r2" } }],
  networks: [{ name: "office", subnets: ["a"], attach: [{ device: "r1" }] }],
};

function bootSimulate(responses) {
  const canvas = makeEl("svg");
  const ids = {};
  const calls = [];
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
  for (const f of ["common.js", "camera.js", "netmap.js", "simulate.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { canvas, ids, calls, get, sandbox };
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

test("unreachable report renders explicit message", async () => {
  const { ids, get } = bootSimulate(responses);
  await tick();
  get(`Simulate.renderReport(${JSON.stringify({ srcSubnet: "office", dstSubnet: "isolated", note: "", paths: [] })})`);
  assert.match(JSON.stringify(ids["sim-paths"]), /недостижим/i);
});

test("summary line reports source, destination and path count", async () => {
  const { ids, get } = bootSimulate(responses);
  await tick();
  get(`Simulate.renderReport(${JSON.stringify(sampleReport)})`);
  assert.ok(!ids["sim-summary"].hidden);
  assert.match(String(ids["sim-summary"]._text || ""), /office.*dmz.*путей 1/s);
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
