"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCamera() {
  const sandbox = {};
  vm.createContext(sandbox);
  // top-level `const` lives in the script scope, not on globalThis
  return vm.runInContext(fs.readFileSync(path.join(__dirname, "camera.js"), "utf8") + "\nCamera", sandbox);
}

// objects created inside the vm have a foreign prototype; copy own fields
const pt = (p) => ({ x: p.x, y: p.y });

test("identity camera maps screen to world unchanged", () => {
  const Camera = loadCamera();
  const cam = Camera.create();
  assert.deepEqual(pt(Camera.screenToWorld(cam, 120, 80)), { x: 120, y: 80 });
});

test("panned camera shifts world coordinates", () => {
  const Camera = loadCamera();
  const cam = { x: -500, y: -300, z: 1 };
  assert.deepEqual(pt(Camera.screenToWorld(cam, 120, 80)), { x: 620, y: 380 });
});

test("worldToScreen is the inverse of screenToWorld", () => {
  const Camera = loadCamera();
  const cam = { x: -137.5, y: 42.25, z: 1.75 };
  const w = Camera.screenToWorld(cam, 90, 60);
  assert.deepEqual(pt(Camera.worldToScreen(cam, w.x, w.y)), { x: 90, y: 60 });
});

test("zoomAt keeps the point under the cursor stationary", () => {
  const Camera = loadCamera();
  const cam = { x: -100, y: 40, z: 1 };
  const before = pt(Camera.screenToWorld(cam, 320, 240));
  const zoomed = Camera.zoomAt(cam, 320, 240, 2);
  assert.equal(zoomed.z, 2);
  const after = pt(Camera.screenToWorld(zoomed, 320, 240));
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test("zoomAt clamps zoom into bounds", () => {
  const Camera = loadCamera();
  const min = Camera.zoomAt(Camera.create(), 0, 0, 1e-6);
  const max = Camera.zoomAt(Camera.create(), 0, 0, 1e6);
  assert.equal(min.z, Camera.MIN_ZOOM);
  assert.equal(max.z, Camera.MAX_ZOOM);
});

test("transform renders translate+scale for SVG viewport group", () => {
  const Camera = loadCamera();
  assert.equal(Camera.transform({ x: 10, y: -20, z: 0.5 }), "translate(10 -20) scale(0.5)");
});

// Стейдж: svg с запасом (overscan m), сдвинутый на (-m,-m) относительно
// контейнера; камера применяется CSS-трансформой и композитится GPU без
// перерисовки сцены. Контракт: контейнерная точка = world*z + cam.
test("stageTransform maps stage pixels so the container shows the camera view", () => {
  const Camera = loadCamera();
  const cam = { x: -40, y: 15, z: 2 };
  const t = Camera.stageTransform(cam, { x: 0, y: 0 }, 100);
  assert.equal(t, "translate(60px, 115px) scale(2)");
});

// Смещение сцены o (в мировых координатах) учитывается в трансформе:
// контейнерная точка = (world + o)*z + T - m должна равняться world*z + cam
test("stageTransform compensates the scene origin offset", () => {
  const Camera = loadCamera();
  const cam = { x: 0, y: 0, z: 1 };
  const t = Camera.stageTransform(cam, { x: 300, y: -200 }, 100);
  assert.equal(t, "translate(-200px, 300px) scale(1)");
});

test("fitView centers bounds with padding", () => {
  const Camera = loadCamera();
  const b = { minX: 0, minY: 0, maxX: 400, maxY: 200 };
  const cam = Camera.fitView(Camera.create(), b, 800, 400, 50);
  // вписывание без увеличения: натянутый масштаб 1.5 ограничен единицей
  assert.equal(cam.z, 1);
  // центр мира (200,100) оказывается в центре вьюпорта
  const c = pt(Camera.worldToScreen(cam, 200, 100));
  assert.equal(c.x, 400);
  assert.equal(c.y, 200);
});

test("fitView never zooms in beyond 1", () => {
  const Camera = loadCamera();
  const cam = Camera.fitView(Camera.create(), { minX: 0, minY: 0, maxX: 100, maxY: 50 }, 800, 400, 50);
  assert.equal(cam.z, 1, "tiny scenes are centered, not magnified");
});
