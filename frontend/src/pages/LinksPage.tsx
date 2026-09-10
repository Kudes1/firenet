import { useMemo, useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { LinkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import { canonicalLink } from "../lib/links";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { LinkFilterForm } from "../topology/editForms";
import { EditIcon } from "../components/icons";

type Row = { key: string; index: number; a: string; b: string; filter?: LinkDoc["filter"] };

const badges = (list?: string[]) =>
  list?.length ? list.map((s) => <span className="owner-badge" key={s}>{s}</span>) : <span className="hint">—</span>;

export default function LinksPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<number | null>(null);

  const links = topology.data?.links ?? [];

  const rows: Row[] = useMemo(() => links.map((l, index) => {
    const [a, b] = canonicalLink(l.a.device, l.b.device);
    return { key: `${a}|${b}`, index, a, b, filter: l.filter };
  }), [links]);

  const cidrOf = (name: string) => subnets.data?.subnets?.find((s) => s.name === name)?.cidr ?? "";

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
        <button type="button" className="icon-btn edit" title={`Изменить фильтр связи ${r.a} ↔ ${r.b}`} onClick={() => open(r.index)}><EditIcon /></button>
      ) : (
        <button type="button" className="btn-link" title={`Сделать фильтрованной связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, { aExports: [], bExports: [] })}>Фильтровать</button>
      )),
    },
  ];

  const link = editing === null ? null : links[editing];

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
              const nextLinks = links.slice();
              nextLinks[editing!] = next;
              await persist(nextLinks);
            }}
          />
        )}
      </Modal>
    </main>
  );
}
