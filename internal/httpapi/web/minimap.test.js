"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMinimap(sandbox = {}) {
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["camera.js", "minimap.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
  }
  return vm.runInContext("Minimap", sandbox);
}

// worldToScreen mirrors Camera's transform without needing the vm's Camera
// in this file's own scope.
const worldToScreen = (map, wx, wy) => ({ x: wx * map.z + map.x, y: wy * map.z + map.y });
const screenToWorld = (cam, sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
// vm objects have a foreign prototype; copy own fields before deepEqual
const rect = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });

test("layout centers a wide bbox constrained by width", () => {
  const Minimap = loadMinimap();
  const map = Minimap.layout({ minX: 0, minY: 0, maxX: 400, maxY: 200 }, 200, 120, 10);
  assert.equal(map.z, 0.45, "width is the tighter constraint: (200-20)/400");
  assert.deepEqual(worldToScreen(map, 200, 100), { x: 100, y: 60 }, "bbox center maps to box center");
});

test("layout centers a tall bbox constrained by height", () => {
  const Minimap = loadMinimap();
  const map = Minimap.layout({ minX: 0, minY: 0, maxX: 100, maxY: 300 }, 200, 120, 10);
  assert.equal(map.z, 100 / 300, "height is the tighter constraint: (120-20)/300");
  assert.deepEqual(worldToScreen(map, 50, 150), { x: 100, y: 60 }, "bbox center maps to box center");
});

test("overflows is false without bounds", () => {
  const Minimap = loadMinimap();
  assert.equal(Minimap.overflows(null, { x: 0, y: 0, z: 1 }, 1200, 800), false);
});

test("overflows is false when the bbox fits the viewport at the current zoom", () => {
  const Minimap = loadMinimap();
  const b = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
  assert.equal(Minimap.overflows(b, { x: 0, y: 0, z: 1 }, 1200, 800), false);
});

test("overflows is true when the bbox is wider than the viewport at the current zoom", () => {
  const Minimap = loadMinimap();
  const b = { minX: 0, minY: 0, maxX: 4000, maxY: 300 };
  assert.equal(Minimap.overflows(b, { x: 0, y: 0, z: 1 }, 1200, 800), true);
});

test("overflows accounts for zoom: zooming out can make an overflowing bbox fit", () => {
  const Minimap = loadMinimap();
  const b = { minX: 0, minY: 0, maxX: 4000, maxY: 300 };
  assert.equal(Minimap.overflows(b, { x: 0, y: 0, z: 0.2 }, 1200, 800), false);
});

test("viewportRect projects the visible world rect into minimap space", () => {
  const Minimap = loadMinimap();
  // map: identity scale 0.1, no offset — world (0..4000,0..3000) covers the
  // whole 400x300 minimap box.
  const map = { x: 0, y: 0, z: 0.1 };
  // camera: identity — the viewport shows world (0,0)..(1200,800)
  const r = Minimap.viewportRect(map, { x: 0, y: 0, z: 1 }, 1200, 800);
  assert.deepEqual(rect(r), { x: 0, y: 0, w: 120, h: 80 });
});

test("viewportRect follows a panned and zoomed camera", () => {
  const Minimap = loadMinimap();
  const map = { x: 0, y: 0, z: 0.1 };
  // camera zoomed 2x and panned so world origin sits at screen (-200,-100)
  const r = Minimap.viewportRect(map, { x: -200, y: -100, z: 2 }, 1200, 800);
  assert.deepEqual(rect(r), { x: 10, y: 5, w: 60, h: 40 });
});

// --- create()/update(): DOM stub sufficient to drive minimap.js outside a browser ---

function makeCtx() {
  const calls = [];
  const handler = {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => calls.push([prop, args]);
    },
    set(t, prop, v) { t[prop] = v; calls.push(["set:" + prop, [v]]); return true; },
  };
  const ctx = new Proxy({}, handler);
  ctx.calls = calls;
  return ctx;
}

function makeEl(tag) {
  const el = {
    tag, hidden: false, style: {}, listeners: {},
    clientWidth: 200, clientHeight: 120,
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
    getContext() { return this._ctx ||= makeCtx(); },
  };
  return el;
}

const fire = (target, type, ev) => {
  ev.type = type;
  (target.listeners[type] || []).forEach((fn) => fn(ev));
};

function boot(opts) {
  const canvas = makeEl("canvas");
  const doc = makeEl("#document");
  const sandbox = { console, document: doc, window: { addEventListener() {}, devicePixelRatio: 1 } };
  const Minimap = loadMinimap(sandbox);
  const mm = Minimap.create(canvas, opts);
  return { canvas, doc, mm };
}

