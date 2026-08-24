"use strict";

// Unit-тесты ввода холста: CameraControls сам помечает канвас классом
// .panning на время пана, чтобы страницы гасили дорогую отделку сцены.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag) {
  const el = {
    tag,
    attrs: {},
    listeners: {},
    _classes: new Set(),
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
  };
  el.classList = {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

const fire = (target, type, ev) => {
  ev.type = type;
  ev.preventDefault ||= () => {};
  (target.listeners[type] || []).forEach((fn) => fn(ev));
};

function boot() {
  const doc = makeEl("#document");
  const sandbox = { document: doc };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["camera.js", "camera_input.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  const svg = makeEl("svg");
  const Controls = vm.runInContext("CameraControls", sandbox);
  let cam = { x: 0, y: 0, z: 1 };
  const wire = (buttons, opts = {}) => Controls.wire(svg, {
    getCam: () => cam,
    setCam: (c) => { cam = c; },
    buttons,
    ...opts,
  });
  return { doc, svg, wire, cam: () => cam };
}

test("pan drag marks the canvas with the panning class until release", () => {
  const { doc, svg, wire } = boot();
  wire([1, 2]);
  assert.ok(!svg.classList.contains("panning"));
  fire(svg, "mousedown", { button: 2, clientX: 10, clientY: 10 });
  assert.ok(svg.classList.contains("panning"), "drag start sheds expensive styling");
  fire(doc, "mousemove", { clientX: 40, clientY: 30 });
  assert.ok(svg.classList.contains("panning"), "class persists while moving");
  fire(doc, "mouseup", {});
  assert.ok(!svg.classList.contains("panning"), "release restores styling");
});

test("non-pan buttons never mark the canvas as panning", () => {
  const { doc, svg, wire } = boot();
  wire([1, 2]);
  fire(svg, "mousedown", { button: 0, clientX: 10, clientY: 10 });
  assert.ok(!svg.classList.contains("panning"), "left click stays clean");
  fire(doc, "mouseup", {});
});

// Стейдж-канва сдвинута и трансформирована относительно контейнера, поэтому
// координаты указателя обязаны браться из прямоугольника контейнера (rectEl),
// а не самого svg — иначе зум якорится не под курсором
test("pointer coordinates come from rectEl when given", () => {
  const { doc, svg, wire, cam } = boot();
  const clip = makeEl("div");
  clip.getBoundingClientRect = () => ({ left: 25, top: 50, width: 1200, height: 800 });
  svg.getBoundingClientRect = () => ({ left: -100, top: -200, width: 3600, height: 3200 });
  wire([1, 2], { rectEl: clip });
  fire(svg, "mousedown", { button: 2, clientX: 125, clientY: 150 });
  fire(doc, "mousemove", { clientX: 175, clientY: 180 });
  fire(doc, "mouseup", {});
  const c = cam();
  assert.deepEqual({ x: c.x, y: c.y, z: c.z }, { x: 50, y: 30, z: 1 }, "pan by pointer delta relative to the clip");
});
