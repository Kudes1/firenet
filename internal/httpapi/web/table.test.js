"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function load() {
  return import(path.join(__dirname, "table.js") + `?t=${Date.now()}-${Math.random()}`);
}

function makeTableEl() {
  return { dataset: {}, querySelectorAll: () => [] };
}

test("initTable is a no-op without a table element", async () => {
  const { initTable } = await load();
  assert.doesNotThrow(() => initTable(null, "k", 1));
});

test("initTable marks the table ready and skips re-init on a second call", async () => {
  global.localStorage = { getItem: () => null, setItem() {} };
  const { initTable } = await load();
  const tableEl = makeTableEl();
  initTable(tableEl, "k", 1);
  assert.equal(tableEl.dataset.columnsReady, "1");
  // querySelectorAll returning [] means a real re-run would throw on missing
  // columns/ths; a second call must short-circuit on the guard instead.
  assert.doesNotThrow(() => initTable(tableEl, "k", 1));
});

test("matchAll requires every matcher to accept the row", async () => {
  const { matchAll } = await load();
  const row = { name: "core", description: "" };
  const filters = { name: "co", description: "x" };
  assert.equal(
    matchAll(row, filters, { name: (r, q) => r.name.includes(q) }),
    true
  );
  assert.equal(
    matchAll(row, filters, {
      name: (r, q) => r.name.includes(q),
      description: (r, q) => r.description.includes(q),
    }),
    false
  );
});

test("matchAll with no matchers accepts every row", async () => {
  const { matchAll } = await load();
  assert.equal(matchAll({ any: "thing" }, {}, {}), true);
});
