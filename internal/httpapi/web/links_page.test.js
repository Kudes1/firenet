"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function bootPage(failPut = false) {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  const topoFixture = {
    devices: [{ name: "m", kind: "router" }, { name: "d", kind: "router" }, { name: "o", kind: "router" }],
    links: [
      { a: { device: "m" }, b: { device: "d" } },
      { a: { device: "m" }, b: { device: "o" }, filter: { aExports: ["NA"], bExports: ["NC"] } },
    ],
    networks: [{ name: "NA", subnets: ["a"], attach: [{ device: "m" }] }, { name: "NC", subnets: ["c"], attach: [{ device: "o" }] }],
    sets: [],
    unions: [],
  };
  const sandbox = {
    document: { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) },
    window: { dispatchEvent: notify },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    dispatchEvent: notify,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (path_, opts) => {
      calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path_ === "/api/topology") {
        if (failPut && opts?.method === "PUT") return { ok: false, status: 422, json: async () => ({ error: "x" }) };
        return { ok: true, status: 200, json: async () => calls.find((c) => c.method === "PUT")?.body || topoFixture };
      }
      if (path_ === "/api/subnets") {
        return { ok: true, status: 200, json: async () => ({ subnets: [{ name: "a", cidr: "10.0.0.0/24" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Alpine: { data: (name, factory) => (factories[name] = factory) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["common.js", "links.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.linksPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }), showModal: () => calls.push({ path: "dialog.showModal" }) } };
  return { page, calls, banners };
}

async function bootLoadedPage(failPut = false) {
  const ctx = bootPage(failPut);
  await ctx.page.init();
  return ctx;
}

// Objects produced inside the vm sandbox carry that realm's prototypes, so
// deepStrictEqual against host literals would fail; normalize through JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

test("init loads links with mode flags", async () => {
  const { page } = await bootLoadedPage();
  assert.equal(page.links.length, 2);
  assert.equal(page.links[0].filter, undefined, "plain link stays plain");
  assert.deepEqual(plain(page.links[1].filter), { aExports: ["NA"], bExports: ["NC"] });
  assert.equal(page.loaded, true);
});

test("entityGroups lists networks then subnets", async () => {
  const { page } = await bootLoadedPage();
  assert.deepEqual(plain(page.entityGroups()), [
    { label: "Сети", names: ["NA", "NC"] },
    { label: "Подсети", names: ["a"] },
  ]);
});

test("openEdit copies current exports into the draft", async () => {
  const { page, calls } = await bootLoadedPage();
  page.openEdit(1);
  assert.deepEqual(plain(page.draft), { index: 1, aExports: ["NA"], bExports: ["NC"] });
  page.openEdit(0);
  assert.deepEqual(plain(page.draft), { index: 0, aExports: [], bExports: [] });
});

test("saveDraft writes edited exports preserving the rest verbatim", async () => {
  const { page, calls } = await bootLoadedPage();
  page.openEdit(0);
  page.draft.aExports = ["NA"];
  page.draft.bExports = [];

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/topology" && c.method === "PUT");
  assert.deepEqual(put.body.links[0], { a: { device: "m" }, b: { device: "d" }, filter: { aExports: ["NA"], bExports: [] } });
  // untouched filtered link preserved as-is
  assert.deepEqual(put.body.links[1], { a: { device: "m" }, b: { device: "o" }, filter: { aExports: ["NA"], bExports: ["NC"] } });
  assert.deepEqual(put.body.networks, topoNetworks());
  function topoNetworks() {
    return [{ name: "NA", subnets: ["a"], attach: [{ device: "m" }] }, { name: "NC", subnets: ["c"], attach: [{ device: "o" }] }];
  }
});

test("saveDraft keeps the dialog open when the PUT fails", async () => {
  const { page, calls, banners } = await bootLoadedPage(true);
  page.openEdit(0);
  page.draft.aExports = ["NA"];

  await page.saveDraft();

  assert.ok(!calls.some((c) => c.path === "dialog.close"), "dialog stays open on failure");
  assert.ok(banners.some((b) => b.message.includes("Ошибка сохранения")), "error banner shown");
});

test("makeFiltered adds an empty filter and keeps other sections", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.makeFiltered(0);

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.links[0].filter, { aExports: [], bExports: [] });
  assert.ok(calls.some((c) => c.path === "dialog.close") === false, "no dialog involved");
});

test("makePlain removes the filter key entirely", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.makePlain(1);

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(!("filter" in put.body.links[1]), "filter key dropped");
  assert.deepEqual(put.body.devices.length, 3);
});
