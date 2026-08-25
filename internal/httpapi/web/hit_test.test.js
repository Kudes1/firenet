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

// замкнутое залитое облако (квадратики с выпуклыми рёбрами вокруг центра)
const cloudSegs = (cx, cy) => [
  { x1: cx, y1: cy - 50, cx: cx + 50, cy: cy - 50, x2: cx + 50, y2: cy },
  { x1: cx + 50, y1: cy, cx: cx + 50, cy: cy + 50, x2: cx, y2: cy + 50 },
  { x1: cx, y1: cy + 50, cx: cx - 50, cy: cy + 50, x2: cx - 50, y2: cy },
  { x1: cx - 50, y1: cy, cx: cx - 50, cy: cy - 50, x2: cx, y2: cy - 50 },
];

test("closed filled path picks by area inside the outline", () => {
  const net = { kind: "path", geom: { segs: cloudSegs(100, 100), closed: true }, style: { fill: "#fff" }, pick: true, name: "net" };
  assert.equal(HitTest.pick([net], { x: 100, y: 100 }, 1).name, "net", "center of the cloud is a hit");
  assert.equal(HitTest.pick([net], { x: 130, y: 90 }, 1).name, "net", "off-center interior too");
});

test("open or unfilled paths stay outline-only picks", () => {
  const bare = { kind: "path", geom: { segs: cloudSegs(100, 100) }, pick: true, name: "bare" };
  const hollow = { kind: "path", geom: { segs: cloudSegs(100, 100), closed: true }, pick: true, name: "hollow" };
  // центр в ~50px от кривой — дальше порога
  for (const it of [bare, hollow]) {
    assert.equal(HitTest.pick([it], { x: 100, y: 100 }, 1), null, `${it.name}: interior is not a hit`);
    assert.equal(HitTest.pick([it], { x: 100, y: 53 }, 1).name, it.name, `${it.name}: near the outline still hits`);
  }
});

test("pickNodes keeps bbox semantics for closed shapes", () => {
  const net = {
    kind: "path", geom: { segs: cloudSegs(100, 100), closed: true },
    style: { fill: "#fff" }, pick: true, nodeType: "network",
  };
  // прямоугольник внутри облака не касается контура — узел всё равно выбирается
  assert.deepEqual(HitTest.pickNodes([net], { x: 95, y: 95, w: 10, h: 10 }), [net]);
});
