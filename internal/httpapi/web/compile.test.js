"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, _text: "",
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent || "").join(""); },
  };
  return el;
}

function bootCompile(devicesResponse, draftID = "d1") {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  const ids = { "compile-run": makeEl("button"), "compile-output": makeEl("div") };
  doc.getElementById = (id) => ids[id];
  doc.createElement = (tag) => makeEl(tag);
  doc.listeners = {};
  doc.addEventListener = (t, fn) => (doc.listeners[t] ||= []).push(fn);
  const store = draftID ? { "firenet-draft-id": draftID } : {};
  const calls = [];
  const banners = [];
  const sandbox = {
    document: doc,
    window: { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    URL: { createObjectURL: () => "blob:stub" },
    Blob: class { constructor(parts) { this.parts = parts; } },
    fetch: async (url, opts) => {
      calls.push({ path: url, method: opts?.method });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => devicesResponse };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "compile.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());
  // common.js's own DOMContentLoaded listener kicks off the draft-banner
  // fetch as a page-load side effect (same as on every other page); clear
  // it here so `calls` reflects only what the click under test triggers.
  calls.length = 0;
  return { ids, calls, banners };
}

const devices = [{ Name: "r1", IPSetsScript: "ipset restore r1", RulesScript: "iptables r1" }];

test("compiles the active draft and renders per-device scripts", async () => {
  const { ids, calls } = bootCompile(devices, "d1");
  await ids["compile-run"].listeners.click[0]();
  assert.equal(calls[0].path, "/api/drafts/d1/compile");
  assert.equal(calls[0].method, "POST");
  assert.match(ids["compile-output"].textContent, /r1\.ipsets\.restore/);
  assert.match(ids["compile-output"].textContent, /r1\.rules\.sh/);
});

test("compiles the current version when read-only (no active draft)", async () => {
  const { ids, calls } = bootCompile(devices, null);
  await ids["compile-run"].listeners.click[0]();
  assert.equal(calls[0].path, "/api/versions/current/compile");
});

test("a compile error shows a banner instead of throwing", async () => {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  const ids = { "compile-run": makeEl("button"), "compile-output": makeEl("div") };
  doc.getElementById = (id) => ids[id];
  doc.createElement = (tag) => makeEl(tag);
  doc.listeners = {};
  doc.addEventListener = (t, fn) => (doc.listeners[t] ||= []).push(fn);
  const banners = [];
  const sandbox = {
    document: doc,
    window: { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k === "firenet-draft-id" ? "d1" : null),
      setItem() {},
      removeItem() {},
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    fetch: async () => ({ ok: false, status: 422, headers: { get: () => null }, json: async () => ({ error: "правило x: неизвестный src" }) }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "compile.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (doc.listeners["DOMContentLoaded"] || []).forEach((fn) => fn());

  await ids["compile-run"].listeners.click[0]();

  assert.ok(banners.some((b) => b.message.includes("неизвестный src")), "compile error surfaces as a banner");
  assert.equal(ids["compile-output"].children.length, 0, "output stays empty on failure");
});
