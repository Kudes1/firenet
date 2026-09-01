"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Boots the devices Alpine component outside a browser and exercises its
// validation, union-reassignment and persistence logic against a stubbed
// fetch. The mock fetch applies operations to a local clone of the fixture
// itself (rename/union add/remove/delete) so tests can assert on the
// resulting snapshot the same way the real server would return it — the
// operations' own cascade semantics are covered by the Go tests in
// topology_operations_test.go, not re-verified here.

function applyOp(topo, op) {
  const next = { ...topo, devices: topo.devices.map((d) => ({ ...d })), unions: topo.unions.map((u) => ({ ...u, devices: [...u.devices] })) };
  if (op.kind === "update-device") {
    const i = next.devices.findIndex((d) => d.name === op.deviceName);
    next.devices[i] = { name: op.device.name, kind: op.device.kind, ...(op.device.description ? { description: op.device.description } : {}) };
    next.unions.forEach((u) => { u.devices = u.devices.map((d) => (d === op.deviceName ? op.device.name : d)); });
  } else if (op.kind === "union-remove-device") {
    const u = next.unions.find((u) => u.name === op.unionName);
    u.devices = u.devices.filter((d) => d !== op.deviceName);
  } else if (op.kind === "union-add-device") {
    const u = next.unions.find((u) => u.name === op.unionName);
    u.devices.push(op.deviceName);
  } else if (op.kind === "delete-device") {
    next.devices = next.devices.filter((d) => d.name !== op.deviceName);
    next.unions.forEach((u) => { u.devices = u.devices.filter((d) => d !== op.deviceName); });
  }
  return next;
}

async function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const store = { "firenet-draft-id": "d1" };
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  let topoFixture = {
    devices: [
      { name: "r1", kind: "router", description: "граничный" },
      { name: "sw1", kind: "switch" },
    ],
    links: [],
    networks: [],
    sets: [],
    unions: [{ name: "hq", devices: ["r1"], networks: [], description: "главный" }],
  };
  global.document = {
    addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn),
    getElementById: (id) =>
      id === "topo-canvas" ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) } : null,
  };
  global.window = { dispatchEvent: notify };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  global.confirm = () => true;
  global.fetch = async (path_, opts) => {
    calls.push({ path: path_, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    if (path_ === "/api/drafts/d1/topology/operations/batch" && opts?.method === "POST") {
      const { operations } = JSON.parse(opts.body);
      topoFixture = operations.reduce(applyOp, topoFixture);
      return { ok: true, status: 200, json: async () => ({ topology: topoFixture, layout: {} }) };
    }
    if (path_ === "/api/drafts/d1/topology/operations" && opts?.method === "POST") {
      const op = JSON.parse(opts.body);
      topoFixture = applyOp(topoFixture, op);
      return { ok: true, status: 200, json: async () => ({ topology: topoFixture, layout: {} }) };
    }
    if (path_ === "/api/drafts/d1/topology") {
      return { ok: true, status: 200, json: async () => topoFixture };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  // cache-busting: devices.js регистрирует alpine:init при каждом импорте
  await import(path.join(__dirname, "devices.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.devicesPage();
  page.$nextTick = (fn) => fn();
  page.$refs = {
    dialog: { close: () => calls.push({ path: "dialog.close" }) },
  };
  return { page, calls, banners, store, getFixture: () => topoFixture };
}

async function bootLoadedPage() {
  const ctx = await bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads devices with their union membership", async () => {
  const { page } = await bootLoadedPage();
  assert.equal(page.devices.length, 2);
  assert.deepEqual(page.devices[0], { name: "r1", kind: "router", description: "граничный", union: "hq" });
  assert.deepEqual(page.devices[1], { name: "sw1", kind: "switch", description: "", union: "" });
  assert.equal(page.loaded, true);
});

test("draftHint requires a unique non-empty name", async () => {
  const { page } = await bootLoadedPage();
  page.draft = { index: -1, name: "", description: "", union: "" };
  assert.match(page.draftHint, /Укажите имя/);

  page.draft = { index: -1, name: "r1", description: "", union: "" };
  assert.match(page.draftHint, /уже используется/);

  page.draft = { index: 0, name: "r1", description: "", union: "" };
  assert.equal(page.draftHint, "");
});

test("saveDraft renames a device and updates its description", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: 0, name: "core-1", description: "новый узел", union: "hq" };

  await page.saveDraft();

  const post = calls.find((c) => c.path === "/api/drafts/d1/topology/operations/batch" && c.method === "POST");
  assert.deepEqual(post.body.operations, [
    { kind: "update-device", deviceName: "r1", device: { name: "core-1", kind: "router", description: "новый узел" } },
  ]);
  assert.equal(page.devices[0].name, "core-1");
  assert.equal(page.devices[0].union, "hq");
  assert.ok(calls.some((c) => c.path === "dialog.close"));
});

test("saveDraft moves a device into a different union, mirroring canvas drag semantics", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: 1, name: "sw1", description: "", union: "hq" };

  await page.saveDraft();

  const post = calls.find((c) => c.path === "/api/drafts/d1/topology/operations/batch");
  assert.deepEqual(post.body.operations, [
    { kind: "update-device", deviceName: "sw1", device: { name: "sw1", kind: "switch" } },
    { kind: "union-add-device", unionName: "hq", deviceName: "sw1" },
  ]);
  assert.equal(page.devices[1].union, "hq");
});