test("update hides the minimap when the scene has no bounds", () => {
  const { canvas, mm } = boot({
    getBounds: () => null,
    getPoints: () => [],
    getCam: () => ({ x: 0, y: 0, z: 1 }),
    setCam: () => {},
    getViewport: () => ({ w: 1200, h: 800 }),
  });
  canvas.hidden = false;
  mm.update();
  assert.equal(canvas.hidden, true);
});

test("update hides the minimap when the scene fits the viewport", () => {
  const { canvas, mm } = boot({
    getBounds: () => ({ minX: 0, minY: 0, maxX: 400, maxY: 300 }),
    getPoints: () => [],
    getCam: () => ({ x: 0, y: 0, z: 1 }),
    setCam: () => {},
    getViewport: () => ({ w: 1200, h: 800 }),
  });
  mm.update();
  assert.equal(canvas.hidden, true);
});

test("update shows and draws points plus the viewport rect when the scene overflows", () => {
  const { canvas, mm } = boot({
    getBounds: () => ({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }),
    getPoints: () => [{ x: 0, y: 0 }, { x: 4000, y: 3000 }],
    getCam: () => ({ x: 0, y: 0, z: 1 }),
    setCam: () => {},
    getViewport: () => ({ w: 1200, h: 800 }),
  });
  mm.update();
  assert.equal(canvas.hidden, false);
  const calls = canvas._ctx.calls.map((c) => c[0]);
  assert.equal(calls.filter((c) => c === "arc").length, 2, "one arc per point");
  assert.ok(calls.includes("strokeRect"), "viewport rect stroked");
  assert.ok(calls.includes("clearRect"), "cleared before redraw");
});

test("draw takes point and viewport colors from the page theme, not a CSS keyword", () => {
  const { canvas, mm } = boot({
    getBounds: () => ({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }),
    getPoints: () => [{ x: 0, y: 0 }],
    getCam: () => ({ x: 0, y: 0, z: 1 }),
    setCam: () => {},
    getViewport: () => ({ w: 1200, h: 800 }),
    getTheme: () => ({ muted: "#6b6b6b", accent: "#2563eb" }),
  });
  mm.update();
  const sets = canvas._ctx.calls.filter((c) => c[0].startsWith("set:"));
  assert.ok(sets.some((c) => c[0] === "set:fillStyle" && c[1][0] === "#6b6b6b"), "points use the theme's muted color");
  assert.ok(sets.some((c) => c[0] === "set:strokeStyle" && c[1][0] === "#2563eb"), "viewport rect uses the theme's accent color");
  assert.ok(!sets.some((c) => String(c[1][0]).includes("currentColor")), "never a CSS keyword canvas can't resolve");
});

test("clicking the minimap recenters the camera on the clicked world point, keeping zoom", () => {
  let cam = { x: 0, y: 0, z: 2 };
  const { canvas, mm } = boot({
    getBounds: () => ({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }),
    getPoints: () => [],
    getCam: () => cam,
    setCam: (c) => { cam = c; },
    getViewport: () => ({ w: 1200, h: 800 }),
  });
  mm.update(); // computes the world<->minimap mapping used by the click
  fire(canvas, "mousedown", { button: 0, clientX: 100, clientY: 60 });
  // clicked point (100,60) in the 200x120 box maps back to a world point that
  // the camera now centers on screen, at unchanged zoom.
  const world = screenToWorld(cam, 600, 400);
  assert.equal(cam.z, 2, "zoom unchanged");
  assert.ok(Math.abs(world.x - 2000) < 1e-6 && Math.abs(world.y - 1500) < 1e-6, "the click's world point is now centered");
});

test("dragging after mousedown keeps moving the camera; mouseup stops it", () => {
  let cam = { x: 0, y: 0, z: 1 };
  const setCam = (c) => { cam = c; };
  const { canvas, doc, mm } = boot({
    getBounds: () => ({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }),
    getPoints: () => [],
    getCam: () => cam,
    setCam,
    getViewport: () => ({ w: 1200, h: 800 }),
  });
  mm.update();
  fire(canvas, "mousedown", { button: 0, clientX: 100, clientY: 60 });
  const afterClick = cam;
  fire(doc, "mousemove", { clientX: 120, clientY: 60 });
  assert.notDeepEqual(cam, afterClick, "drag keeps updating the camera");
  const afterDrag = cam;
  fire(doc, "mouseup", {});
  fire(doc, "mousemove", { clientX: 10, clientY: 10 });
  assert.deepEqual(cam, afterDrag, "mouseup stops the drag");
});
