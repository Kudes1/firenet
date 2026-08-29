"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

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

async function bootDrafts(fixture = {}) {
  const drafts = fixture.drafts ?? [{ id: "d1", owner: "alice", name: "office", baseVersion: 5, status: "open" }];
  const me = fixture.me ?? { username: "alice", role: "user" };
  const diffs = fixture.diffs ?? [{ kind: "subnet", key: "a", change: "modified", conflict: false }];
  const confirmStatus = fixture.confirmStatus ?? 200;
  const confirmBody = fixture.confirmBody ?? (confirmStatus === 409 ? { conflicts: [{ kind: "subnet", key: "a" }] } : { version: 6 });

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
  global.document = doc;
  global.window = { location, dispatchEvent: (e) => { if (e.type === "notify") banners.push(e.detail); } };
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
    if (url.startsWith("/api/drafts/") && url.endsWith("/diff")) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => diffs };
    }
    if (url.startsWith("/api/drafts/") && url.endsWith("/confirm")) {
      return { ok: confirmStatus === 200, status: confirmStatus, headers: { get: () => null }, json: async () => confirmBody };
    }
    if (opts?.method === "DELETE") {
      return { ok: true, status: 204, headers: { get: () => null }, json: async () => null };
    }
    if (opts?.method === "POST" && url === "/api/drafts") {
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: "new", owner: "alice", name: JSON.parse(opts.body).name, baseVersion: 5, status: "open" }) };
    }
    if (url.startsWith("/api/drafts")) {
      if (fixture.draftsFail) {
        return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: "boom" }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => drafts };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  // cache-busting: drafts.js подписывается на DOMContentLoaded при каждом импорте
  const { Drafts } = await import(path.join(__dirname, "drafts.js") + `?t=${Date.now()}-${Math.random()}`);
  return { get: (expr) => new Function("Drafts", `return (${expr});`)(Drafts), ids, calls, banners, store, location };
}

test("boot loads the user and the drafts list", async () => {
  const { get } = await bootDrafts();
  await get("Drafts.boot()");
  assert.equal(get("Drafts.me").role, "user");
  assert.equal(get("Drafts.drafts").length, 1);
});

test("the all-drafts toggle is hidden for a non-admin, shown for an admin", async () => {
  const nonAdmin = await bootDrafts({ me: { username: "alice", role: "user" } });
  await nonAdmin.get("Drafts.boot()");
  assert.equal(nonAdmin.ids["all-toggle"].hidden, true);

  const admin = await bootDrafts({ me: { username: "root", role: "admin" } });
  await admin.get("Drafts.boot()");
  assert.equal(admin.ids["all-toggle"].hidden, false);
});

test("selectDraft stores the draft id in session storage and navigates to topology", async () => {
  const { get, store, location } = await bootDrafts();
  get(`Drafts.selectDraft({ id: "d1", name: "office", status: "open" })`);
  assert.equal(store["firenet-draft-id"], "d1");
  assert.equal(location.href, "/ui/topology");
});

test("loadDiff fetches the draft's diff and hides confirm for a non-admin", async () => {
  const { get, ids } = await bootDrafts();
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  assert.equal(get("Drafts.diffs").length, 1);
  assert.equal(get("Drafts.diffs")[0].key, "a");
  assert.equal(ids["confirm-btn"].hidden, true, "confirm hidden without an admin boot");
});

test("confirmSelected on success clears the selection and shows the new version", async () => {
  const { get, banners } = await bootDrafts({ confirmStatus: 200 });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(get("Drafts.selected"), null);
  assert.ok(banners.some((b) => b.message.includes("версия 6")));
});

test("confirmSelected on success clears this tab's active draft id when it matches the confirmed draft", async () => {
  const { get, store } = await bootDrafts({ confirmStatus: 200 });
  store["firenet-draft-id"] = "d1";
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(store["firenet-draft-id"], undefined, "tab must drop out of the now-merged draft");
});

test("confirmSelected on success leaves a different tab's active draft id untouched", async () => {
  const { get, store } = await bootDrafts({ confirmStatus: 200 });
  store["firenet-draft-id"] = "other-draft";
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  await get("Drafts.confirmSelected()");
  assert.equal(store["firenet-draft-id"], "other-draft");
});

test("confirmSelected on a 409 conflict keeps the diff open, reloads it, and refreshes the table", async () => {
  const { get, banners } = await bootDrafts({ confirmStatus: 409 });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  assert.equal(get("Drafts.drafts").length, 0, "table not yet loaded before the confirm attempt");
  await get("Drafts.confirmSelected()");
  assert.equal(get("Drafts.selected").id, "d1");
  assert.ok(banners.some((b) => b.message.includes("конфликт")));
  assert.equal(get("Drafts.drafts").length, 1, "status column refreshed after pgstore marks the draft conflicted");
});

test("confirmSelected on a non-conflict 409 shows the error and does not reload the diff", async () => {
  const { get, banners, calls } = await bootDrafts({
    confirmStatus: 409,
    confirmBody: { error: "версия черновика устарела" },
  });
  await get(`Drafts.loadDiff({ id: "d1", name: "office" })`);
  const diffCallsBefore = calls.filter((c) => c.path === "/api/drafts/d1/diff").length;
  await get("Drafts.confirmSelected()");
  assert.ok(banners.some((b) => b.message.includes("версия черновика устарела")));
  assert.ok(!banners.some((b) => b.message.includes("конфликт")), "must not claim a conflict that isn't one");
  const diffCallsAfter = calls.filter((c) => c.path === "/api/drafts/d1/diff").length;
  assert.equal(diffCallsAfter, diffCallsBefore, "no conflicts to show, so the diff isn't reloaded");
});

test("refresh shows a banner when loading the drafts list fails", async () => {
  const { get, banners } = await bootDrafts({ draftsFail: true });
  await get("Drafts.refresh()");
  assert.ok(banners.some((b) => b.message.includes("Не удалось загрузить список черновиков")));
});

test("deleteDraft asks for confirmation and is a no-op when declined", async () => {
  const { get, calls } = await bootDrafts({ confirmResult: false });
  await get(`Drafts.deleteDraft("d1")`);
  assert.ok(!calls.some((c) => c.method === "DELETE"), "declining the confirm must not delete");
});

test("deleteDraft clears a matching active draft id and refreshes", async () => {
  const { get, store } = await bootDrafts();
  store["firenet-draft-id"] = "d1";
  await get(`Drafts.deleteDraft("d1")`);
  assert.equal(store["firenet-draft-id"], undefined);
});

test("createDraft posts the name and refreshes the list", async () => {
  const { get, calls } = await bootDrafts();
  await get(`Drafts.createDraft("new-work")`);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/api/drafts"));
});
