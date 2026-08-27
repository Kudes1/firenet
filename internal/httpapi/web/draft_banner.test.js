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

function loadCommon(store, opts = {}) {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.body.dataset = {};
  doc.createElement = (tag) => makeEl(tag);
  doc.addEventListener = () => {};
  const posted = [];
  const localStore = opts.localStore || {};
  const sandbox = {
    document: doc,
    window: { prompt: () => opts.promptResult, location: { reload() {} } },
    localStorage: {
      getItem: (k) => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = v; },
      removeItem: (k) => { delete localStore[k]; },
    },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, fetchOpts) => {
      if (fetchOpts?.method === "POST" && url === "/api/drafts") {
        posted.push({ url, body: JSON.parse(fetchOpts.body) });
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new-draft" }) };
      }
      if (url === "/api/versions?limit=1") {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: opts.versionID ?? 7 }] };
      }
      if (url.startsWith("/api/drafts/")) {
        if (opts.draftMissing) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: "not found" }) };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: "draft-1", name: opts.draftName ?? "office", status: opts.draftStatus ?? "open" }) };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  const { renderDraftBanner } = vm.runInContext("({ renderDraftBanner })", sandbox);
  return { renderDraftBanner, doc, posted, sandbox, localStore };
}

test("shows a read-only banner with the current version and an 'open draft' action", async () => {
  const { renderDraftBanner, doc } = loadCommon({}, { versionID: 7 });
  await renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-readonly");
  assert.equal(banner.children[0].textContent, "Только чтение — версия 7.");
});

test("the open-draft button creates a draft and stores its id", async () => {
  const { renderDraftBanner, doc, posted, sandbox } = loadCommon({}, { versionID: 7, promptResult: "my-changes" });
  await renderDraftBanner();
  const openBtn = doc.body.children[0].children[1];
  await openBtn.listeners.click[0]();
  assert.equal(posted[0].url, "/api/drafts");
  assert.equal(posted[0].body.name, "my-changes");
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), "new-draft");
});

test("shows an editing banner with the draft's name and status, and a 'return to current' action", async () => {
  const { renderDraftBanner, doc, sandbox } = loadCommon({ "firenet-draft-id": "draft-1" }, { draftName: "office", draftStatus: "open" });
  await renderDraftBanner();
  const banner = doc.body.children[0];
  assert.equal(banner.className, "draft-banner draft-banner-editing");
  assert.equal(banner.children[0].textContent, "Черновик «office» (open).");
  banner.children[1].listeners.click[0]();
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
});

test("falls back to read-only if the active draft no longer exists", async () => {
  const { renderDraftBanner, sandbox } = loadCommon({ "firenet-draft-id": "gone" }, { draftMissing: true });
  let reloaded = false;
  sandbox.window.location.reload = () => { reloaded = true; };
  await renderDraftBanner();
  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
  assert.ok(reloaded, "page reloads to pick up read-only state");
});

test("falls back to read-only if the active draft was merged in another tab", async () => {
  const { renderDraftBanner, sandbox, localStore } = loadCommon(
    {},
    { draftStatus: "merged", localStore: { "firenet-last-draft-id": "draft-1" } },
  );
  let reloaded = false;
  sandbox.window.location.reload = () => { reloaded = true; };

  await renderDraftBanner();

  assert.equal(sandbox.sessionStorage.getItem("firenet-draft-id"), null);
  assert.equal(localStore["firenet-last-draft-id"], undefined);
  assert.ok(reloaded, "page reloads to pick up read-only state");
});
