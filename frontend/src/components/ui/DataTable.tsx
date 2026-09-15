import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ColumnWidthIcon, ResetIcon, SearchIcon } from "../icons";

export type Column<T> = {
  key: string;
  title: string;
  render: (row: T) => React.ReactNode;
  // Без filter колонка не участвует в поиске (например, кнопки действий).
  filter?: (row: T, query: string) => boolean;
  // Показывает кнопку сброса фильтров в этой колонке.
  filterReset?: boolean;
  width?: string;
  minWidth?: number;
};

type Props<T> = {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  id?: string;
  empty?: string;
  actions?: React.ReactNode;
  hint?: React.ReactNode;
  resizable?: boolean;
  storageKey?: string;
};

const DEFAULT_MIN_WIDTH = 80;

function defaultWidths<T>(columns: Array<Column<T>>) {
  return Object.fromEntries(columns.map((column) => [column.key, column.width ?? "auto"]));
}

function readWidths<T>(storageKey: string | undefined, columns: Array<Column<T>>) {
  const defaults = defaultWidths(columns);
  if (!storageKey || typeof window === "undefined") return defaults;

  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Record<string, unknown> | null;
    if (!stored) return defaults;
    for (const column of columns) {
      const width = stored[column.key];
      if (typeof width === "number" && Number.isFinite(width) && width > 0) defaults[column.key] = `${Math.round(width)}px`;
      if (typeof width === "string" && /^(?:\d+(?:\.\d+)?)(?:px|%)$/.test(width)) defaults[column.key] = width;
    }
  } catch {
    return defaults;
  }
  return defaults;
}

