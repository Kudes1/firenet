"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, className: "", _text: "",
    classList: {
      add(c) { if (!el.className.split(" ").includes(c)) el.className += (el.className ? " " : "") + c; },
    },
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    prepend(...cs) { cs.reverse().forEach((c) => { c.parent = this; this.children.unshift(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
  };
  return el;
}

function loadCommon(store, promptResult) {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = () => {};
  const posted = [];
  const sandbox = {
    document: doc,
    window: { prompt: () => promptResult, location: { reload() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, opts) => {
      posted.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new-draft" }) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  const { renderDraftBanner } = vm.runInContext("({ renderDraftBanner })", sandbox);
  return { renderDraftBanner, doc, posted, sandbox };
}

test("shows a read-only banner with an 'open draft' action when no draft is active", () => {
  const { renderDraftBanner, doc } = loadCommon({});
  renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-readonly");
  assert.equal(banner.children[0].textContent, "Только чтение — текущая подтверждённая версия.");
});

test("the open-draft button creates a draft and stores its id", async () => {
  const { renderDraftBanner, doc, posted, sandbox } = loadCommon({}, "my-changes");
  renderDraftBanner();
  const openBtn = doc.body.children[0].children[1];
  await openBtn.listeners.click[0]();
  assert.equal(posted[0].url, "/api/drafts");
  assert.equal(posted[0].body.name, "my-changes");
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), "new-draft");
});

test("shows an editing banner with a 'return to current' action when a draft is active", () => {
  const { renderDraftBanner, doc, sandbox } = loadCommon({ "firenet-draft-id": "draft-1" });
  renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-editing");
  banner.children[1].listeners.click[0]();
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
});
