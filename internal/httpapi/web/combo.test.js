"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function load() {
  return import(path.join(__dirname, "combo.js") + `?t=${Date.now()}-${Math.random()}`);
}

test("clampCursor moves the cursor within bounds", async () => {
  const { clampCursor } = await load();
  assert.equal(clampCursor(0, 1, 3), 1);
  assert.equal(clampCursor(1, 1, 3), 2);
});

test("clampCursor clamps at the last index and at zero", async () => {
  const { clampCursor } = await load();
  assert.equal(clampCursor(2, 1, 3), 2, "does not go past the last candidate");
  assert.equal(clampCursor(0, -1, 3), 0, "does not go below zero");
});

test("clampCursor leaves the cursor unchanged for an empty list", async () => {
  const { clampCursor } = await load();
  assert.equal(clampCursor(5, 1, 0), 5);
});

test("pickAt returns the item at the cursor", async () => {
  const { pickAt } = await load();
  const list = [{ name: "a" }, { name: "b" }];
  assert.equal(pickAt(list, 1), list[1]);
});

test("pickAt returns undefined past the end of the list", async () => {
  const { pickAt } = await load();
  assert.equal(pickAt([{ name: "a" }], 5), undefined);
});