function numericWidth(width: string | undefined) {
  const parsed = Number.parseFloat(width ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

// Таблица страниц: тулбар с поиском, вторая строка заголовка с фильтрами.
// Resizable включается только на страницах, где изменение ширины полезно.
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  id,
  empty,
  actions,
  hint,
  resizable = false,
  storageKey,
}: Props<T>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const defaults = useMemo(() => defaultWidths(columns), [columns]);
  const [widths, setWidths] = useState<Record<string, string>>(() => readWidths(storageKey, columns));
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const resizeRef = useRef<{
    index: number;
    startX: number;
    leftWidth: number;
    rightWidth: number;
  } | null>(null);
  const searchRowId = useId();

  const searchable = useMemo(() => columns.filter((c) => c.filter), [columns]);
  const visible = useMemo(
    () => searchOpen ? rows.filter((row) => searchable.every((c) => !filters[c.key] || c.filter!(row, filters[c.key]))) : rows,
    [rows, filters, searchable, searchOpen],
  );
  const searchLabel = searchOpen ? "Закрыть поиск" : "Открыть поиск";

  const resizeColumns = (event: Pick<PointerEvent, "clientX">) => {
    const session = resizeRef.current;
    if (!session) return;
    const leftColumn = columns[session.index];
    const rightColumn = columns[session.index + 1];
    const leftMin = leftColumn.minWidth ?? DEFAULT_MIN_WIDTH;
    const rightMin = rightColumn.minWidth ?? DEFAULT_MIN_WIDTH;
    const delta = event.clientX - session.startX;
    const bounded = Math.min(
      session.rightWidth - rightMin,
      Math.max(leftMin - session.leftWidth, delta),
    );
    setWidths((current) => ({
      ...current,
      [leftColumn.key]: `${Math.round(session.leftWidth + bounded)}px`,
      [rightColumn.key]: `${Math.round(session.rightWidth - bounded)}px`,
    }));
  };

  const stopResize = () => {
    resizeRef.current = null;
    setResizingKey(null);
  };

  const measureTableWidths = () => {
    const table = tableRef.current;
    const cells = table?.tHead?.rows[0]?.cells;
    if (!table || !cells || cells.length !== columns.length) return null;

    const measured = Array.from(cells).map((cell) => cell.getBoundingClientRect().width);
    if (measured.some((width) => !width)) return null;

    const normalized = measured.map((width) => Math.round(width));
    const tableWidth = Math.round(table.getBoundingClientRect().width) || normalized.reduce((sum, width) => sum + width, 0);
    normalized[normalized.length - 1] += tableWidth - normalized.reduce((sum, width) => sum + width, 0);
    if (normalized.some((width) => width <= 0)) return null;

    return Object.fromEntries(columns.map((column, index) => [column.key, `${normalized[index]}px`]));
  };

  useEffect(() => {
    if (!resizable || !storageKey) return;
    const persisted = Object.fromEntries(
      Object.entries(widths)
        .filter(([, width]) => width !== "auto"),
    );
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(persisted));
    } catch {
      // Storage can be unavailable in private browsing or restricted embeds.
    }
  }, [resizable, storageKey, widths]);

  useEffect(() => {
    if (!resizable) return;

    document.addEventListener("pointermove", resizeColumns);
    document.addEventListener("pointerup", stopResize);
    document.addEventListener("pointercancel", stopResize);
    return () => {
      document.removeEventListener("pointermove", resizeColumns);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
    };
  }, [columns, resizable, resizeColumns]);

  const measureColumn = (element: Element, fallback: string | undefined) =>
    element.getBoundingClientRect().width || numericWidth(fallback);

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, index: number) => {
    const leftElement = event.currentTarget.parentElement;
    const rightElement = leftElement?.nextElementSibling;
    if (!leftElement || !rightElement) return;

    const leftColumn = columns[index];
    const rightColumn = columns[index + 1];
    const normalizedWidths = measureTableWidths();
    const leftWidth = normalizedWidths
      ? numericWidth(normalizedWidths[leftColumn.key])
      : measureColumn(leftElement, widths[leftColumn.key]);
    const rightWidth = normalizedWidths
      ? numericWidth(normalizedWidths[rightColumn.key])
      : measureColumn(rightElement, widths[rightColumn.key]);
    if (!leftWidth || !rightWidth) return;

    if (normalizedWidths) setWidths((current) => ({ ...current, ...normalizedWidths }));
    resizeRef.current = { index, startX: event.clientX, leftWidth, rightWidth };
    setResizingKey(leftColumn.key);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const adjustResize = (event: React.KeyboardEvent<HTMLSpanElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const leftElement = event.currentTarget.parentElement;
    const rightElement = leftElement?.nextElementSibling;
    if (!leftElement || !rightElement) return;

    const leftColumn = columns[index];
    const rightColumn = columns[index + 1];
    const normalizedWidths = measureTableWidths();
    const leftWidth = normalizedWidths
      ? numericWidth(normalizedWidths[leftColumn.key])
      : measureColumn(leftElement, widths[leftColumn.key]);
    const rightWidth = normalizedWidths
      ? numericWidth(normalizedWidths[rightColumn.key])
      : measureColumn(rightElement, widths[rightColumn.key]);
    const step = event.key === "ArrowRight" ? 8 : -8;
    const leftMin = leftColumn.minWidth ?? DEFAULT_MIN_WIDTH;
    const rightMin = rightColumn.minWidth ?? DEFAULT_MIN_WIDTH;
    const bounded = Math.min(rightWidth - rightMin, Math.max(leftMin - leftWidth, step));
    setWidths((current) => ({
      ...current,
      ...(normalizedWidths ?? {}),
      [leftColumn.key]: `${Math.round(leftWidth + bounded)}px`,
      [rightColumn.key]: `${Math.round(rightWidth - bounded)}px`,
    }));
    event.preventDefault();
  };

  const resetWidths = () => {
    setWidths(defaults);
    if (storageKey) {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // Storage can be unavailable in private browsing or restricted embeds.
      }
    }
  };

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <div className="toolbar-text">{hint}</div>
        <div className="toolbar-actions">
          {searchable.length > 0 && (
            <button
              type="button"
              className={`btn-search secondary${searchOpen ? " search-active" : ""}`}
              title={searchLabel}
              aria-label={searchLabel}
              aria-expanded={searchOpen}
              aria-controls={searchOpen ? searchRowId : undefined}
              onClick={() => setSearchOpen((open) => !open)}
            >
              <span className="search-toggle-icon" aria-hidden="true">
                <SearchIcon />
                {searchOpen && <span className="search-toggle-close"><ResetIcon /></span>}
              </span>
            </button>
          )}
          {resizable && (
            <button
              type="button"
              className="icon-btn table-reset-btn"
              title="Сбросить ширины колонок"
              aria-label="Сбросить ширины колонок"
              onClick={resetWidths}
            >
              <ColumnWidthIcon />
            </button>
          )}
          {actions}
        </div>
      </div>
      <table ref={tableRef} id={id} className="data-table" data-testid="data-table">
        <colgroup>
          {columns.map((c) => <col key={c.key} style={widths[c.key] ? { width: widths[c.key] } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c, index) => {
              const next = columns[index + 1];
              const separatorLabel = next
                ? `Изменить границу между столбцами «${c.title || "Действия"}» и «${next.title || "Действия"}»`
                : undefined;
              const currentWidth = widths[c.key] ?? c.width ?? "auto";
              const nextWidth = next ? widths[next.key] ?? next.width ?? "auto" : "auto";
              const percentageWidths = currentWidth.endsWith("%") && nextWidth.endsWith("%");
              const minWidth = percentageWidths ? 0 : c.minWidth ?? DEFAULT_MIN_WIDTH;
              const currentValue = percentageWidths ? numericWidth(currentWidth) : Math.max(minWidth, numericWidth(currentWidth));
              const maxWidth = percentageWidths
                ? 100
                : Math.max(currentValue, numericWidth(currentWidth) + numericWidth(nextWidth) - (next?.minWidth ?? DEFAULT_MIN_WIDTH));
              return (
                <th key={c.key}>
                  {c.title}
                  {resizable && next && (
                    <span
                      className={`col-resizer${resizingKey === c.key ? " active" : ""}`}
                      role="separator"
                      aria-label={separatorLabel}
                      aria-orientation="vertical"
                      aria-valuemin={minWidth}
                      aria-valuemax={maxWidth}
                      aria-valuenow={currentValue}
                      aria-valuetext={`${currentValue}${percentageWidths ? "%" : "px"}`}
                      tabIndex={0}
                      onPointerDown={(event) => startResize(event, index)}
                      onPointerMove={(event) => resizeColumns(event)}
                      onPointerUp={stopResize}
                      onPointerCancel={stopResize}
                      onLostPointerCapture={stopResize}
                      onKeyDown={(event) => adjustResize(event, index)}
                    />
                  )}
                </th>
              );
            })}
          </tr>
          {searchOpen && (
            <tr id={searchRowId} className="search-row">
              {columns.map((c) => (
                <th key={c.key}>
                  {c.filter && (
                    <input
                      placeholder={c.title}
                      value={filters[c.key] ?? ""}
                      onChange={(e) => setFilters({ ...filters, [c.key]: e.target.value })}
                    />
                  )}
                  {c.filterReset && (
                    <button type="button" className="icon-btn reset-search" title="Сбросить фильтры" aria-label="Сбросить фильтры" onClick={() => setFilters({})}>
                      <ResetIcon />
                    </button>
                  )}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => <td key={c.key}>{c.render(row)}</td>)}
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={columns.length}>
                {rows.length === 0 ? empty ?? "Ничего не добавлено" : "Ничего не найдено"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
