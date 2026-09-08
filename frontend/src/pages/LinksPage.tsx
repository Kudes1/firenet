import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { EntityDoc, LinkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import { canonicalLink } from "../lib/links";
import DataTable, { type Column } from "../components/ui/DataTable";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { EditIcon } from "../components/icons";

type Row = { key: string; index: number; a: string; b: string; filter: LinkDoc["filter"] };

export default function LinksPage() {
  const { isReadOnly, apiPath } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<number | null>(null);
  const [exports, setExports] = useState<{ a: EntityDoc[]; b: EntityDoc[] }>({ a: [], b: [] });

  const links = topology.data?.links ?? [];

  // rows пересоздаются только при изменении документа (не на каждом рендере):
  // иначе useEffect ниже, зависящий от rows, повторно дёргал бы link-exports,
  // пока модалка фильтров открыта.
  const rows: Row[] = useMemo(() => links.map((l, index) => {
    const [a, b] = canonicalLink(l.a.device, l.b.device);
    // Экспорты хранятся по сторонам A/B документа; канонический порядок
    // может их переставить, поэтому переносим их вместе с концами.
    const filter = l.filter
      ? (a === l.a.device
        ? { aExports: l.filter.aExports, bExports: l.filter.bExports }
        : { aExports: l.filter.bExports, bExports: l.filter.aExports })
      : undefined;
    return { key: `${a}|${b}`, index, a, b, filter };
  }), [links]);

  const cidrOf = (name: string) => subnets.data?.subnets?.find((s) => s.name === name)?.cidr ?? "";

  useEffect(() => {
    if (editing === null) return;
    const row = rows[editing];
    if (!row) return;
    let cancelled = false;
    void Promise.all([
      api.get<{ entities: EntityDoc[] }>(apiPath(`link-exports?side=a&a=${row.a}&b=${row.b}`)),
      api.get<{ entities: EntityDoc[] }>(apiPath(`link-exports?side=b&a=${row.a}&b=${row.b}`)),
    ]).then(([sideA, sideB]) => {
      if (!cancelled) setExports({ a: sideA.entities, b: sideB.entities });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [editing, apiPath, rows]);

  const persist = async (next: LinkDoc[]) => {
    if (!topology.data) return;
    try {
      await save.mutateAsync({ ...topology.data, links: next });
      notify("Связи сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const setFilter = (row: Row, filter: LinkDoc["filter"]) => {
    const next = links.slice();
    next[row.index] = { ...next[row.index], filter };
    void persist(next);
  };

  const replaceExport = (row: Row, side: "a" | "b", list: string[]) => {
    const current = row.filter ?? { aExports: [], bExports: [] };
    const filter = side === "a" ? { aExports: list, bExports: current.bExports } : { aExports: current.aExports, bExports: list };
    void persist(links.map((l, i) => (i === row.index ? { ...l, filter } : l)));
  };

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    setEditing(index);
  };

  const columns: Column<Row>[] = [
    {
      key: "pair",
      title: "Устройства",
      render: (r) => `${r.a} ↔ ${r.b}`,
      filter: (r, q) => containsFold(r.a, q) || containsFold(r.b, q),
    },
    {
      key: "mode",
      title: "Режим",
      render: (r) => (r.filter ? <span className="owner-badge">фильтрованная</span> : <span className="hint">обычная</span>),
      filter: (r, q) => containsFold(r.filter ? "фильтрованная" : "обычная", q),
    },
    {
      key: "aExports",
      title: "Экспорт →",
      render: (r) => badges(r.filter?.aExports),
      filter: (r, q) => matchSubnetMembers(r.filter?.aExports, cidrOf, q),
    },
    {
      key: "bExports",
      title: "← Экспорт",
      render: (r) => badges(r.filter?.bExports),
      filter: (r, q) => matchSubnetMembers(r.filter?.bExports, cidrOf, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (r.filter ? (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить фильтр связи ${r.a} ↔ ${r.b}`} onClick={() => open(r.index)}><EditIcon /></button>
          <button type="button" className="btn-link" title={`Вернуть обычной связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, undefined)}>Обычная</button>
        </>
      ) : (
        <button type="button" className="btn-link" title={`Сделать фильтрованной связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, { aExports: [], bExports: [] })}>Фильтровать</button>
      )),
    },
  ];

  const row = editing === null ? null : rows[editing];

  return (
    <main className="page" data-testid="page-links">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        empty="Связей нет — создайте их на схеме"
        hint={<><h3>Связи</h3><p className="hint">Логические соединения между устройствами и их фильтры.</p></>}
      />
      <Modal
        open={!!row}
        wide
        title={row ? `Фильтры связи ${row.a} ↔ ${row.b}` : ""}
        onClose={() => setEditing(null)}
        footer={<button type="button" onClick={() => setEditing(null)}>Закрыть</button>}
      >
        {row && (
          <div className="link-panel-grid">
            {(["a", "b"] as const).map((side) => {
              const mine = side === "a" ? row.filter?.aExports ?? [] : row.filter?.bExports ?? [];
              const theirs = side === "a" ? row.filter?.bExports ?? [] : row.filter?.aExports ?? [];
              return (
                <fieldset className={side === "a" ? "link-end-col-a" : "link-end-col-b"} key={side}>
                  <legend>{side === "a" ? row.a : row.b}</legend>
                  <div className="filter-dirs">
                    <div>
                      <p className="filter-dir-title">Экспорт</p>
                      <MemberList
                        members={mine}
                        detailOf={cidrOf}
                        onRemove={(name) => replaceExport(row, side, mine.filter((x) => x !== name))}
                        candidates={exports[side].map((e) => `${e.name} (${e.cidr ?? ""})`)}
                        onAdd={(raw) => {
                          const name = raw.split(" (")[0];
                          if (mine.includes(name)) return;
                          replaceExport(row, side, [...mine, name]);
                        }}
                        empty="Ничего не экспортируется"
                      />
                    </div>
                    <div>
                      <p className="filter-dir-title">Импорт</p>
                      {/* Импорт стороны — это экспорт соседа: read-only, как в легаси. */}
                      <MemberList readOnly members={theirs} detailOf={cidrOf} empty="Ничего не импортируется" />
                    </div>
                  </div>
                </fieldset>
              );
            })}
          </div>
        )}
      </Modal>
    </main>
  );
}

const badges = (list: string[] | undefined) =>
  list?.length ? list.map((n) => <span className="owner-badge" key={n}>{n}</span>) : <span className="hint">—</span>;
