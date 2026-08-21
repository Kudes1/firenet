"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Boots the networks Alpine component outside a browser and exercises its
// validation, single-ownership and persistence logic against a stubbed fetch.

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
    networks: [
      { name: "office", subnets: ["a"], attach: [{ device: "r1" }] },
      { name: "dmz", subnets: ["b"], attach: [] },
    ],
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
      if (path_ === "/api/topology") {
        return { ok: true, status: 200, json: async () => calls.find((c) => c.method === "PUT")?.body || topoFixture };
      }
      if (path_ === "/api/subnets") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ subnets: [{ name: "a", cidr: "10.0.0.0/24" }, { name: "b", cidr: "10.0.1.0/24" }, { name: "c", cidr: "10.0.2.0/24" }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Alpine: { data: (name, factory) => (factories[name] = factory) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "columns.js", "networks.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.networksPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }) } };
  return { page, calls, banners };
}

async function bootLoadedPage() {
  const ctx = bootPage();
  await ctx.page.init();
  return ctx;
}

test("draftHint requires a unique network name", () => {
  const { page } = bootPage();
  page.networks = [{ name: "office", subnets: [] }];

  page.draft = { index: -1, name: "", subnets: [] };
  assert.match(page.draftHint, /Укажите имя/);

  page.draft = { index: -1, name: "office", subnets: [] };
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
  page.draft = { index: -1, name: "guest", subnets: [] };

  page.addMember("b");
  assert.deepEqual(page.draft.subnets, ["b"]);
  assert.equal(page.memberSearch, ""); // search reset after pick
  assert.equal(page.memberOpen, false);

  page.addMember("b"); // duplicate is ignored
  assert.deepEqual(page.draft.subnets, ["b"]);

  page.removeMember("b");
  assert.deepEqual(page.draft.subnets, []);
});

test("pickCursor adds the highlighted suggestion", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "guest", subnets: [] };
  page.memberSearch = "10.0.2";
  page.memberCursor = 0;

  page.pickCursor();

  assert.deepEqual(page.draft.subnets, ["c"]);
});

test("memberSearch filters available subnets by name and CIDR", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "guest", subnets: [] };

  page.memberSearch = "10.0.2";
  assert.deepEqual(page.availableSubnets.map((s) => s.name), ["c"]);

  page.memberSearch = "c";
  assert.deepEqual(page.availableSubnets.map((s) => s.name), ["c"]);

  page.memberSearch = "zzz";
  assert.deepEqual(page.availableSubnets, []);
});

test("saveDraft persists the whole topology preserving devices, links and attach", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: -1, name: "guest", subnets: ["c"] };

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/topology" && c.method === "PUT");
  assert.deepEqual(put.body.devices, [{ name: "r1", kind: "router" }]);
  assert.deepEqual(put.body.links, []);
  assert.deepEqual(put.body.networks, [
    { name: "office", subnets: ["a"], attach: [{ device: "r1" }] },
    { name: "dmz", subnets: ["b"], attach: [] },
    { name: "guest", subnets: ["c"], attach: [] },
  ]);
  assert.equal(page.networks.length, 3);
  assert.ok(calls.some((c) => c.path === "dialog.close"));
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
