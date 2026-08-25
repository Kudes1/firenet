"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "netmap.js"), "utf8"), sandbox);
const NetMap = vm.runInContext("NetMap", sandbox);

test("cloudSegs outlines the bbox with quadratic segments", () => {
  const segs = NetMap.cloudSegs(0, 0, 160, 60);
  assert.ok(segs.length >= 18, "enough bumps on the perimeter");
  const xs = segs.flatMap((s) => [s.x1, s.x2]);
  const ys = segs.flatMap((s) => [s.y1, s.y2]);
  assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) <= 160 + 7, "within bbox + bump depth");
  assert.ok(Math.min(...ys) <= 0 && Math.max(...ys) <= 60 + 7);
  // контур замкнут: конец последнего совпадает с началом первого
  const first = segs[0], last = segs[segs.length - 1];
  assert.equal(last.x2, first.x1);
  assert.equal(last.y2, first.y1);
});
