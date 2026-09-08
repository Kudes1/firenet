import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSearchIndex } from "../api/queries";
import type { SearchEntry, SearchEntryType } from "../api/types";
import { containsFold, matchPrefixQuery } from "../lib/search";

const TYPE_LABEL: Record<SearchEntryType, string> = {
  device: "устройство", subnet: "подсеть", network: "сеть",
  set: "набор", union: "объединение", link: "связь", rule: "правило",
};

const HREFS: Record<SearchEntryType, string> = {
  device: "/ui/devices", subnet: "/ui/subnets", network: "/ui/networks",
  set: "/ui/sets", union: "/ui/unions", link: "/ui/links", rule: "/ui/rules",
};

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
    <main className="page" data-testid="page-search">
      <div className="search-controls">
        <input
          className="search-input"
          type="search"
          value={query}
          placeholder="имя, CIDR или описание"
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})}
        />
        <select className="search-type" value={type} onChange={(e) => setType(e.target.value as SearchEntryType | "all")}>
          <option value="all">все</option>
          {(Object.keys(TYPE_LABEL) as SearchEntryType[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
      </div>
      <table className="data-table">
        <thead><tr><th>Тип</th><th>Имя</th><th>Детали</th><th>Описание</th></tr></thead>
        <tbody>
          {visible.map((e) => <SearchRow key={`${e.type}:${e.name}`} entry={e} />)}
          {visible.length === 0 && (
            <tr><td className="empty-cell" colSpan={4}>
              {index.isLoading ? "Загрузка…" : "Ничего не найдено"}
            </td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

function SearchRow({ entry }: { entry: SearchEntry }) {
  return (
    <tr className="search-hit">
      <td><Link to={HREFS[entry.type]}><span className="badge badge-default">{TYPE_LABEL[entry.type]}</span></Link></td>
      <td><Link to={HREFS[entry.type]}>{entry.name}</Link></td>
      <td>{entry.details || "—"}</td>
      <td>{entry.description || "—"}</td>
    </tr>
  );
}
