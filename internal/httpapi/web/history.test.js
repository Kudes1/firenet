"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, hidden: false, _text: "",
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent || "").join(""); },
  };
  return el;
}

async function bootHistory(fixture = {}) {
  const versions = fixture.versions ?? [
    { id: 5, createdAt: "2026-08-27T00:00:00Z", confirmedBy: "alice", note: "" },
    { id: 4, createdAt: "2026-08-26T00:00:00Z", confirmedBy: "alice", note: "" },
    { id: 3, createdAt: "2026-08-25T00:00:00Z", confirmedBy: "alice", note: "" },
  ];
  const me = fixture.me ?? { username: "root", role: "admin" };
  const diffs = fixture.diffs ?? [{ kind: "subnet", key: "a", change: "modified" }];
  const restoreVersion = fixture.restoreVersion ?? 6;

  const tbody = makeEl("tbody");
  const ids = {
    "history-table": Object.assign(makeEl("table"), { querySelector: () => tbody }),
    "diff-panel": makeEl("section"),
    "diff-version-label": makeEl("span"),
    "diff-body": makeEl("tbody"),
  };
  const doc = {
    listeners: {},
    getElementById: (id) => ids[id],
    createElement: (tag) => makeEl(tag),
    addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
  };
  const store = {};
  const calls = [];
  const banners = [];
  global.document = doc;
  global.window = { dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  global.confirm = () => fixture.confirmResult ?? true;
  global.fetch = async (url, opts) => {
    calls.push({ path: url, method: opts?.method || "GET" });
    if (url === "/api/me") return { ok: true, status: 200, headers: { get: () => null }, json: async () => me };
    if (url === "/api/versions?limit=50") {
      if (fixture.versionsFail) {
        return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: "boom" }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => versions };
    }
    if (url.startsWith("/api/versions/diff")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => diffs };
    if (/^\/api\/versions\/\d+\/restore$/.test(url)) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: restoreVersion }) };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  // cache-busting: history.js подписывается на DOMContentLoaded при каждом импорте
  const { History } = await import(path.join(__dirname, "history.js") + `?t=${Date.now()}-${Math.random()}`);
  return { get: (expr) => new Function("History", `return (${expr});`)(History), ids, calls, banners, store };
}

test("boot loads the user and the version list", async () => {
  const { get } = await bootHistory();
  await get("History.boot()");
  assert.equal(get("History.me").role, "admin");
  assert.equal(get("History.versions").length, 3);
});

test("showDiff compares a version to the immediately older one in the list", async () => {
  const { get, calls } = await bootHistory();
  await get("History.boot()");
  await get("History.showDiff(4)");
  assert.ok(calls.some((c) => c.path === "/api/versions/diff?from=3&to=4"));
  assert.equal(get("History.diffs").length, 1);
});

test("showDiff on the oldest listed version diffs it against itself (nothing older known)", async () => {
  const { get, calls } = await bootHistory();
  await get("History.boot()");
  await get("History.showDiff(3)");
  assert.ok(calls.some((c) => c.path === "/api/versions/diff?from=3&to=3"));
});

test("restore controls render only for an admin", async () => {
  const nonAdmin = await bootHistory({ me: { username: "alice", role: "user" } });
  await nonAdmin.get("History.boot()");
  const naRow = nonAdmin.ids["history-table"].querySelector().children[0];
  assert.equal(naRow.children[4].children.length, 1, "non-admin sees only the diff button");

  const admin = await bootHistory({ me: { username: "root", role: "admin" } });
  await admin.get("History.boot()");
  const adminRow = admin.ids["history-table"].querySelector().children[0];
  assert.equal(adminRow.children[4].children.length, 2, "admin sees diff + restore buttons");
});

test("restore posts to /api/versions/{id}/restore, clears the active draft, and refreshes", async () => {
  const { get, store, banners, calls } = await bootHistory({ restoreVersion: 6 });
  store["firenet-draft-id"] = "d1";
  await get("History.boot()");
  await get("History.restore(3)");
  assert.ok(calls.some((c) => c.path === "/api/versions/3/restore" && c.method === "POST"));
  assert.equal(store["firenet-draft-id"], undefined);
  assert.ok(banners.some((b) => b.message.includes("версия 6")));
});

test("restore is a no-op when the confirmation dialog is declined", async () => {
  const { get, calls } = await bootHistory({ confirmResult: false });
  await get("History.boot()");
  await get("History.restore(3)");
  assert.ok(!calls.some((c) => c.path === "/api/versions/3/restore"));
});

test("refresh shows a banner when loading the version list fails", async () => {
  const { get, banners } = await bootHistory({ versionsFail: true });
  await get("History.refresh()");
  assert.ok(banners.some((b) => b.message.includes("Не удалось загрузить историю версий")));
});
