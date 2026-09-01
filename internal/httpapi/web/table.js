"use strict";

// Table filtering/init helpers shared by pages with a resizable, filterable
// <table> (devices/networks/rules/sets/subnets/unions/users/links). Column
// resize itself lives in columns.js; this only adds the two bits every page
// duplicated on top of it: the columnsReady guard and the AND-of-matchers
// shape of a filteredX getter. Domain-specific matchers (CIDR/IP search,
// endpoint search, ...) stay on the page — matchAll only combines them.

import { initializeColumns, makeColumnsResizable } from "./columns.js";

export function initTable(tableEl, key, version) {
  if (!tableEl || tableEl.dataset.columnsReady) return;
  tableEl.dataset.columnsReady = "1";
  initializeColumns(tableEl, key, version);
  makeColumnsResizable(tableEl, key, version);
}

// matchAll returns true when every matcher accepts the row against the
// filter value for its own field (matchers: {field: (row, filterValue) =>
// bool}). An empty matchers object matches everything.
export function matchAll(row, filters, matchers) {
  return Object.keys(matchers).every((field) => matchers[field](row, filters[field]));
}
