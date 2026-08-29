"use strict";

// Unit-тесты ввода холста: зум колесом и пан перетаскиванием.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

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

(async () => {
  // camera_input.js читает Camera как bare global (zoomAt внутри schedule)
  const { Camera } = await import(path.join(__dirname, "camera.js"));
  global.Camera = Camera;
  const { CameraControls: Controls } = await import(path.join(__dirname, "camera_input.js"));

  function boot() {
    const doc = makeEl("#document");
    global.document = doc;
    const svg = makeEl("svg");
    let cam = { x: 0, y: 0, z: 1 };
  const wire = (buttons, opts = {}) => Controls.wire(svg, {
    getCam: () => cam,
    setCam: (c) => { cam = c; },
    buttons,
    ...opts,
  });
  return { doc, svg, wire, cam: () => cam };
}

// Координаты указателя берутся из прямоугольника холста: зум и пан
// считаются относительно него, а не окна.
  test("pan applies the pointer delta relative to the canvas rect", () => {
    const { doc, svg, wire, cam } = boot();
    svg.getBoundingClientRect = () => ({ left: -100, top: -200, width: 1200, height: 800 });
    wire([1, 2]);
    fire(svg, "mousedown", { button: 2, clientX: 125, clientY: 150 });
    fire(doc, "mousemove", { clientX: 175, clientY: 180 });
    fire(doc, "mouseup", {});
    const c = cam();
    assert.deepEqual({ x: c.x, y: c.y, z: c.z }, { x: 50, y: 30, z: 1 }, "pan by pointer delta relative to the rect");
  });
})();
