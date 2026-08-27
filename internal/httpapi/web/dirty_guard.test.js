"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM stub to run common.js outside a browser and exercise the
// DirtyGuard navigation interception.
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    className: "",
    classList: {
      add(c) { if (!el.className.split(" ").includes(c)) el.className += (el.className ? " " : "") + c; },
      remove(c) { el.className = el.className.split(" ").filter((x) => x !== c).join(" "); },
      contains(c) { return el.className.split(" ").includes(c); },
      toggle(c, force) {
        const has = this.contains(c);
        if (force === undefined ? !has : force) this.add(c);
        else this.remove(c);
      },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    prepend(...cs) { cs.reverse().forEach((c) => { c.parent = this; this.children.unshift(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    closest(selector) {
      let n = this;
      while (n) {
        if (selector === "nav.side-nav a" && n.tag === "a") return n;
        n = n.parent;
      }
      return null;
    },
  };
  return el;
}

function makeDoc() {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.documentElement = { dataset: {} };
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = (t, fn) => { (doc.body.listeners[t] ||= []).push(fn); };
  return doc;
}

function loadCommon({ confirmResult }) {
  const doc = makeDoc();
  const winListeners = {};
  const location = { href: "http://x/ui/topology" };
  const sandbox = {
    document: doc,
    window: { addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); }, location },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent() {},
    confirm: () => confirmResult,
    fetch: () => Promise.resolve({ ok: false }),
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  // top-level const bindings live in the context's lexical env, not on
  // globalThis; evaluate an expression to grab them
  const { DirtyGuard, buildNav } = vm.runInContext("({ DirtyGuard, buildNav })", sandbox);
  return { sandbox: { ...sandbox, DirtyGuard, buildNav }, doc, winListeners, location };
}

function fire(target, type, ev) {
  ev.type = type;
  ev.target = ev.target || target;
  ev.preventDefault ||= () => { ev.defaultPrevented = true; };
  ev.stopPropagation ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
}

// clickNavLink builds the shared sidebar and simulates a click on its first
// nav link (inside the first group), returning whether the default was prevented.
async function clickNavLink(ctx, doc) {
  await ctx.sandbox.buildNav("topology");
  const aside = doc.body.children[0];
  const nav = aside.children.find((n) => n.tag === "nav");
  let link = null;
  const walk = (n) => n.children.forEach((c) => (c.tag === "a" ? (link ||= c) : walk(c)));
  walk(nav);
  const ev = { target: link };
  fire(doc.body, "click", ev);
  return !!ev.defaultPrevented;
}

const noop = () => {};

test("clean page navigates without confirmation", async () => {
  const ctx = loadCommon({ confirmResult: false });
  const { DirtyGuard } = ctx.sandbox;
  const doc = makeDoc();
  DirtyGuard.arm(noop);
  DirtyGuard.markClean();
  assert.equal(DirtyGuard.isDirty(), false);
  assert.equal(await clickNavLink(ctx, ctx.doc), false, "navigation not blocked");
});

test("dirty page blocks navigation until confirmed", async () => {
  const ctx = loadCommon({ confirmResult: false });
  const { DirtyGuard } = ctx.sandbox;
  let data = { devices: [] };
  DirtyGuard.arm(() => data);
  DirtyGuard.markClean();
  data.devices.push({ name: "r1" });
  assert.equal(DirtyGuard.isDirty(), true);
  assert.equal(await clickNavLink(ctx, ctx.doc), true, "navigation blocked");
  assert.equal(ctx.location.href, "http://x/ui/topology", "no redirect happened");

  const ctxYes = loadCommon({ confirmResult: true });
  const dg2 = ctxYes.sandbox.DirtyGuard;
  let data2 = { devices: [] };
  dg2.arm(() => data2);
  dg2.markClean();
  data2.devices.push({ name: "r1" });
  await clickNavLink(ctxYes, ctxYes.doc); // default always prevented, redirect instead
  assert.equal(ctxYes.location.href, "/ui/topology", "confirmed navigation redirects to the clicked link");
});

test("markClean after save clears the dirty flag", () => {
  const ctx = loadCommon({ confirmResult: false });
  const { DirtyGuard } = ctx.sandbox;
  let data = { devices: [] };
  DirtyGuard.arm(() => data);
  DirtyGuard.markClean();
  data.devices.push({ name: "r1" });
  assert.equal(DirtyGuard.isDirty(), true);
  DirtyGuard.markClean();
  assert.equal(DirtyGuard.isDirty(), false);
});

test("unarmed guard never reports dirty", () => {
  const ctx = loadCommon({ confirmResult: false });
  assert.equal(ctx.sandbox.DirtyGuard.isDirty(), false);
});

test("beforeunload flags unsaved changes", () => {
  const ctx = loadCommon({ confirmResult: false });
  const { DirtyGuard } = ctx.sandbox;
  let data = { devices: [] };
  DirtyGuard.arm(() => data);
  DirtyGuard.markClean();
  const handlers = ctx.winListeners["beforeunload"] || [];
  assert.ok(handlers.length, "beforeunload handler registered");
  const ev = { preventDefault() {} };
  handlers.forEach((fn) => fn(ev));
  assert.equal(ev.returnValue, undefined, "clean page does not block unload");

  data.devices.push({ name: "r1" });
  const ev2 = { preventDefault() {} };
  handlers.forEach((fn) => fn(ev2));
  assert.equal(ev2.returnValue, "", "dirty page sets returnValue");
});
