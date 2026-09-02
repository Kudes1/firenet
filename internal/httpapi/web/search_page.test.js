"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Boots the search Alpine component outside a browser and exercises its
// query matching against a stubbed search-index endpoint. Indexing lives
// server-side (internal/httpapi/search_index.go); the page only filters.

const INDEX = [
  { type: "device", name: "r1", details: "router", description: "ядро сети" },
  { type: "subnet", name: "dmz", details: "10.0.0.0/24", description: "демилитаризованная", prefixes: ["10.0.0.0/24"] },
  { type: "network", name: "net1", details: "dmz", description: "", prefixes: ["10.0.0.0/24"] },
  { type: "set", name: "blocked", details: "dmz, 10.9.9.9", description: "", prefixes: ["10.0.0.0/24", "10.9.9.9/32"] },
  { type: "union", name: "branch", details: "r1", description: "" },
  { type: "link", name: "r1 — sw1", description: "" },
  { type: "rule", name: "web", details: "any → dmz", description: "allow · tcp · dp:443" },
];

async function bootPage(query = "") {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  global.document = { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) };
  global.window = { dispatchEvent: (e) => e.type === "notify" && banners.push(e.detail), location: { search: query, href: "" } };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
  global.fetch = async (path_) => {
    calls.push({ path: path_ });
    if (path_ === "/api/versions/current/search-index") {
      return { ok: true, status: 200, json: async () => INDEX };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  // cache-busting: search.js регистрирует alpine:init при каждом импорте
  await import(path.join(__dirname, "search.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.searchPage();
  page.$nextTick = (fn) => fn();
  return { page, calls, banners };
}

test("init loads the server-provided index once and prefills q from ?q=", async () => {
  const { page, calls } = await bootPage("?q=dmz");
  await page.init();

  assert.deepEqual(calls, [{ path: "/api/versions/current/search-index" }]);
  assert.equal(page.entries.length, INDEX.length);
  assert.equal(page.q, "dmz");
});

test("results match names, details and descriptions case-insensitively", async () => {
  const { page } = await bootPage();
  await page.init();

  page.q = "DMZ";
  assert.deepEqual(page.results.map((r) => r.name).sort(), ["blocked", "dmz", "net1", "web"]);

  page.q = "ядро";
  assert.deepEqual(page.results.map((r) => r.name), ["r1"]);

  page.q = "r1 — sw1";
  assert.deepEqual(page.results.map((r) => r.type), ["link"]);
});

test("IP and CIDR queries match prefixes semantically", async () => {
  const { page } = await bootPage();
  await page.init();

  // exact address inside dmz hits subnet, network and set members
  page.q = "10.0.0.77";
  assert.deepEqual(page.results.map((r) => r.type).sort(), ["network", "set", "subnet"]);

  // partial address works too
  page.q = "10.0.";
  assert.ok(page.results.some((r) => r.type === "subnet"));

  // set's host address is searchable as /32
  page.q = "10.9.9.9";
  assert.deepEqual(page.results.map((r) => r.name), ["blocked"]);

  // non-matching CIDR finds nothing
  page.q = "192.168.0.0/16";
  assert.deepEqual(page.results, []);

  // subnet name without an IP query still matches as a substring
  page.q = "blocked";
  assert.deepEqual(page.results.map((r) => r.name), ["blocked"]);
});

test("results filter by entity type", async () => {
  const { page } = await bootPage();
  await page.init();

  page.type = "subnet";
  assert.deepEqual(page.results.map((r) => r.type), ["subnet"]);

  page.type = "rule";
  assert.deepEqual(page.results.map((r) => r.type), ["rule"]);

  page.type = "all";
  assert.ok(page.results.length > 1);
});

test("results carry a label and a target page href", async () => {
  const { page } = await bootPage();
  await page.init();

  page.q = "dmz";
  const hit = page.results.find((r) => r.type === "subnet");
  assert.equal(hit.typeLabel, "Подсеть");
  assert.equal(hit.href, "/ui/subnets");

  page.q = "";
  page.type = "device";
  assert.equal(page.results[0].typeLabel, "Устройство");
  assert.equal(page.results[0].href, "/ui/devices");
});

test("load failure shows a banner instead of results", async () => {
  const factories = {};
  const banners = [];
  const docListeners = {};
  global.document = { addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) };
  global.window = { dispatchEvent: (e) => e.type === "notify" && banners.push(e.detail), location: { search: "" } };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  await import(path.join(__dirname, "search.js") + `?t=err-${Date.now()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.searchPage();
  page.$nextTick = (fn) => fn();

  await page.init();

  assert.equal(page.loaded, false);
  assert.match(banners[0].message, /Не удалось загрузить данные для поиска/);
});
