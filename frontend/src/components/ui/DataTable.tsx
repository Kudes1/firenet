import { useId, useMemo, useState } from "react";
import { ResetIcon, SearchIcon } from "../icons";

export type Column<T> = {
  key: string;
  title: string;
  render: (row: T) => React.ReactNode;
  // Без filter колонка не участвует в поиске (например, кнопки действий).
  filter?: (row: T, query: string) => boolean;
  // Показывает кнопку сброса фильтров в этой колонке.
  filterReset?: boolean;
  width?: string;
};

type Props<T> = {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
  actions?: React.ReactNode;
  hint?: React.ReactNode;
};

// Таблица страниц: тулбар с поиском, вторая строка заголовка с фильтрами.
// Ширины колонок фиксированные — перенос ресайза из columns.js вынесен
// в отдельную задачу.
export default function DataTable<T>({ columns, rows, rowKey, empty, actions, hint }: Props<T>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const searchRowId = useId();

  const searchable = useMemo(() => columns.filter((c) => c.filter), [columns]);
  const visible = useMemo(
    () => searchOpen ? rows.filter((row) => searchable.every((c) => !filters[c.key] || c.filter!(row, filters[c.key]))) : rows,
    [rows, filters, searchable, searchOpen],
  );
  const searchLabel = searchOpen ? "Закрыть поиск" : "Открыть поиск";

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
          {actions}
        </div>
      </div>
      <table className="data-table" data-testid="data-table">
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.title}</th>)}</tr>
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
