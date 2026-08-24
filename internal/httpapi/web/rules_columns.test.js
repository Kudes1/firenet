"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseColumnWidths,
  resetPair,
  resizePair,
  toPercentages,
} = require("./columns.js");

test("resizePair changes only the selected pair", () => {
  const widths = [46, 130, 170];
  const result = resizePair(widths, 1, 30, [40, 80, 100]);

  assert.deepEqual(result, [46, 160, 140]);
  assert.equal(result[1] + result[2], widths[1] + widths[2]);
});

test("resizePair respects both minimum widths", () => {
  assert.deepEqual(resizePair([130, 100], 0, 60, [80, 80]), [150, 80]);
  assert.deepEqual(resizePair([130, 100], 0, -60, [80, 80]), [80, 150]);
});

test("resetPair restores the default proportion without changing pair width", () => {
  const result = resetPair([200, 100], 0, [130, 170], [80, 100]);

  assert.deepEqual(result, [130, 170]);
  assert.equal(result[0] + result[1], 300);
});

test("stored widths require the current format and a complete 100-percent layout", () => {
  assert.deepEqual(parseColumnWidths('{"version":2,"widths":[40,60]}', 2, 2), [40, 60]);
  assert.equal(parseColumnWidths('{"version":1,"widths":[40,60]}', 2, 2), null);
  assert.equal(parseColumnWidths('{"version":2,"widths":[40,50]}', 2, 2), null);
  assert.deepEqual(toPercentages([40, 60]), [40, 60]);
});
