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
    classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    append(...cs) { this.children.push(...cs); },
    prepend(...cs) { this.children.unshift(...cs); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text || ""; },
    reset() {},
  };
}

function bootTopology(responses) {
  const canvas = makeEl("svg");
  const doc = {
    readyState: "loading",
    listeners: {},
    body: makeEl("body"),
    documentElement: { dataset: {} },
    createElementNS: (ns, tag) => makeEl(tag),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (id === "topo-canvas" ? canvas : makeEl("div")),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
  };
  const sandbox = {
    document: doc,
    window: {},
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
    fetch: async (p) => ({ ok: true, status: 200, json: async () => responses[p] }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "topology.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  return canvas;
}

function count(node) {
  return (node.children || []).reduce((acc, c) => acc + count(c), 1);
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
  },
  "/api/subnets": { subnets: [{ name: "a", cidr: "10.0.0.0/24" }] },
  "/api/layout": {},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("topology renders devices, links and networks without errors", async () => {
  const canvas = bootTopology(responses);
  await tick();
  const rendered = texts(canvas);
  assert.ok(rendered.includes("r1 (router)"), "device r1 rendered");
  assert.ok(rendered.includes("r2 (router)"), "device r2 rendered");
  assert.ok(rendered.includes("net1"), "network node rendered");
  assert.ok(rendered.includes("10.0.0.0/24"), "subnet cidr shown on network node");
  assert.ok(canvas.attrs.width > 0 && canvas.attrs.height > 0, "canvas sized after render");
});

test("topology tolerates empty project", async () => {
  const canvas = bootTopology({
    "/api/topology": { devices: [], links: [], networks: [] },
    "/api/subnets": { subnets: [] },
    "/api/layout": {},
  });
  await tick();
  assert.ok(count(canvas) > 0, "canvas element exists");
});
