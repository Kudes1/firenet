import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSearchIndex } from "../api/queries";
import type { SearchEntry, SearchEntryType } from "../api/types";
import { containsFold, matchPrefixQuery } from "../lib/search";
import DataTable, { type Column } from "../components/ui/DataTable";

const TYPE_LABEL: Record<SearchEntryType, string> = {
  device: "устройство", subnet: "подсеть", network: "сеть",
  set: "набор", union: "объединение", link: "связь", rule: "правило",
};

const HREFS: Record<SearchEntryType, string> = {
  device: "/ui/devices", subnet: "/ui/subnets", network: "/ui/networks",
  set: "/ui/sets", union: "/ui/unions", link: "/ui/links", rule: "/ui/rules",
};

const COLUMNS: Array<Column<SearchEntry>> = [
  {
    key: "type",
    title: "Тип",
    width: "16%",
    minWidth: 130,
    render: (entry) => <Link to={HREFS[entry.type]}><span className="badge badge-default">{TYPE_LABEL[entry.type]}</span></Link>,
  },
  {
    key: "name",
    title: "Имя",
    width: "22%",
    minWidth: 160,
    render: (entry) => <Link to={HREFS[entry.type]}>{entry.name}</Link>,
  },
  { key: "details", title: "Детали", width: "27%", minWidth: 220, render: (entry) => entry.details || "—" },
  { key: "description", title: "Описание", width: "35%", minWidth: 220, render: (entry) => entry.description || "—" },
];

export default function SearchPage() {
  const index = useSearchIndex();
  const [params, setParams] = useSearchParams();
  const [type, setType] = useState<SearchEntryType | "all">("all");
  const query = params.get("q") ?? "";

  const entries = index.data ?? [];

  const visible = useMemo(() => entries.filter((e) => {
    if (type !== "all" && e.type !== type) return false;
    if (!query) return true;
    // Сначала адресный поиск по prefixes, потом обычная подстрока.
    const byPrefix = (e.prefixes ?? []).some((p) => matchPrefixQuery(p, query));
    return byPrefix || containsFold(e.name, query) || containsFold(e.details, query) || containsFold(e.description, query);
  }), [entries, type, query]);

  return (
    <main className="page search-page" data-testid="page-search">
      <DataTable
        id="search-table"
        columns={COLUMNS}
        rows={visible}
        rowKey={(entry) => `${entry.type}:${entry.name}`}
        empty={index.isLoading ? "Загрузка…" : "Ничего не найдено"}
        resizable
        storageKey="firenet:search:column-widths"
        hint={(
          <div className="search-heading">
            <h1>Поиск</h1>
            <p className="hint">Найдите устройства, сети и правила по имени, адресу или описанию.</p>
          </div>
        )}
        actions={(
          <div className="search-page-controls">
            <label>
              <span>Поиск</span>
              <input
                className="search-input"
                type="search"
                value={query}
                aria-label="Поиск"
                placeholder="имя, CIDR или описание"
                onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})}
              />
            </label>
            <label>
              <span>Тип</span>
              <select className="search-type" aria-label="Тип" value={type} onChange={(e) => setType(e.target.value as SearchEntryType | "all")}>
                <option value="all">все</option>
                {(Object.keys(TYPE_LABEL) as SearchEntryType[]).map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      />
    </main>
  );
}
