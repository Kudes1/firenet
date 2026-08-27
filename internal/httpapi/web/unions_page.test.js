"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Boots the unions Alpine component outside a browser and exercises its
// validation, filtering and persistence logic against a stubbed fetch.

function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  const topoFixture = {
    devices: [{ name: "r1", kind: "router" }],
    links: [],
    networks: [{ name: "office", subnets: ["a"], attach: [{ device: "r1" }] }],
    sets: [{ name: "blocked", subnets: ["a"], addresses: ["10.0.0.9"] }],
    unions: [{ name: "hq", devices: ["r1"], networks: ["office"], description: "главный" }],
  };
  const sandbox = {
    document: { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) },
    window: { dispatchEvent: notify },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    dispatchEvent: notify,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (path_, opts) => {
      calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path_ === "/api/topology") {
        return { ok: true, status: 200, json: async () => calls.find((c) => c.method === "PUT")?.body || topoFixture };
      }
      if (path_ === "/api/subnets") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ subnets: [{ name: "a", cidr: "10.0.0.0/24" }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Alpine: { data: (name, factory) => (factories[name] = factory) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "columns.js", "unions.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.unionsPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }) } };
  return { page, calls, banners };
}

async function bootLoadedPage() {
  const ctx = bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads unions from the topology", async () => {
  const { page } = await bootLoadedPage();
  assert.equal(page.unions.length, 1);
  assert.equal(page.unions[0].name, "hq");
  assert.deepEqual([...page.unions[0].devices], ["r1"]);
  assert.deepEqual([...page.unions[0].networks], ["office"]);
  assert.equal(page.unions[0].description, "главный");
  assert.equal(page.loaded, true);
});

test("draftHint requires a unique non-empty name", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "", description: "" };
  assert.match(page.draftHint, /Укажите имя/);

  page.draft = { index: -1, name: "hq", description: "" };
  assert.match(page.draftHint, /уже используется/);

  page.draft = { index: 0, name: "hq", description: "" };
  assert.equal(page.draftHint, "");
});

test("saveDraft adds a union and preserves the rest of the topology verbatim", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: -1, name: "dmz", description: "периметр" };

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/topology" && c.method === "PUT");
  assert.deepEqual(put.body.devices, [{ name: "r1", kind: "router" }]);
  assert.deepEqual(put.body.links, []);
  assert.deepEqual(put.body.networks, [{ name: "office", subnets: ["a"], attach: [{ device: "r1" }] }]);
  assert.deepEqual(put.body.sets, [{ name: "blocked", subnets: ["a"], addresses: ["10.0.0.9"] }]);
  assert.deepEqual(put.body.unions, [
    { name: "hq", devices: ["r1"], networks: ["office"], description: "главный" },
    { name: "dmz", devices: [], networks: [], description: "периметр" },
  ]);
  assert.ok(calls.some((c) => c.path === "dialog.close"));
});

test("saveDraft renames without touching membership assigned on the canvas", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: 0, name: "headquarters", description: "" };

  await page.saveDraft();

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.unions, [{ name: "headquarters", devices: ["r1"], networks: ["office"] }]);
});

test("removeUnion deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.removeUnion(0);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.unions, []);
});

test("filteredUnions matches by name, members and description", async () => {
  const { page } = await bootLoadedPage();

  page.filters = { ...page.filters, name: "HQ" };
  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"]);

  page.filters = { ...page.filters, name: "", devices: "r2" };
  assert.deepEqual(page.filteredUnions, []);

  page.filters.devices = "r1";
  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"]);

  page.filters = { ...page.filters, devices: "", networks: "off" };
  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"]);

  // member network by its subnets' CIDR: exact IP, partial IP and CIDR
  for (const q of ["10.0.0.5", "10.0.0.", "10.0.0.0/24"]) {
    page.filters.networks = q;
    assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"], q);
  }
  page.filters.networks = "10.0.1."; // outside the union's networks
  assert.deepEqual(page.filteredUnions, []);

  page.filters = { ...page.filters, networks: "", description: "Глав" };
  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"]);

  page.resetFilters();
  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"]);
});

test("a freshly created union without members is listed with empty filters", async () => {
  const { page } = await bootLoadedPage();
  page.unions.push({ name: "Дата-Центр", devices: [], networks: [], description: "" });

  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq", "Дата-Центр"]);

  // a non-empty member search still hides unions without members
  page.filters.devices = "r1";
  assert.deepEqual(page.filteredUnions.map((u) => u.union.name), ["hq"]);
});
