"use strict";

// Rules is server-rendered HTML driven by HTMX. Column resizing and reactive
// UI settings state are managed by Alpine.js.
const COL_WIDTHS_KEY = "firenet-rules-col-widths-v2";
const COL_WIDTHS_VERSION = 2;

function sum(widths) {
  return widths.reduce((total, width) => total + width, 0);
}

function toPercentages(widths) {
  const total = sum(widths);
  return total ? widths.map((width) => Number(((width * 100) / total).toFixed(6))) : [];
}

function parseColumnWidths(raw, count) {
  try {
    const saved = JSON.parse(raw);
    if (saved?.version !== COL_WIDTHS_VERSION || !Array.isArray(saved.widths) || saved.widths.length !== count) return null;
    if (saved.widths.some((width) => !Number.isFinite(width) || width <= 0)) return null;
    return Math.abs(sum(saved.widths) - 100) < 0.001 ? saved.widths : null;
  } catch {
    return null;
  }
}

function resizePair(widths, index, delta, minimums) {
  const next = widths.slice();
  const limited = Math.min(
    Math.max(delta, -(next[index] - minimums[index])),
    next[index + 1] - minimums[index + 1]
  );
  next[index] += limited;
  next[index + 1] -= limited;
  return next;
}

function resetPair(widths, index, defaults, minimums) {
  const pairWidth = widths[index] + widths[index + 1];
  const desired = (pairWidth * defaults[index]) / (defaults[index] + defaults[index + 1]);
  return resizePair(widths, index, desired - widths[index], minimums);
}

function columnElements(table) {
  return Array.from(table.querySelectorAll("colgroup col"));
}

function headerWidths(table) {
  return Array.from(table.querySelectorAll("thead th"), (th) => th.getBoundingClientRect().width);
}

function applyColumnWidths(table, widths) {
  const percentages = toPercentages(widths);
  columnElements(table).forEach((column, index) => {
    column.style.width = `${percentages[index]}%`;
  });
}

function saveColumnWidths(table) {
  const widths = toPercentages(headerWidths(table));
  localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify({ version: COL_WIDTHS_VERSION, widths }));
}

function restoreColumnWidths(table) {
  const columns = columnElements(table);
  const widths = parseColumnWidths(localStorage.getItem(COL_WIDTHS_KEY), columns.length);
  if (widths) columns.forEach((column, index) => (column.style.width = `${widths[index]}%`));
  return Boolean(widths);
}

function makeColumnsResizable(table) {
  const columns = columnElements(table);
  const ths = table.querySelectorAll("thead th");
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
        saveColumnWidths(table);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    handle.ondblclick = (event) => {
      event.preventDefault();
      applyColumnWidths(table, resetPair(headerWidths(table), index, defaults, minimums));
      saveColumnWidths(table);
    };
    th.append(handle);
  });
}

function initializeColumns(table) {
  if (restoreColumnWidths(table)) return;
  const widths = headerWidths(table);
  if (sum(widths)) applyColumnWidths(table, widths);
}

function formatChainPosition(pos) {
  return pos === "bottom" ? "в конец FORWARD" : "в начало FORWARD";
}

function formatChainName(name) {
  return name && name.trim() ? name.trim() : "FIRENET-FWD";
}

function formatEndpointSummary(checkedValues) {
  return checkedValues && checkedValues.length ? checkedValues.join(", ") : "— выбрать —";
}

function handleMultiselectToggle(event) {
  const details = event.currentTarget || event.target;
  if (!details || !details.classList?.contains("multiselect")) return;
  if (!details.open) {
    details.classList.remove("open-up");
    return;
  }
  document.querySelectorAll("details.multiselect[open]").forEach((el) => {
    if (el !== details) el.removeAttribute("open");
  });

  const rect = details.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const panelHeight = 190;

  if (spaceBelow < panelHeight && spaceAbove > spaceBelow) {
    details.classList.add("open-up");
  } else {
    details.classList.remove("open-up");
  }
}

function initMultiselectListeners() {
  if (typeof document === "undefined") return;

  document.addEventListener("toggle", handleMultiselectToggle, true);

  document.addEventListener("click", (event) => {
    if (!event.target.closest("details.multiselect")) {
      document.querySelectorAll("details.multiselect[open]").forEach((el) => {
        el.removeAttribute("open");
      });
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches?.(".multiselect-panel input[type=checkbox]")) {
      const details = event.target.closest("details.multiselect");
      if (details) {
        const textEl = details.querySelector(".multiselect-toggle-text") || details.querySelector(".multiselect-toggle");
        if (textEl) {
          const checked = Array.from(details.querySelectorAll("input[type=checkbox]:checked")).map((cb) => cb.value);
          textEl.textContent = formatEndpointSummary(checked);
        }
      }
    }
  });
}

function rulesPanel(initial = {}) {
  return {
    editing: false,
    defaultAction: initial.defaultAction || "deny",
    chainName: initial.chainName || "",
    chainPosition: initial.chainPosition || "top",
    draftDefaultAction: initial.defaultAction || "deny",
    draftChainName: initial.chainName || "",
    draftChainPosition: initial.chainPosition || "top",

    startEdit() {
      this.draftDefaultAction = this.defaultAction;
      this.draftChainName = this.chainName;
      this.draftChainPosition = this.chainPosition;
      this.editing = true;
    },

    cancelEdit() {
      this.editing = false;
    },

    applyEdit() {
      const confirmFn = typeof confirm !== "undefined" ? confirm : typeof window !== "undefined" ? window.confirm : () => true;
      if (!confirmFn("Применить изменения параметров правил (действие по умолчанию, имя цепочки, вставка перехода)?")) return;
      this.defaultAction = this.draftDefaultAction;
      this.chainName = this.draftChainName;
      this.chainPosition = this.draftChainPosition;
      this.editing = false;
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl);
      makeColumnsResizable(tableEl);
    },
  };
}

if (typeof window !== "undefined") {
  window.rulesPanel = rulesPanel;
  if (window.Alpine) {
    window.Alpine.data("rulesPanel", rulesPanel);
  } else {
    document.addEventListener("alpine:init", () => {
      window.Alpine.data("rulesPanel", rulesPanel);
    });
  }

  initMultiselectListeners();

  // HTMX fallback for table initialization after swap
  document.body.addEventListener("htmx:afterSettle", () => {
    const table = document.getElementById("rules-table");
    if (table && !table.dataset.columnsReady) {
      table.dataset.columnsReady = "1";
      initializeColumns(table);
      makeColumnsResizable(table);
    }
  });
}

const RulesColumns = {
  parseColumnWidths,
  resetPair,
  resizePair,
  toPercentages,
  formatChainPosition,
  formatChainName,
  formatEndpointSummary,
  rulesPanel,
};

if (typeof module !== "undefined") module.exports = RulesColumns;
