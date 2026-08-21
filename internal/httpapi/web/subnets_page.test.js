"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Boots the subnets Alpine component outside a browser and exercises its
// validation and persistence logic against a stubbed fetch.

function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  const sandbox = {
    document: { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) },
    window: { dispatchEvent: notify },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent: notify,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (path_, opts) => {
      calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path_ === "/api/subnets") {
        return { ok: true, status: 200, json: async () => ({ subnets: calls.find((c) => c.method === "PUT")?.body.subnets || [] }) };
      }
      if (path_ === "/api/topology") {
        return { ok: true, status: 200, json: async () => ({ networks: [{ name: "net1", subnets: ["a"] }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Alpine: { data: (name, factory) => (factories[name] = factory) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "columns.js", "subnets.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.subnetsPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }) } };
  return { page, calls, banners };
}

test("draftHint flags empty fields, duplicates and CIDR overlaps", () => {
  const { page } = bootPage();
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
  const { page, calls } = bootPage();
  page.rows = [{ name: "a", cidr: "10.0.0.0/24", owner: "net1" }];
  page.draft = { index: -1, name: "b", cidr: "10.0.1.0/24" };

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/subnets" && c.method === "PUT");
  assert.deepEqual(put.body, { subnets: [{ name: "a", cidr: "10.0.0.0/24" }, { name: "b", cidr: "10.0.1.0/24" }] });
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].owner, "net1"); // owner refreshed from topology
  assert.ok(calls.some((c) => c.path === "dialog.close"));
});

test("saveDraft is blocked while the draft is invalid", async () => {
  const { page, calls } = bootPage();
  page.rows = [];
  page.draft = { index: -1, name: "", cidr: "" };

  await page.saveDraft();

  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("removeRow deletes after confirmation", async () => {
  const { page, calls } = bootPage();
  page.rows = [
    { name: "a", cidr: "10.0.0.0/24", owner: "" },
    { name: "b", cidr: "10.0.1.0/24", owner: "" },
  ];

  await page.removeRow(0);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { subnets: [{ name: "b", cidr: "10.0.1.0/24" }] });
});
