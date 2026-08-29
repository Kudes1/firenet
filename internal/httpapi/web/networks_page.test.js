"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Boots the networks Alpine component outside a browser and exercises its
// validation, single-ownership and persistence logic against a stubbed fetch.

async function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const store = { "firenet-draft-id": "d1" };
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  const topoFixture = {
    devices: [{ name: "r1", kind: "router" }],
    links: [],
    networks: [
      { name: "office", subnets: ["a"], attach: [{ device: "r1" }], description: "офисная" },
      { name: "dmz", subnets: ["b"], attach: [] },
    ],
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
    if (path_ === "/api/drafts/d1/topology/operations" && opts?.method === "POST") {
      const op = JSON.parse(opts.body);
      const networks = topoFixture.networks.map((n) => n.name === op.networkName ? { ...op.network, attach: n.attach } : n);
      return { ok: true, status: 200, json: async () => ({ topology: { ...topoFixture, networks }, layout: {} }) };
    }
    if (path_ === "/api/drafts/d1/topology") {
      return { ok: true, status: 200, json: async () => calls.find((c) => c.method === "PUT")?.body || topoFixture };
    }
    if (path_ === "/api/drafts/d1/subnets") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ subnets: [{ name: "a", cidr: "10.0.0.0/24" }, { name: "b", cidr: "10.0.1.0/24" }, { name: "c", cidr: "10.0.2.0/24" }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  // cache-busting: networks.js регистрирует alpine:init при каждом импорте
  await import(path.join(__dirname, "networks.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.networksPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }) } };
  return { page, calls, banners, store };
}

async function bootLoadedPage() {
  const ctx = await bootPage();
  await ctx.page.init();
  return ctx;
}

test("draftHint requires a unique network name", async () => {
  const { page } = await bootLoadedPage();

  page.draft = { index: 0, name: "", subnets: [] };
  assert.match(page.draftHint, /Укажите имя/);

  page.draft = { index: 0, name: "dmz", subnets: [] };
  assert.match(page.draftHint, /уже используется/);

  page.draft = { index: 0, name: "office", subnets: [] };
  assert.equal(page.draftHint, "");
});

test("availableSubnets excludes own members and foreign-owned subnets", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: 0, name: "office", subnets: ["a"] };

  assert.deepEqual(
    page.availableSubnets.map((s) => s.name),
    ["c"] // "b" is owned by dmz, "a" is already in the network
  );
});

test("addMember/removeMember manage the draft list one at a time", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: 0, name: "office", subnets: [] };
  page.memberSearch = "b";
  page.memberOpen = true;

  page.addMember("b");
  assert.deepEqual(page.draft.subnets, ["b"]);
  assert.equal(page.memberSearch, ""); // search reset after pick
  assert.equal(page.memberOpen, false); // dropdown closes after pick

  page.addMember("b"); // duplicate is ignored
  assert.deepEqual(page.draft.subnets, ["b"]);

  page.removeMember("b");
  assert.deepEqual(page.draft.subnets, []);
});

test("pickCursor adds the highlighted suggestion", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: 0, name: "office", subnets: [] };
  page.memberSearch = "10.0.2";
  page.memberCursor = 0;

  page.pickCursor();

  assert.deepEqual(page.draft.subnets, ["c"]);
});

test("memberSearch filters available subnets by name and CIDR", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: 0, name: "office", subnets: [] };

  page.memberSearch = "10.0.2";
  assert.deepEqual(page.availableSubnets.map((s) => s.name), ["c"]);

  page.memberSearch = "c";
  assert.deepEqual(page.availableSubnets.map((s) => s.name), ["c"]);

  page.memberSearch = "zzz";
  assert.deepEqual(page.availableSubnets, []);
});

test("filteredNetworks matches by name, description and subnets with IP expansion", async () => {
  const { page } = await bootLoadedPage(); // office: [a=10.0.0.0/24], dmz: [b=10.0.1.0/24]

  page.filters = { ...page.filters, name: "OFF" };
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["office"]);

  page.filters = { ...page.filters, name: "", description: "фисная" };
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["office"]);

  page.filters = { ...page.filters, description: "", subnets: "b" }; // subnet name substring
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["dmz"]);

  page.filters.subnets = "10.0.0.5"; // exact address inside a
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["office"]);

  page.filters.subnets = "10.0."; // partial prefix overlaps both members
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["office", "dmz"]);

  page.filters.subnets = "10.0.1.0/24"; // CIDR overlapping b only
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["dmz"]);

  page.filters.subnets = "10.9.";
  assert.deepEqual(page.filteredNetworks, []);

  page.resetFilters();
  assert.deepEqual(page.filteredNetworks.map((n) => n.net.name), ["office", "dmz"]);
});

test("saveDraft updates network members and description", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: 0, name: "office", subnets: ["a", "c"], description: "офисная" };

  await page.saveDraft();

  const post = calls.find((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST");
  assert.deepEqual(post.body, {
    kind: "update-network",
    networkName: "office",
    network: { name: "office", subnets: ["a", "c"], description: "офисная" },
  });
  assert.equal(page.networks[0].description, "офисная"); // description survives persist
  assert.equal(page.networks.length, 2);
  assert.ok(calls.some((c) => c.path === "dialog.close"));
});

test("saveDraft renames a network through the cascading update operation", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: 0, name: "hq", subnets: ["a"], description: "головной офис" };

  await page.saveDraft();

  const post = calls.find((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST");
  assert.ok(post, "network rename must use a cascading operation");
  assert.deepEqual(post.body, {
    kind: "update-network",
    networkName: "office",
    network: { name: "hq", subnets: ["a"], description: "головной офис" },
  });
  assert.equal(calls.some((c) => c.path === "/api/drafts/d1/topology" && c.method === "PUT"), false);
});

test("removeNetwork deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.removeNetwork(1);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(
    put.body.networks.map((n) => n.name),
    ["office"]
  );
});

test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.draft = { index: 0, name: "office", subnets: ["a"], description: "офисная" };
  await page.saveDraft();
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});