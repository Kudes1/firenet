"use strict";

// Generic resizable-table engine shared by pages with <colgroup>-based
// tables. Column widths are stored as percentages in localStorage under a
// page-specific key; data-default-width / data-min-width attributes on the
// <col> elements drive drag limits and double-click reset.

function sum(widths) {
  return widths.reduce((total, width) => total + width, 0);
}

export function toPercentages(widths) {
  const total = sum(widths);
  return total ? widths.map((width) => Number(((width * 100) / total).toFixed(6))) : [];
}

export function parseColumnWidths(raw, count, version) {
  try {
    const saved = JSON.parse(raw);
    if (saved?.version !== version || !Array.isArray(saved.widths) || saved.widths.length !== count) return null;
    if (saved.widths.some((width) => !Number.isFinite(width) || width <= 0)) return null;
    return Math.abs(sum(saved.widths) - 100) < 0.001 ? saved.widths : null;
  } catch {
    return null;
  }
}

export function resizePair(widths, index, delta, minimums) {
  const next = widths.slice();
  const limited = Math.min(
    Math.max(delta, -(next[index] - minimums[index])),
    next[index + 1] - minimums[index + 1]
  );
  next[index] += limited;
  next[index + 1] -= limited;
  return next;
}

export function resetPair(widths, index, defaults, minimums) {
  const pairWidth = widths[index] + widths[index + 1];
  const desired = (pairWidth * defaults[index]) / (defaults[index] + defaults[index + 1]);
  return resizePair(widths, index, desired - widths[index], minimums);
}

function columnElements(table) {
  return Array.from(table.querySelectorAll("colgroup col"));
}

function headerWidths(table) {
  return Array.from(table.querySelectorAll("thead tr:first-child th"), (th) => th.getBoundingClientRect().width);
}

function applyColumnWidths(table, widths) {
  const percentages = toPercentages(widths);
  columnElements(table).forEach((column, index) => {
    column.style.width = `${percentages[index]}%`;
  });
}

function saveColumnWidths(table, key, version) {
  const widths = toPercentages(headerWidths(table));
  localStorage.setItem(key, JSON.stringify({ version, widths }));
}

function restoreColumnWidths(table, key, version) {
  const columns = columnElements(table);
  const widths = parseColumnWidths(localStorage.getItem(key), columns.length, version);
  if (widths) columns.forEach((column, index) => (column.style.width = `${widths[index]}%`));
  return Boolean(widths);
}

export function makeColumnsResizable(table, key, version) {
  const columns = columnElements(table);
  const ths = table.querySelectorAll("thead tr:first-child th");
  const minimums = columns.map((column) => Number(column.dataset.minWidth));
  const defaults = columns.map((column) => Number(column.dataset.defaultWidth));
  if (columns.length !== ths.length || minimums.some(Number.isNaN) || defaults.some(Number.isNaN)) return;

  ths.forEach((th, index) => {
    if (index === ths.length - 1) return;
    const handle = document.createElement("span");
    handle.className = "col-resizer";
    handle.onmousedown = (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidths = headerWidths(table);
      handle.classList.add("active");
      const onMove = (moveEvent) => applyColumnWidths(table, resizePair(startWidths, index, moveEvent.clientX - startX, minimums));
      const onUp = () => {
        handle.classList.remove("active");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveColumnWidths(table, key, version);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    handle.ondblclick = (event) => {
      event.preventDefault();
      applyColumnWidths(table, resetPair(headerWidths(table), index, defaults, minimums));
      saveColumnWidths(table, key, version);
    };
    th.append(handle);
  });
}

export function initializeColumns(table, key, version) {
  if (restoreColumnWidths(table, key, version)) return;
  const widths = headerWidths(table);
  if (sum(widths)) applyColumnWidths(table, widths);
}

if (typeof window !== "undefined") {
  window.makeColumnsResizable = makeColumnsResizable; // TODO(Task 28): remove once every classic-script consumer imports these directly
  window.initializeColumns = initializeColumns;
}
