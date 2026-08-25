"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
for (const f of ["netmap.js", "canvas_theme.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox);
const CanvasTheme = vm.runInContext("CanvasTheme", sandbox);

const VARS = {
  "--panel-bg": "#f6f6f8", "--border": "#d8d8dc", "--accent": "#2563eb",
  "--muted": "#6b6b6b", "--text": "#1a1a1a",
  "--kind-router": "#d97706", "--kind-switch": "#7c3aed", "--kind-network": "#16a34a",
};

test("create maps css vars onto theme fields", () => {
  const t = CanvasTheme.create(VARS);
  assert.equal(t.panel, "#f6f6f8");
  assert.equal(t.kind.router, "#d97706");
  assert.equal(t.radius.router, 16);
  assert.equal(t.radius.default, 6);
});

// тема самодостаточна: загрузка без глобального NetMap не падает
test("theme loads standalone, without the global NetMap", () => {
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "canvas_theme.js"), "utf8"), sb);
  const T = vm.runInContext("CanvasTheme", sb);
  assert.equal(T.create({}).textHideZoom, 0.5);
});

test("fromComputed reads css variables via getPropertyValue", () => {
  const t = CanvasTheme.fromComputed({ getPropertyValue: (n) => VARS[n] ?? "" });
  assert.equal(t.accent, "#2563eb");
  assert.equal(t.kind.network, "#16a34a");
});

test("lerpHex blends colors and clamps t", () => {
  const t = CanvasTheme.create(VARS);
  assert.equal(t.lerpHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(t.lerpHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(t.lerpHex("#000000", "#ffffff", 2), "#ffffff");
});
