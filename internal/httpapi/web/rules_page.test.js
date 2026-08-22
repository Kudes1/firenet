"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Boots the rules Alpine component outside a browser and exercises its
// unified create/edit modal, client-side filtering (including IP/CIDR
// search) and persistence against a stubbed fetch.

function bootPage({ failPut = null } = {}) {
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
      { name: "office", subnets: ["a"], attach: [] },
      { name: "dmz", subnets: ["b"], attach: [] },
    ],
    sets: [{ name: "blocked", subnets: ["a"], addresses: ["10.0.0.9"] }],
  };
  const rulesFixture = {
    defaultAction: "deny",
    chainName: "",
    chainPosition: "top",
    rules: [
      {
        name: "web",
        comment: "",
        src: ["office"],
        dst: ["dmz"],
        proto: "tcp",
        srcPorts: [],
        dstPorts: ["80"],
        action: "allow",
        mirror: false,
      },
    ],
  };
  const sandbox = {
    document: { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) },
    window: { dispatchEvent: notify },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    CustomEvent: class {},
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (path_, opts) => {
      calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (path_ === "/api/rules" && opts?.method === "PUT" && failPut) {
        return { ok: false, status: 422, json: async () => ({ error: failPut }) };
      }
      if (path_ === "/api/rules") {
        return { ok: true, status: 200, json: async () => calls.findLast((c) => c.method === "PUT")?.body || rulesFixture };
      }
      if (path_ === "/api/topology") {
        return { ok: true, status: 200, json: async () => topoFixture };
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
  for (const f of ["common.js", "columns.js", "rules.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.rulesPage();
  page.$nextTick = (fn) => fn();
  page.$refs = { dialog: { close: () => calls.push({ path: "dialog.close" }), showModal: () => calls.push({ path: "dialog.showModal" }) } };
  return { page, calls, banners };
}

async function bootLoadedPage() {
  const ctx = bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads the policy doc and orders endpoints as any, subnets, sets", async () => {
  const { page } = await bootLoadedPage();

  assert.equal(page.doc.defaultAction, "deny");
  assert.deepEqual([...page.endpoints], ["any", "a", "b", "blocked"]);
});

test("resolvePrefixes expands a set to its subnet CIDRs and host addresses", async () => {
  const { page } = await bootLoadedPage();

  const prefixes = [...page.resolvePrefixes("blocked")].map((p) => `${p.base}/${p.bits}`);
  assert.deepEqual([...prefixes].sort(), ["167772160/24", "167772169/32"]);
});

test("resolvePrefixes matches a literal endpoint by its own CIDR", async () => {
  const { page } = await bootLoadedPage();

  const prefixes = [...page.resolvePrefixes("10.0.0.77/24")].map((p) => `${p.base}/${p.bits}`);
  assert.deepEqual(prefixes, ["167772160/24"]); // masked, not the containing subnet's view
  assert.deepEqual([...page.resolvePrefixes("10.0.0.5")].map((p) => p.bits), [32]);
});

test("draftHint mirrors server-side rule validation", async () => {
  const { page } = await bootLoadedPage();

  page.draft = { index: -1, name: "", comment: "", src: ["any"], dst: ["any"], proto: "any", action: "deny", srcPorts: "", dstPorts: "", mirror: false };
  assert.match(page.draftHint, /Укажите имя/);

  page.draft.name = "web";
  assert.match(page.draftHint, /уже используется/);

  page.draft.name = "new";
  page.draft.src = [];
  assert.match(page.draftHint, /Src/);

  page.draft.src = ["any"];
  page.draft.dst = [];
  assert.match(page.draftHint, /Dst/);

  page.draft.dst = ["any"];
  page.draft.dstPorts = "80";
  assert.match(page.draftHint, /tcp\/udp/);

  page.draft.proto = "tcp";
  page.draft.dstPorts = "abc";
  assert.match(page.draftHint, /Порты/);

  page.draft.dstPorts = "100-50";
  assert.match(page.draftHint, /Порты/);

  page.draft.dstPorts = "80,443";
  assert.equal(page.draftHint, "");
});

test("openAdd/openEdit manage a single draft; title mode follows index", async () => {
  const { page } = await bootLoadedPage();

  page.openAdd();
  assert.equal(page.draft.index, -1);
  assert.match(page.modalTitle, /Новое правило/);
  page.closeModal();

  page.openEdit(0);
  assert.equal(page.draft.index, 0);
  assert.equal(page.draft.name, "web");
  assert.equal(page.draft.dstPorts, "80"); // ports joined for the input
  assert.match(page.modalTitle, /Изменить правило/);
});

test("endpoint search filters out selected endpoints per field", async () => {
  const { page } = await bootLoadedPage();
  page.openEdit(0); // src: ["office"], dst: ["dmz"]

  assert.deepEqual([...page.availableEndpoints("src")], ["any", "a", "b", "blocked"]);
  assert.deepEqual([...page.availableEndpoints("dst")], ["any", "a", "b", "blocked"]);

  page.srcSearch = "bl";
  assert.deepEqual([...page.availableEndpoints("src")], ["blocked"]);

  page.srcSearch = "zzz";
  assert.deepEqual([...page.availableEndpoints("src")], []);
});

test("availableEndpoints offers a typed address/CIDR and addEndpoint stores its canonical form", async () => {
  const { page } = await bootLoadedPage();
  page.openAdd();

  page.srcSearch = "10.0.0.";
  assert.deepEqual([...page.availableEndpoints("src")], []); // incomplete address is not addable

  page.srcSearch = "10.0.0.5";
  assert.deepEqual([...page.availableEndpoints("src")], ["10.0.0.5/32"]);

  page.addEndpoint("src", "10.0.0.5/32");
  assert.deepEqual([...page.draft.src], ["10.0.0.5/32"]);
  assert.equal(page.srcOpen, false);

  // The already selected endpoint is not offered again.
  page.srcSearch = "10.0.0.5";
  assert.deepEqual([...page.availableEndpoints("src")], []);

  page.draft.src = [];
  page.srcSearch = "10.0.0.77/24";
  assert.deepEqual([...page.availableEndpoints("src")], ["10.0.0.0/24"]); // masked

  for (const bad of ["abc", "300.1.1.1", "10.0.0.5/33", "::1"]) {
    page.srcSearch = bad;
    assert.deepEqual([...page.availableEndpoints("src")], [], `invalid input ${bad} must offer nothing`);
  }
});

test("addEndpoint/removeEndpoint manage the draft list and reset the search", async () => {
  const { page } = await bootLoadedPage();
  page.openAdd();

  page.addEndpoint("src", "office");
  assert.deepEqual([...page.draft.src], ["office"]);
  assert.equal(page.srcSearch, "");
  assert.equal(page.srcOpen, false);

  page.addEndpoint("src", "office"); // duplicate is ignored
  assert.deepEqual([...page.draft.src], ["office"]);

  page.removeEndpoint("src", "office");
  assert.deepEqual([...page.draft.src], []);
});

test("pickCursor adds the highlighted endpoint suggestion", async () => {
  const { page } = await bootLoadedPage();
  page.openAdd();
  page.dstSearch = "bl";
  page.dstCursor = 0;

  page.pickCursor("dst");

  assert.deepEqual([...page.draft.dst], ["blocked"]);
});

test("saveDraft appends a new rule and persists the whole policy doc", async () => {
  const { page, calls } = await bootLoadedPage();
  page.openAdd();
  Object.assign(page.draft, { name: "dns", src: ["any"], dst: ["any"], proto: "udp", dstPorts: "53" });

  await page.saveDraft();

  const put = calls.find((c) => c.path === "/api/rules" && c.method === "PUT");
  assert.equal(put.body.defaultAction, "deny");
  assert.equal(put.body.chainPosition, "top");
  assert.deepEqual(put.body.rules.map((r) => r.name), ["web", "dns"]);
  assert.deepEqual(put.body.rules[1].dstPorts, ["53"]);
  assert.ok(calls.some((c) => c.path === "dialog.close"));
  assert.equal(page.doc.rules.length, 2);
});

test("saveDraft replaces the edited rule in place", async () => {
  const { page, calls } = await bootLoadedPage();
  page.openEdit(0);
  page.draft.action = "deny";

  await page.saveDraft();

  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.body.rules.length, 1);
  assert.equal(put.body.rules[0].action, "deny");
  assert.equal(page.doc.rules[0].action, "deny");
});

test("saveDraft keeps the modal open with the server error on rejection", async () => {
  const { page, calls } = bootPage({ failPut: 'rule "x": unknown src "nope"' });
  await page.init();
  page.openAdd();
  Object.assign(page.draft, { name: "x", src: ["nope"], dst: ["any"] });

  await page.saveDraft();

  assert.match(page.modalError, /unknown src/);
  assert.ok(!calls.some((c) => c.path === "dialog.close"));
});

test("moveRule swaps neighbours and removeRule deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();
  page.doc.rules.push({ ...page.doc.rules[0], name: "second" });

  await page.moveRule(1, -1);
  assert.deepEqual(page.doc.rules.map((r) => r.name), ["second", "web"]);
  let put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.rules.map((r) => r.name), ["second", "web"]);

  await page.removeRule(0);
  put = calls.findLast((c) => c.method === "PUT");
  assert.deepEqual(page.doc.rules.map((r) => r.name), ["web"]);
});

