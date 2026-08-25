"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "tween.js"), "utf8"), sandbox);
const Tween = vm.runInContext("Tween", sandbox);

test("tick interpolates numeric props and reports activity", () => {
  const tw = Tween.create();
  const o = { x: 0, y: 0 };
  tw.to(o, { x: 100, y: 50 }, 100, (t) => t);
  assert.equal(tw.active(), true);
  assert.equal(tw.tick(50), true);
  assert.equal(o.x, 50);
  assert.equal(o.y, 25);
  assert.equal(tw.tick(100), false, "finished at t>=ms");
  assert.equal(o.x, 100);
});

test("later tween wins for repeated props", () => {
  const tw = Tween.create();
  const o = { x: 0 };
  tw.to(o, { x: 10 }, 100, (t) => t);
  tw.to(o, { x: 20 }, 100, (t) => t);
  assert.equal(tw.tick(50), true, "starts on first tick");
  assert.equal(tw.tick(100), false, "finished");
  assert.equal(o.x, 20, "late tween displaced the earlier one");
});

test("easeOutCubic decelerates", () => {
  assert.ok(Tween.easeOutCubic(0.5) > 0.5);
  assert.equal(Tween.easeOutCubic(1), 1);
});
