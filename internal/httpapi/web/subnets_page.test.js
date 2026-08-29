"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Boots the subnets Alpine component outside a browser and exercises its
// validation and persistence logic against a stubbed fetch.

async function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const store = { "firenet-draft-id": "d1" };
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  global.document = { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) };
  global.window = { dispatchEvent: notify };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {};
  global.confirm = () => true;
  global.fetch = async (path_, opts) => {
    calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    if (path_ === "/api/drafts/d1/subnets") {
      return { ok: true, status: 200, json: async () => ({ subnets: calls.find((c) => c.method === "PUT")?.body.subnets || [] }) };
    }
    if (path_ === "/api/drafts/d1/topology") {
      return { ok: true, status: 200, json: async () => ({ networks: [{ name: "net1", subnets: ["a"] }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  // cache-busting: subnets.js регистрирует alpine:init при каждом импорте
  await import(path.join(__dirname, "subnets.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.subnetsPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }) } };
  return { page, calls, banners, store };
}

test("draftHint flags empty fields, duplicates and CIDR overlaps", async () => {
  const { page } = await bootPage();
  page.rows = [
    { name: "a", cidr: "10.0.0.0/24", owner: "" },
    { name: "b", cidr: "10.0.1.0/24", owner: "" },
  ];

  page.draft = { index: -1, name: "", cidr: "" };
  assert.match(page.draftHint, /Заполните/);

  page.draft = { index: -1, name: "a", cidr: "10.0.2.0/24" };
  assert.match(page.draftHint, /уже используется/);

  page.draft = { index: -1, name: "c", cidr: "10.0.0.0/16" };
  assert.match(page.draftHint, /Пересекается с a/);

  page.draft = { index: 0, name: "a", cidr: "10.0.0.0/24" };
  assert.equal(page.draftHint, "");
});

test("saveDraft appends a new subnet and persists the whole document", async () => {
  const { page, calls } = await bootPage();
  page.rows = [{ name: "a", cidr: "10.0.0.0/24", description: "офис", owner: "net1" }];
  page.draft = { index: -1, name: "b", cidr: "10.0.1.0/24", description: "гостевая" };

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/drafts/d1/subnets" && c.method === "PUT");
  assert.deepEqual(put.body, {
    subnets: [
      { name: "a", cidr: "10.0.0.0/24", description: "офис" },
      { name: "b", cidr: "10.0.1.0/24", description: "гостевая" },
    ],
  });
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].description, "офис"); // description survives persist
  assert.equal(page.rows[0].owner, "net1"); // owner refreshed from topology
  assert.ok(calls.some((c) => c.path === "dialog.close"));
});

test("saveDraft is blocked while the draft is invalid", async () => {
  const { page, calls } = await bootPage();
  page.rows = [];
  page.draft = { index: -1, name: "", cidr: "" };

  await page.saveDraft();

  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("filteredRows filters by name, cidr, owner and description substrings", async () => {
  const { page } = await bootPage();
  page.rows = [
    { name: "a", cidr: "10.0.0.0/24", owner: "net1", description: "офис" },
    { name: "b", cidr: "192.168.1.0/24", owner: "", description: "" },
  ];

  page.filters = { ...page.filters, name: "A" };
  assert.deepEqual(page.filteredRows.map((r) => r.row.name), ["a"]);

  page.filters = { ...page.filters, name: "", cidr: "192.168." };
  assert.deepEqual(page.filteredRows.map((r) => r.row.name), ["b"]);

  page.filters = { ...page.filters, cidr: "", owner: "NET" };
  assert.deepEqual(page.filteredRows.map((r) => r.row.name), ["a"]);

  page.filters = { ...page.filters, owner: "", description: "ФИС" };
  assert.deepEqual(page.filteredRows.map((r) => r.row.name), ["a"]);

  page.filters = { ...page.filters, description: "nope" };
  assert.deepEqual(page.filteredRows, []);

  page.resetFilters();
  assert.deepEqual(page.filteredRows.map((r) => r.row.name), ["a", "b"]);
});

test("removeRow deletes after confirmation", async () => {
  const { page, calls } = await bootPage();
  page.rows = [
    { name: "a", cidr: "10.0.0.0/24", owner: "" },
    { name: "b", cidr: "10.0.1.0/24", owner: "" },
  ];

  await page.removeRow(0);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { subnets: [{ name: "b", cidr: "10.0.1.0/24" }] });
});

test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootPage();
  delete store["firenet-draft-id"];
  page.rows = [];
  page.draft = { index: -1, name: "b", cidr: "10.0.1.0/24", description: "гостевая" };

  await page.saveDraft();

  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});
