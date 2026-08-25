"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// самодостаточный запуск кода модуля без vm: hit_test не зависит ни от чего
const src = require("fs").readFileSync(require("path").join(__dirname, "hit_test.js"), "utf8");
const HitTest = new Function(src + "\n;return HitTest;")();

test("bbox covers rect and path extremes", () => {
  assert.deepEqual(HitTest.bbox({ kind: "rrect", geom: { x: 10, y: 20, w: 140, h: 60 } }),
    { x: 6, y: 16, w: 148, h: 68 });
  const path = { kind: "path", geom: { segs: [
    { x1: 0, y1: 0, cx: 50, cy: -30, x2: 100, y2: 0 },
  ] } };
  const b = HitTest.bbox(path);
  assert.equal(b.x, -4);
  assert.ok(b.y < -20, "control point pulls bbox up");
});

test("pick returns topmost pickable item under the point", () => {
  const list = [
    { kind: "rrect", geom: { x: 0, y: 0, w: 140, h: 60 }, pick: true, nodeType: "device", name: "back" },
    { kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 70, cy: 0, x2: 300, y2: 0 }] }, pick: true, name: "wire" },
    { kind: "rrect", geom: { x: 0, y: 0, w: 140, h: 60 }, pick: true, nodeType: "device", name: "front" },
    { kind: "text", geom: { x: 400, y: 0, w: 100 }, name: "label" },
  ];
  assert.equal(HitTest.pick(list, { x: 70, y: 30 }, 1).name, "front", "nodes beat wires");
  assert.equal(HitTest.pick(list, { x: 250, y: 1 }, 1).name, "wire", "wire within hitWidth");
  assert.equal(HitTest.pick(list, { x: 250, y: 40 }, 1), null, "too far from the curve");
  assert.equal(HitTest.pick(list, { x: 450, y: 5 }, 1), null, "text is never picked");
});

test("pick widens with zoom-out", () => {
  const wire = { kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 50, cy: 0, x2: 100, y2: 0 }] }, pick: true };
  assert.equal(HitTest.pick([wire], { x: 50, y: 20 }, 0.5), wire, "farther tolerance at z=0.5");
});

test("pickNodes intersects bboxes with the marquee rect", () => {
  const a = { kind: "rrect", geom: { x: 0, y: 0, w: 140, h: 60 }, pick: true, nodeType: "device" };
  const b = { kind: "rrect", geom: { x: 500, y: 0, w: 140, h: 60 }, pick: true, nodeType: "network" };
  const w = { kind: "path", geom: { segs: [] }, pick: true };
  assert.deepEqual(HitTest.pickNodes([a, b, w], { x: -10, y: -10, w: 200, h: 100 }), [a]);
  assert.deepEqual(HitTest.pickNodes([a, b], { x: -10, y: -10, w: 700, h: 100 }), [a, b]);
});
