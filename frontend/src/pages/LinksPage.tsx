import { useMemo, useState } from "react";
import { useProjectResource } from "../api/queries";
import type { LinkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import { canonicalLink } from "../lib/links";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { LinkFilterForm } from "../topology/editForms";
import { useTopologyEditor } from "../topology/useTopologyEditor";
import { EditIcon } from "../components/icons";

type Row = { key: string; index: number; a: string; b: string; filter?: LinkDoc["filter"] };

const badges = (list?: string[]) =>
  list?.length ? list.map((s) => <span className="owner-badge" key={s}>{s}</span>) : <span className="hint">—</span>;

export default function LinksPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const editor = useTopologyEditor();
  const [editing, setEditing] = useState<number | null>(null);

  const links = topology.data?.links ?? [];

  const rows: Row[] = useMemo(() => links.map((l, index) => {
    const swapped = canonicalLink(l.a.device, l.b.device)[0] !== l.a.device;
    // Стороны фильтра — это стороны A/B документа; при канонизации пары
    // концы меняются местами, экспорты переезжают вместе с ними.
    const filter = swapped
      ? { aExports: l.filter?.bExports ?? [], bExports: l.filter?.aExports ?? [] }
      : l.filter;
    const [a, b] = canonicalLink(l.a.device, l.b.device);
    return { key: `${a}|${b}`, index, a, b, filter };
  }), [links]);

  const cidrOf = (name: string) => subnets.data?.subnets?.find((s) => s.name === name)?.cidr ?? "";

  const setFilter = async (row: Row, filter: LinkDoc["filter"]) => {
    const link = links[row.index];
    if (!link) return;
    await editor.setLinkFilter(link.a.device, link.b.device, filter);
    notify("Связи сохранены", "ok");
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
      width: "26%",
      minWidth: 220,
      render: (r) => `${r.a} ↔ ${r.b}`,
      filter: (r, q) => containsFold(r.a, q) || containsFold(r.b, q),
    },
    {
      key: "mode",
      title: "Режим",
      width: "17%",
      minWidth: 145,
      render: (r) => (
        <span className={`link-mode ${r.filter ? "link-mode-filtered" : "link-mode-plain"}`}>
          {r.filter ? "фильтрованная" : "обычная"}
        </span>
      ),
      filter: (r, q) => containsFold(r.filter ? "фильтрованная" : "обычная", q),
    },
    {
      key: "aExports",
      title: "Экспорт →",
      width: "20%",
      minWidth: 170,
      render: (r) => badges(r.filter?.aExports),
      filter: (r, q) => matchSubnetMembers(r.filter?.aExports, cidrOf, q),
    },
    {
      key: "bExports",
      title: "← Экспорт",
      width: "20%",
      minWidth: 170,
      render: (r) => badges(r.filter?.bExports),
      filter: (r, q) => matchSubnetMembers(r.filter?.bExports, cidrOf, q),
    },
    {
      key: "actions",
      title: "",
      width: "17%",
      minWidth: 140,
      filterReset: true,
      render: (r) => (
        <div className="link-actions">
          {r.filter ? (
            <>
              <button type="button" className="icon-btn link-action edit" title={`Изменить фильтр связи ${r.a} ↔ ${r.b}`} aria-label={`Изменить фильтр связи ${r.a} ↔ ${r.b}`} onClick={() => open(r.index)}><EditIcon /></button>
              <button type="button" className="btn-link link-toggle" title={`Вернуть обычную связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, undefined)}>Обычная</button>
            </>
          ) : (
            <button type="button" className="btn-link link-toggle" title={`Сделать фильтрованной связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, { aExports: [], bExports: [] })}>Фильтровать</button>
          )}
        </div>
      ),
    },
  ];

  const link = editing === null ? null : links[editing];

  return (
    <main className="page links-page" data-testid="page-links">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        empty="Связей нет — создайте их на схеме"
        resizable
        storageKey="firenet:links:column-widths"
        hint={(
          <div className="links-heading">
            <h1>Связи</h1>
            <p className="hint">Логические соединения между устройствами и их фильтры.</p>
          </div>
        )}
      />
      <Modal
        open={!!link}
        wide
        title={(() => {
          if (!link) return "";
          const [a, b] = canonicalLink(link.a.device, link.b.device);
          return `Фильтры связи ${a} ↔ ${b}`;
        })()}
        onClose={() => setEditing(null)}
        footer={<button type="button" onClick={() => setEditing(null)}>Закрыть</button>}
      >
        {link && (
          <LinkFilterForm
            link={link}
            onSave={async (next) => {
              editor.setLinkFilter(next.a.device, next.b.device, next.filter);
            }}
          />
        )}
      </Modal>
    </main>
  );
}
