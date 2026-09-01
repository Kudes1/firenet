"use strict";

// Cursor navigation shared by every combo-style add-widget (member-add on
// networks/sets, src/dst endpoints on rules, export side-picker on links):
// clamping a highlighted index into a filtered candidate list and reading
// the item it points at. The candidate list itself, and the surrounding
// search/open state (shape differs per page), stay page-specific — only
// this arithmetic was byte-identical across all four.

export function clampCursor(cursor, delta, listLength) {
  const max = listLength - 1;
  if (max < 0) return cursor;
  return Math.min(Math.max(cursor + delta, 0), max);
}

export function pickAt(list, cursor) {
  return list[cursor];
}
