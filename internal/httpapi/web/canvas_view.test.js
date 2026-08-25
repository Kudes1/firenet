"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// recorder: ctx-стаб, записывающий вызовы методов canvas 2d context
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

function boot(list, cam, getOverlay) {
  const canvas = {
    clientWidth: 1200, clientHeight: 800, style: {},
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    getContext: () => makeCtx(),
  };
  const sandbox = {
    console, canvas,
    window: { addEventListener() {}, devicePixelRatio: 1 },
    Path2D: class {},               // стаб для kind:"glyph"
    requestAnimationFrame: undefined, // синхронный режим тестов
  };
  vm.createContext(sandbox);
  for (const f of ["hit_test.js", "canvas_view.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox);
  const CanvasView = vm.runInContext("CanvasView", sandbox);
  const view = CanvasView.create(canvas, { getList: () => list, getCam: () => cam, getOverlay });
  return { view, canvas, lastCtx: () => view._ctxForTest() };
}

const CAM = { x: 0, y: 0, z: 1 };

test("draw applies camera transform and paints primitives", () => {
  const list = [
    { kind: "rrect", geom: { x: 10, y: 10, w: 140, h: 60, r: 6 }, style: { stroke: "#111", lineWidth: 1.5, fill: "#fff" } },
    { kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 50, cy: 0, x2: 100, y2: 0 }] }, style: { stroke: "#222", lineWidth: 1.5 } },
    { kind: "glyph", geom: { d: "M2.5 6a3.5 3.5 0 1 1 0 .01", x: 20, y: 30 }, style: { stroke: "#111" } },
    { kind: "text", geom: { x: 10, y: 20, w: 90 }, text: true, text: "hello", style: { font: "12px x", fill: "#333" } },
  ];
  const { view, lastCtx } = boot(list, { x: 100, y: 50, z: 2 });
  view.draw();
  const calls = lastCtx().calls;
  const names = calls.map((c) => c[0]);
  // draw() вызывает setTransform дважды (сброс dpr + камера); проверяем последний
  const tf = calls.filter((c) => c[0] === "setTransform").pop();
  assert.deepEqual(tf[1], [2, 0, 0, 2, 100, 50], "camera transform is the final one");
  assert.ok(names.includes("roundRect") || names.includes("rect"), "shape traced");
  assert.ok(names.includes("quadraticCurveTo"), "curve traced");
  assert.ok(calls.some((c) => c[0] === "stroke" && c[1][0] && typeof c[1][0] === "object"), "glyph stroked via Path2D");
  assert.ok(calls.some((c) => c[0] === "fillText" && c[1][0] === "hello"), "text painted");
});

test("offscreen primitives are culled", () => {
  const far = { kind: "rrect", geom: { x: 90000, y: 90000, w: 140, h: 60, r: 6 }, style: {} };
  const near = { kind: "rrect", geom: { x: 10, y: 10, w: 140, h: 60, r: 6 }, style: {} };
  const { view, lastCtx } = boot([far, near], { x: 0, y: 0, z: 1 });
  view.draw();
  const names = lastCtx().calls.map((c) => c[0]);
  assert.ok(names.includes("roundRect") || names.includes("rect"));
  const traceCalls = lastCtx().calls.filter((c) => c[0] === "roundRect" || c[0] === "rect");
  assert.equal(traceCalls.length, 1, "only the visible shape traced");
});

test("overlay draws after the scene", () => {
  const scene = [{ kind: "rrect", geom: { x: 0, y: 0, w: 10, h: 10, r: 0 }, style: {} }];
  const over = [{ kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 5, cy: 5, x2: 10, y2: 10 }] }, style: {} }];
  const { view, lastCtx } = boot(scene, CAM, () => over);
  view.draw();
  const names = lastCtx().calls.map((c) => c[0]);
  assert.ok(names.lastIndexOf("quadraticCurveTo") > names.indexOf("roundRect"), "overlay last");
});
