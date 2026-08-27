"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, attrs: {}, className: "", hidden: false, _text: "",
    classList: { add(c) { if (!el.className.split(" ").filter(Boolean).includes(c)) el.className = (el.className + " " + c).trim(); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent || "").join(""); },
  };
  return el;
}

function bootDrafts(fixture = {}) {
  const drafts = fixture.drafts ?? [{ id: "d1", owner: "alice", name: "office", baseVersion: 5, status: "open" }];
  const me = fixture.me ?? { username: "alice", role: "user" };
  const diffs = fixture.diffs ?? [{ kind: "subnet", key: "a", change: "modified", conflict: false }];
  const confirmStatus = fixture.confirmStatus ?? 200;

  const tbody = makeEl("tbody");
  const ids = {
    "drafts-table": Object.assign(makeEl("table"), { querySelector: () => tbody }),
    "all-toggle": makeEl("label"),
    "all-checkbox": makeEl("input"),
    "create-draft-form": Object.assign(makeEl("form"), { name: { value: "" }, reset() { this.name.value = ""; } }),
    "diff-panel": makeEl("section"),
    "diff-draft-name": makeEl("span"),
    "diff-body": makeEl("tbody"),
    "confirm-btn": makeEl("button"),
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
  const location = { href: "" };
  const sandbox = {
    document: doc,
    window: { location, dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    fetch: async (url, opts) => {
      calls.push({ path: url, method: opts?.method || "GET" });
      if (url === "/api/me") return { ok: true, status: 200, headers: { get: () => null }, json: async () => me };
      if (url.startsWith("/api/drafts/") && url.endsWith("/diff")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => diffs };
      }
      if (url.startsWith("/api/drafts/") && url.endsWith("/confirm")) {
        if (confirmStatus === 409) {
          return { ok: false, status: 409, headers: { get: () => null }, json: async () => ({ conflicts: [{ kind: "subnet", key: "a" }] }) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ version: 6 }) };
      }
      if (opts?.method === "DELETE") {
        return { ok: true, status: 204, headers: { get: () => null }, json: async () => null };
      }
      if (opts?.method === "POST" && url === "/api/drafts") {
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new", owner: "alice", name: JSON.parse(opts.body).name, baseVersion: 5, status: "open" }) };
      }
      if (url.startsWith("/api/drafts")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => drafts };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "drafts.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  return { get: (expr) => vm.runInContext(expr, sandbox), ids, calls, banners, store, location };
}

test("boot loads the user and the drafts list", async () => {
  const { get } = bootDrafts();
  await get("Drafts.boot()");
  assert.equal(get("Drafts.me").role, "user");
  assert.equal(get("Drafts.drafts").length, 1);
});

test("the all-drafts toggle is hidden for a non-admin, shown for an admin", async () => {
  const nonAdmin = bootDrafts({ me: { username: "alice", role: "user" } });
  await nonAdmin.get("Drafts.boot()");
  assert.equal(nonAdmin.ids["all-toggle"].hidden, true);

  const admin = bootDrafts({ me: { username: "root", role: "admin" } });
  await admin.get("Drafts.boot()");
  assert.equal(admin.ids["all-toggle"].hidden, false);
});

test("selectDraft stores the draft id in session storage and navigates to topology", () => {
  const { get, store, location } = bootDrafts();
  get(`Drafts.selectDraft({ id: "d1", name: "office", status: "open" })`);
  assert.equal(store["firenet-draft-id"], "d1");
  assert.equal(location.href, "/ui/topology");
});

test("loadDiff fetches the draft's diff and hides confirm for a non-admin", async () => {
  const { get, ids } = bootDrafts();
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  assert.equal(get("Drafts.diffs").length, 1);
  assert.equal(get("Drafts.diffs")[0].key, "a");
  assert.equal(ids["confirm-btn"].hidden, true, "confirm hidden without an admin boot");
});

test("confirmSelected on success clears the selection and shows the new version", async () => {
  const { get, banners } = bootDrafts({ confirmStatus: 200 });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(get("Drafts.selected"), null);
  assert.ok(banners.some((b) => b.message.includes("версия 6")));
});

test("confirmSelected on a 409 keeps the diff open and reloads it", async () => {
  const { get, banners } = bootDrafts({ confirmStatus: 409 });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(get("Drafts.selected").id, "d1");
  assert.ok(banners.some((b) => b.message.includes("конфликт")));
});

test("deleteDraft clears a matching active draft id and refreshes", async () => {
  const { get, store } = bootDrafts();
  store["firenet-draft-id"] = "d1";
  await get(`Drafts.deleteDraft("d1")`);
  assert.equal(store["firenet-draft-id"], undefined);
});

test("createDraft posts the name and refreshes the list", async () => {
  const { get, calls } = bootDrafts();
  await get(`Drafts.createDraft("new-work")`);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/api/drafts"));
});