test("saveDraft removing a device from its union sends only the remove op", async () => {
  const { page, calls } = await bootLoadedPage();
  page.draft = { index: 0, name: "r1", description: "граничный", union: "" };

  await page.saveDraft();

  const post = calls.find((c) => c.path === "/api/drafts/d1/topology/operations/batch");
  assert.deepEqual(post.body.operations, [
    { kind: "update-device", deviceName: "r1", device: { name: "r1", kind: "router", description: "граничный" } },
    { kind: "union-remove-device", unionName: "hq", deviceName: "r1" },
  ]);
  assert.equal(page.devices[0].union, "");
});

test("removeDevice deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.removeDevice(0);

  const post = calls.find((c) => c.path === "/api/drafts/d1/topology/operations" && c.method === "POST");
  assert.deepEqual(post.body, { kind: "delete-device", deviceName: "r1" });
  assert.deepEqual(page.devices.map((d) => d.name), ["sw1"]);
});

test("filteredDevices matches by name, union and description", async () => {
  const { page } = await bootLoadedPage();

  page.filters = { ...page.filters, name: "R1" };
  assert.deepEqual(page.filteredDevices.map((d) => d.device.name), ["r1"]);

  page.filters = { ...page.filters, name: "", union: "hq" };
  assert.deepEqual(page.filteredDevices.map((d) => d.device.name), ["r1"]);

  page.filters = { ...page.filters, union: "", description: "гранич" };
  assert.deepEqual(page.filteredDevices.map((d) => d.device.name), ["r1"]);

  page.resetFilters();
  assert.deepEqual(page.filteredDevices.map((d) => d.device.name), ["r1", "sw1"]);
});

test("saveDraft is blocked while read-only (no active draft)", async () => {
  const { page, calls, store } = await bootLoadedPage();
  delete store["firenet-draft-id"];
  page.draft = { index: 0, name: "r1", description: "", union: "" };
  await page.saveDraft();
  assert.equal(calls.filter((c) => c.path.includes("operations")).length, 0);
});

// --- плавающее окно на холсте топологии (ПКМ по устройству → «Редактировать») ---
// Позиционирование/клэмп/drag/мировая привязка теперь общий floating_panel.js
// (см. floating_panel.test.js) — здесь проверяется только то, что
// devicesPage заполняет draft и делегирует открытие/закрытие своему _panel
// (инстанс, который topology.js создаёт и кладёт на this._panel — см.
// Topology.openDeviceEditWindow).

test("openDeviceEdit fills the draft and opens the canvas window via _panel", async () => {
  const { page } = await bootLoadedPage();
  const opens = [];
  page._panel = { open: (at) => opens.push(at), close: () => {} };

  page.openDeviceEdit("sw1", { x: 150, y: 200 });

  assert.deepEqual(page.draft, { index: 1, name: "sw1", description: "", union: "" });
  assert.deepEqual(opens, [{ x: 150, y: 200 }], "canvas window opened at the click point");
});

test("saveDraft delegates to the injected save port and closes the canvas window", async () => {
  const { page, calls, getFixture } = await bootLoadedPage();
  const portOps = [];
  let closed = false;
  page.$refs = {};
  page._panel = { open() {}, close: () => { closed = true; } };
  page._savePort = async (ops) => {
    portOps.push(ops);
    return { topology: { ...getFixture(), devices: [{ name: "core-1", kind: "router", description: "новый узел" }, { name: "sw1", kind: "switch" }] } };
  };
  page.draft = { index: 0, name: "core-1", description: "новый узел", union: "hq" };

  await page.saveDraft();

  assert.deepEqual(portOps, [[
    { kind: "update-device", deviceName: "r1", device: { name: "core-1", kind: "router", description: "новый узел" } },
  ]]);
  assert.equal(
    calls.filter((c) => c.path === "/api/drafts/d1/topology/operations/batch" && c.method === "POST").length,
    0,
    "no direct POST when a port is injected",
  );
  assert.equal(page.devices[0].name, "core-1");
  assert.ok(closed, "canvas window closed after save");
});

test("saveDraft keeps the canvas window open when the port fails", async () => {
  const { page, banners } = await bootLoadedPage();
  let closed = false;
  page.$refs = {};
  page._panel = { open() {}, close: () => { closed = true; } };
  page._savePort = async () => { throw new Error("boom"); };
  page.openDeviceEdit("r1", { x: 100, y: 100 });

  await page.saveDraft();

  assert.match(banners.at(-1)?.message, /Ошибка сохранения/);
  assert.ok(!closed, "window stays open with the draft intact");
});