test("saveSettings persists toolbar parameters", async () => {
  const { page, calls } = await bootLoadedPage();
  page.settings = { defaultAction: "allow", chainName: "MY-CHAIN", chainPosition: "bottom" };

  await page.saveSettings();

  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.body.defaultAction, "allow");
  assert.equal(put.body.chainName, "MY-CHAIN");
  assert.equal(put.body.chainPosition, "bottom");
  assert.equal(page.doc.defaultAction, "allow");
});

test("filteredRules matches endpoints by IP, partial IP, CIDR and name substring", async () => {
  const { page } = await bootLoadedPage();

  page.filters = { ...page.filters, src: "10.0.0.5" };
  assert.deepEqual(page.filteredRules.map((r) => r.rule.name), ["web"]);

  page.filters = { ...page.filters, src: "10.0.1.5" }; // other subnet
  assert.deepEqual(page.filteredRules, []);

  page.filters = { ...page.filters, src: "10.0." }; // partial prefix overlaps
  assert.deepEqual(page.filteredRules.map((r) => r.rule.name), ["web"]);

  page.filters = { ...page.filters, src: "10.0.2.0/24" }; // disjoint CIDR
  assert.deepEqual(page.filteredRules, []);

  page.filters = { ...page.filters, src: "OFF" }; // case-insensitive substring
  assert.deepEqual(page.filteredRules.map((r) => r.rule.name), ["web"]);

  page.filters = { ...page.filters, src: "", name: "web" };
  assert.deepEqual(page.filteredRules.map((r) => r.rule.name), ["web"]);

  page.filters = { ...page.filters, name: "nope" };
  assert.deepEqual(page.filteredRules, []);
});
