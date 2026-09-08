import { useMemo, useState } from "react";
import { useProjectResource, useTopologyOperations } from "../api/queries";
import type { NetworkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { DeleteIcon, EditIcon } from "../components/icons";

type Draft = { index: number; name: string; subnets: string[]; description: string };

export default function NetworksPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const ops = useTopologyOperations();
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = topology.data?.networks ?? [];
  const allSubnets = subnets.data?.subnets ?? [];
  const cidrOf = useMemo(() => {
    const map = new Map(allSubnets.map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [allSubnets]);

  // Инвариант легаси: подсеть входит не более чем в одну сеть, поэтому
  // кандидат должен быть свободен либо уже принадлежать этой сети.
  const candidates = (draft: Draft) =>
    allSubnets
      .filter((s) => !rows.some((n, i) => i !== draft.index && (n.subnets ?? []).includes(s.name)))
      .filter((s) => !draft.subnets.includes(s.name))
      .map((s) => `${s.name} (${s.cidr})`);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    if (!row) return;
    setEditing({ index, name: row.name, subnets: [...(row.subnets ?? [])], description: row.description ?? "" });
  };

  const hint = editing ? uniqueNameHint(editing.name, rows.map((r) => r.name), editing.index) : "";

  const run = async (operation: Record<string, unknown>, message: string) => {
    try {
      await ops.mutateAsync([operation as never]);
      setEditing(null);
      notify(message, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const original = rows[editing.index];
    const network: NetworkDoc = {
      name: editing.name.trim(),
      subnets: editing.subnets,
      attach: original?.attach ?? [],
    };
    if (editing.description.trim()) network.description = editing.description.trim();
    void run({ kind: "update-network", networkName: original.name, network }, "Сети сохранены");
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить сеть ${rows[index].name}?`)) return;
    void run({ kind: "delete-network", networkName: rows[index].name }, "Сети сохранены");
  };

  const columns: Column<NetworkDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "subnets",
      title: "Подсети",
      render: (r) => (r.subnets?.length
        ? r.subnets.map((s) => <span className="owner-badge" key={s}>{s}</span>)
        : <span className="hint">нет подсетей</span>),
      filter: (r, q) => matchSubnetMembers(r.subnets, cidrOf, q),
    },
    {
      key: "description",
      title: "Описание",
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить сеть ${r.name}`} onClick={() => open(rows.indexOf(r))}><EditIcon /></button>
          <button type="button" className="icon-btn delete" title={`Удалить сеть ${r.name}`} onClick={() => remove(rows.indexOf(r))}><DeleteIcon /></button>
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-networks">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Сетей нет — создайте их на схеме"
        hint={<><h3>Сети</h3><p className="hint">L2-сегменты: привязка к устройствам и список подсетей.</p></>}
      />
      <Modal
        open={!!editing}
        wide
        title="Изменить сеть"
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || ops.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label>
              Подсети
              <MemberList
                members={editing.subnets}
                detailOf={cidrOf}
                onRemove={(s) => setEditing({ ...editing, subnets: editing.subnets.filter((x) => x !== s) })}
                candidates={candidates(editing)}
                addPlaceholder="все подсети — начните вводить для поиска"
                onAdd={(raw) => setEditing({ ...editing, subnets: [...editing.subnets, raw.split(" (")[0]] })}
                empty="Подсети не добавлены"
              />
            </label>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}
