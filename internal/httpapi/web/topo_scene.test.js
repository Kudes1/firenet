"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
for (const f of ["netmap.js", "canvas_theme.js", "topo_scene.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox);
const { TopoScene, CanvasTheme } = vm.runInContext("({ TopoScene, CanvasTheme })", sandbox);

const theme = CanvasTheme.create({
  "--panel-bg": "#f6f6f8", "--border": "#d8d8dc", "--accent": "#2563eb",
  "--muted": "#6b6b6b", "--text": "#1a1a1a",
  "--kind-router": "#d97706", "--kind-switch": "#7c3aed", "--kind-network": "#16a34a",
});

const scene = () => ({
  topology: {
    devices: [{ name: "r1", kind: "router" }],
    links: [],
    networks: [{ name: "lan", subnets: [], attach: [{ device: "r1" }] }],
    unions: [],
  },
  subnets: [],
  layout: { devices: { r1: { x: 40, y: 40 } }, networks: { lan: { x: 40, y: 300 } } },
});

test("buildScene emits ordered primitives with refs", () => {
  const { list } = TopoScene.buildScene(scene(), { theme });
  const kinds = list.map((i) => i.kind);
  assert.deepEqual(kinds.filter((k, i) => true), kinds); // sanity
  const dev = list.find((i) => i.id === "device:r1");
  assert.equal(dev.nodeType, "device");
  assert.equal(dev.pick, true);
  assert.equal(dev.style.stroke, "#d97706", "router stroke from kind palette");
  const att = list.find((i) => i.id === "attach:lan|r1");
  assert.ok(att && att.pick, "attachment is pickable");
  const net = list.find((i) => i.id === "network:lan");
  assert.equal(net.geom.closed, true, "network cloud is a closed path");
  const label = list.find((i) => i.kind === "text" && i.text === "r1 (router)");
  assert.ok(label, "device label emitted");
  // порядок: сеть-узлы после связей
  assert.ok(list.indexOf(net) > list.indexOf(att), "network above attachments");
});

test("states resolve into resolved styles", () => {
  const opts = {
    theme,
    classes: (obj) => (obj.name === "r1" ? " selected" : ""),
    dim: () => false,
  };
  const { list } = TopoScene.buildScene(scene(), opts);
  const dev = list.find((i) => i.id === "device:r1");
  assert.equal(dev.style.stroke, "#2563eb", "selected stroke");
  assert.equal(dev.style.lineWidth, 2.5);
});

test("filtered link carries dash and filter meta", () => {
  const s = scene();
  s.topology.devices.push({ name: "r2", kind: "router" });
  s.layout.devices.r2 = { x: 200, y: 40 };
  s.topology.links = [{ a: { device: "r1" }, b: { device: "r2" }, filter: { aExports: ["N1"], bExports: ["N2"] } }];
  const { list } = TopoScene.buildScene(s, { theme });
  const link = list.find((i) => i.id === "link:r1|r2");
  assert.deepEqual([...link.style.dash], [6, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(link.meta.filter)), { a: "r1", b: "r2", aExports: ["N1"], bExports: ["N2"] });
});

test("fade.dim scales dimming progress", () => {
  // дефолт fade.dim = 1: без переданного fade состояние применено полностью
  // (та же семантика, что у flow — страницы без анимации не передают fade)
  const full = TopoScene.buildScene(scene(), { theme, mark: () => "search-dim" }).list;
  const dev = full.find((i) => i.id === "device:r1");
  assert.ok(dev.style.alpha < 0.5, "no fade means fully dimmed");
  const start = TopoScene.buildScene(scene(), { theme, mark: () => "search-dim", fade: { dim: 0 } }).list;
  const dev2 = start.find((i) => i.id === "device:r1");
  assert.equal(dev2.style.alpha, 1, "dim=0 keeps full alpha");
});

test("popOf scales node geometry around center", () => {
  const { list } = TopoScene.buildScene(scene(), { theme, popOf: (id) => (id === "device:r1" ? 0 : undefined) });
  const dev = list.find((i) => i.id === "device:r1");
  assert.ok(dev.geom.w < 140, "shrunk at p=0");
  assert.ok(dev.style.alpha < 1, "transparent at p=0");
});

test("bounds covers all layout positions", () => {
  const s = scene();
  const b = TopoScene.bounds(s.topology, s.layout);
  assert.equal(b.minX, 40);
  assert.ok(b.maxX >= 200, "includes network width");
});
