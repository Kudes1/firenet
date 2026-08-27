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
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
      if (path_?.startsWith("/api/link-exports")) {
        const q = new URLSearchParams(path_.split("?")[1]);
        const i = Number(q.get("link"));
        if (failPut && i === 0) return { ok: false, status: 500, json: async () => ({ error: "x" }) };
        // Reachability with the edited link excluded from the fixture
        // topology: link m-o removed leaves plain m-d, and vice versa.
        const side = q.get("side");
        const na = [{ name: "NA" }, { name: "a", cidr: "10.0.0.0/24" }];
        const entities = i === 0
          ? side === "a" ? na : [{ name: "NB" }, { name: "b" }]
          : side === "a"
            ? [...na, { name: "NB" }, { name: "b" }]
            : [{ name: "NC" }, { name: "c" }];
        return { ok: true, status: 200, json: async () => ({ entities }) };
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

test("resetFilters clears every column filter", async () => {
  const { page } = await bootLoadedPage();
  page.filters = { devices: "m", mode: "фил", aExports: "NA", bExports: "NC" };
  page.resetFilters();
  assert.deepEqual(plain(page.filters), { devices: "", mode: "", aExports: "", bExports: "" });
});

test("filteredLinks filters by device, mode and export columns", async () => {
  const { page } = await bootLoadedPage();
  const idx = () => page.filteredLinks.map((r) => r.index);

  assert.deepEqual(idx(), [0, 1], "no filters shows all rows with original indices");

  page.filters.devices = "o";
  assert.deepEqual(idx(), [1], "matches either side device name");
  page.filters.devices = "zz";
  assert.deepEqual(idx(), []);
  page.filters.devices = "";

  page.filters.mode = "фильтр";
  assert.deepEqual(idx(), [1]);
  page.filters.mode = "обыч";
  assert.deepEqual(idx(), [0]);
  page.filters.mode = "";
});

test("filteredLinks matches exports by name and semantically by IP/CIDR", async () => {
  const { page } = await bootLoadedPage();
  const idx = () => page.filteredLinks.map((r) => r.index);

  page.filters.aExports = "NA";
  assert.deepEqual(idx(), [1]);
  page.filters.aExports = "";

  page.links[1].filter.bExports = ["a"]; // subnet a -> 10.0.0.0/24
  page.filters.bExports = "10.0.";
  assert.deepEqual(idx(), [1], "partial-IP query matches the exported subnet CIDR");
  page.filters.bExports = "10.0.0.5";
  assert.deepEqual(idx(), [1], "exact address inside the exported subnet matches");
  page.filters.bExports = "10.1.";
  assert.deepEqual(idx(), []);
  page.filters.bExports = "";

  page.filters.aExports = "10.0."; // network NA exports subnet a (10.0.0.0/24)
  assert.deepEqual(idx(), [1], "IP query matches a network export through its subnets");
  page.filters.aExports = "";
});

test("openEdit copies current exports into the draft and fetches candidates", async () => {
  const { page, calls } = await bootLoadedPage();
  await page.openEdit(1);
  assert.deepEqual(plain(page.draft), { index: 1, aExports: ["NA"], bExports: ["NC"] });
  assert.ok(calls.some((c) => c.path === "/api/link-exports?link=1&side=a"), "candidates fetched for side a");
  assert.ok(calls.some((c) => c.path === "/api/link-exports?link=1&side=b"), "candidates fetched for side b");
  await page.openEdit(0);
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

test("availableEntities lists only reachable candidates minus already exported on that side", async () => {
  const { page } = await bootLoadedPage();
  await page.openEdit(1); // aExports: ["NA"], bExports: ["NC"]; link excluded -> m sees NA+NB, o sees NC
  assert.deepEqual(plain(page.availableEntities("a")), [
    { name: "a", cidr: "10.0.0.0/24" },
    { name: "NB" },
    { name: "b" },
  ]);
  assert.deepEqual(plain(page.availableEntities("b")), [{ name: "c" }]);
});

test("availableEntities filters candidates by search over name and cidr", async () => {
  const { page } = await bootLoadedPage();
  await page.openEdit(0);
  page.combo.search = "10.0";
  assert.deepEqual(plain(page.availableEntities("a")), [{ name: "a", cidr: "10.0.0.0/24" }]);
  page.combo.search = "na";
  assert.deepEqual(plain(page.availableEntities("a")), [{ name: "NA" }]);
  page.combo.search = "zzz";
  assert.deepEqual(plain(page.availableEntities("a")), []);
});

test("addExport appends to the given side and resets the combo", async () => {
  const { page } = await bootLoadedPage();
  page.openEdit(0);
  page.addExport("a", "NA");
  page.combo.search = "10";
  page.addExport("b", "a");
  assert.deepEqual(plain(page.draft.aExports), ["NA"]);
  assert.deepEqual(plain(page.draft.bExports), ["a"]);
  assert.deepEqual(plain(page.combo), { side: "", search: "", cursor: 0 }, "combo resets after pick");
});

test("removeExport deletes from the given side", async () => {
  const { page } = await bootLoadedPage();
  page.openEdit(1);
  page.removeExport("a", "NA");
  assert.deepEqual(plain(page.draft.aExports), []);
  assert.deepEqual(plain(page.draft.bExports), ["NC"], "other side untouched");
});

test("moveCursor and pickEntity navigate the candidate list", async () => {
  const { page } = await bootLoadedPage();
  await page.openEdit(0); // side a has 2 reachable candidates
  page.combo.side = "a";
  page.moveCursor(5);
  assert.equal(page.combo.cursor, 1, "cursor clamps to last candidate");
  page.moveCursor(-99);
  assert.equal(page.combo.cursor, 0);
  page.pickEntity();
  assert.deepEqual(plain(page.draft.aExports), ["NA"], "picks the entity under the cursor");
});

test("candidate fetch failure shows a banner and empties the combos", async () => {
  const { page, banners } = await bootLoadedPage(true);
  await page.openEdit(0);
  assert.deepEqual(plain(page.availableEntities("a")), []);
  assert.ok(banners.some((b) => b.message.includes("доступные сети")), "error banner shown");
});

test("closeOther only closes its own combo", async () => {
  const { page } = await bootLoadedPage();
  page.openEdit(0);
  page.openCombo("a");
  // sibling combo's click.outside must not close the open one
  page.closeOther("b");
  assert.equal(page.combo.side, "a", "sibling click.outside leaves combo a open");
  page.closeOther("a");
  assert.equal(page.combo.side, "", "own click.outside closes combo a");
});

test("openCombo keeps search when the same side reopens", async () => {
  const { page } = await bootLoadedPage();
  await page.openEdit(0);
  page.openCombo("a");
  page.combo.search = "a";
  page.moveCursor(1);
  page.openCombo("a"); // refocus/click on the already-open input
  assert.equal(page.combo.search, "a", "typed query survives refocus");
  assert.equal(page.combo.cursor, 1, "cursor survives refocus");
  page.openCombo("b"); // switching sides resets
  assert.deepEqual(plain(page.combo), { side: "b", search: "", cursor: 0 });
});
