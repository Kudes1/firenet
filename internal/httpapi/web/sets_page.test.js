"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Boots the sets Alpine component outside a browser and exercises its
// validation, membership and persistence logic against a stubbed fetch.

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
    sets: [{ name: "blocked", subnets: ["a"], addresses: ["10.0.0.9"], description: "блоклист" }],
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
          json: async () => ({ subnets: [{ name: "a", cidr: "10.0.0.0/24" }, { name: "b", cidr: "10.0.1.0/24" }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Alpine: { data: (name, factory) => (factories[name] = factory) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "columns.js", "sets.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.setsPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }) } };
  return { page, calls, banners };
}

async function bootLoadedPage() {
  const ctx = bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads sets from the topology", async () => {
  const { page } = await bootLoadedPage();
  // Compare field-by-field: objects from the VM realm have a foreign prototype.
  assert.equal(page.sets.length, 1);
  assert.equal(page.sets[0].name, "blocked");
  assert.deepEqual([...page.sets[0].subnets], ["a"]);
  assert.deepEqual([...page.sets[0].addresses], ["10.0.0.9"]);
  assert.equal(page.sets[0].description, "блоклист");
  assert.equal(page.loaded, true);
});

test("draftHint requires a unique name and a non-empty set", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "", subnets: [], addresses: [] };
  assert.match(page.draftHint, /Укажите имя/);

  page.draft = { index: -1, name: "blocked", subnets: [], addresses: [] };
  assert.match(page.draftHint, /уже используется/);

  page.draft = { index: -1, name: "fresh", subnets: [], addresses: [] };
  assert.match(page.draftHint, /минимум одну подсеть или адрес/);

  page.draft = { index: 0, name: "blocked", subnets: ["a"], addresses: [] };
  assert.equal(page.draftHint, "");
});

test("availableSubnets excludes own members but allows subnets from other sets", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: 0, name: "blocked", subnets: ["a"], addresses: [] };

  // "a" is already in the draft; "b" belongs to no set and stays available
  // even though it is referenced by another set below.
  page.sets = [
    { name: "blocked", subnets: ["a"], addresses: [] },
    { name: "other", subnets: ["b"], addresses: [] },
  ];
  page.draft.index = 1;
  page.draft.subnets = ["b"];

  assert.deepEqual(page.availableSubnets.map((s) => s.name), ["a"]);
});

test("addAddress accepts host addresses and prefixes, rejects garbage and duplicates", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "fresh", subnets: [], addresses: [] };

  page.addressInput = "10.0.0.5";
  assert.equal(page.addAddress(), true);
  assert.deepEqual(page.draft.addresses, ["10.0.0.5"]);
  assert.equal(page.addressInput, "");

  page.addressInput = "10.0.0.6/32";
  assert.equal(page.addAddress(), true);
  assert.deepEqual(page.draft.addresses, ["10.0.0.5", "10.0.0.6/32"]);

  page.addressInput = "10.0.0.5"; // duplicate (ignoring the mask)
  assert.equal(page.addAddress(), false);

  page.addressInput = "not-an-ip";
  assert.equal(page.addAddress(), false);

  page.addressInput = "10.0.0.0/24"; // not a single host
  assert.equal(page.addAddress(), false);

  page.addressInput = "2001:db8::1";
  assert.equal(page.addAddress(), true);

  page.removeAddress("10.0.0.5");
  assert.deepEqual(page.draft.addresses, ["10.0.0.6/32", "2001:db8::1"]);
});

test("addMember/removeMember manage the subnet draft list", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "fresh", subnets: [], addresses: [] };
  page.memberOpen = true;

  page.addMember("a");
  assert.deepEqual(page.draft.subnets, ["a"]);
  assert.equal(page.memberOpen, false); // dropdown closes after pick
  page.memberOpen = true;
  page.addMember("a"); // duplicate ignored
  assert.deepEqual(page.draft.subnets, ["a"]);
  page.removeMember("a");
  assert.deepEqual(page.draft.subnets, []);
});

test("saveDraft persists the whole topology preserving devices, links, networks and other sets", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: -1, name: "watch", subnets: ["b"], addresses: ["10.0.0.7"] };

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/topology" && c.method === "PUT");
  assert.deepEqual(put.body.devices, [{ name: "r1", kind: "router" }]);
  assert.deepEqual(put.body.links, []);
  assert.deepEqual(put.body.networks, [{ name: "office", subnets: ["a"], attach: [{ device: "r1" }] }]);
  assert.deepEqual(put.body.sets, [
    { name: "blocked", subnets: ["a"], addresses: ["10.0.0.9"], description: "блоклист" },
    { name: "watch", subnets: ["b"], addresses: ["10.0.0.7"] },
  ]);
  assert.equal(page.sets.length, 2);
  assert.ok(calls.some((c) => c.path === "dialog.close"));
});

test("filteredSets matches by name, description and addresses with IP/CIDR expansion", async () => {
  const { page } = await bootLoadedPage(); // blocked: [a], addresses ["10.0.0.9"], "блоклист"

  page.filters = { ...page.filters, name: "BLOCK" };
  assert.deepEqual(page.filteredSets.map((s) => s.set.name), ["blocked"]);

  page.filters = { ...page.filters, name: "", description: "блок" };
  assert.deepEqual(page.filteredSets.map((s) => s.set.name), ["blocked"]);

  for (const q of ["10.0.0.9", "10.0.0.", "10.0.0.0/24"]) {
    page.filters = { ...page.filters, description: "", addresses: q };
    assert.deepEqual(page.filteredSets.map((s) => s.set.name), ["blocked"], q);
  }

  page.filters.addresses = "10.0.1.9"; // outside the set
  assert.deepEqual(page.filteredSets, []);

  page.filters = { ...page.filters, addresses: "", subnets: "a" }; // member subnet by name
  assert.deepEqual(page.filteredSets.map((s) => s.set.name), ["blocked"]);

  page.filters.subnets = "10.0.0.0/24"; // member subnet by CIDR
  assert.deepEqual(page.filteredSets.map((s) => s.set.name), ["blocked"]);

  page.filters.subnets = "10.0.1."; // other subnet's prefix
  assert.deepEqual(page.filteredSets, []);

  page.resetFilters();
  assert.deepEqual(page.filteredSets.map((s) => s.set.name), ["blocked"]);
});

test("removeSet deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.removeSet(0);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.sets, []);
});
