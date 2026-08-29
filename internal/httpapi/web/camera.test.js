"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function loadCamera() {
  const { Camera } = await import(path.join(__dirname, "camera.js"));
  return Camera;
}

// objects created by the module have a normal prototype now; pt() is no
// longer needed for deepEqual, but kept so the rest of the file (below) is
// untouched
const pt = (p) => ({ x: p.x, y: p.y });

(async () => {
  test("identity camera maps screen to world unchanged", async () => {
    const Camera = await loadCamera();
    const cam = Camera.create();
    assert.deepEqual(pt(Camera.screenToWorld(cam, 120, 80)), { x: 120, y: 80 });
  });

  test("panned camera shifts world coordinates", async () => {
    const Camera = await loadCamera();
    const cam = { x: -500, y: -300, z: 1 };
    assert.deepEqual(pt(Camera.screenToWorld(cam, 120, 80)), { x: 620, y: 380 });
  });

  test("worldToScreen is the inverse of screenToWorld", async () => {
    const Camera = await loadCamera();
    const cam = { x: -137.5, y: 42.25, z: 1.75 };
    const w = Camera.screenToWorld(cam, 90, 60);
    assert.deepEqual(pt(Camera.worldToScreen(cam, w.x, w.y)), { x: 90, y: 60 });
  });

  test("zoomAt keeps the point under the cursor stationary", async () => {
    const Camera = await loadCamera();
    const cam = { x: -100, y: 40, z: 1 };
    const before = pt(Camera.screenToWorld(cam, 320, 240));
    const zoomed = Camera.zoomAt(cam, 320, 240, 2);
    assert.equal(zoomed.z, 2);
    const after = pt(Camera.screenToWorld(zoomed, 320, 240));
    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.y - before.y) < 1e-9);
  });

  test("zoomAt clamps zoom into bounds", async () => {
    const Camera = await loadCamera();
    const min = Camera.zoomAt(Camera.create(), 0, 0, 1e-6);
    const max = Camera.zoomAt(Camera.create(), 0, 0, 1e6);
    assert.equal(min.z, Camera.MIN_ZOOM);
    assert.equal(max.z, Camera.MAX_ZOOM);
  });

  test("fitView centers bounds with padding", async () => {
    const Camera = await loadCamera();
    const b = { minX: 0, minY: 0, maxX: 400, maxY: 200 };
    const cam = Camera.fitView(Camera.create(), b, 800, 400, 50);
    // вписывание без увеличения: натянутый масштаб 1.5 ограничен единицей
    assert.equal(cam.z, 1);
    // центр мира (200,100) оказывается в центре вьюпорта
    const c = pt(Camera.worldToScreen(cam, 200, 100));
    assert.equal(c.x, 400);
    assert.equal(c.y, 200);
  });

  test("fitView never zooms in beyond 1", async () => {
    const Camera = await loadCamera();
    const cam = Camera.fitView(Camera.create(), { minX: 0, minY: 0, maxX: 100, maxY: 50 }, 800, 400, 50);
    assert.equal(cam.z, 1, "tiny scenes are centered, not magnified");
  });
})();
