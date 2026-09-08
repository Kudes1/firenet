import { useMemo, useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { SubnetDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, ipv4CidrOverlap } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { DeleteIcon, EditIcon } from "../components/icons";

type Draft = { index: number; name: string; cidr: string; description: string };

export default function SubnetsPage() {
  const { isReadOnly } = useDraft();
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const topology = useProjectResource<TopologyDoc>("topology");
  const save = useProjectSave<SubnetsDoc>("subnets");
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = subnets.data?.subnets ?? [];

  // Сеть-владелец выводится обратным поиском: привязка хранится на сети,
  // а не на подсети.
  const ownerOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const net of topology.data?.networks ?? []) {
      for (const s of net.subnets ?? []) map.set(s, net.name);
    }
    return map;
  }, [topology.data]);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    setEditing(row
      ? { index, name: row.name, cidr: row.cidr, description: row.description ?? "" }
      : { index: -1, name: "", cidr: "", description: "" });
  };

  const hint = editing ? subnetHint(editing, rows) : "";

  const persist = async (list: SubnetDoc[]) => {
    try {
      await save.mutateAsync({ subnets: list });
      setEditing(null);
      notify("Подсети сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const next: SubnetDoc = { name: editing.name.trim(), cidr: editing.cidr.trim() };
    if (editing.description.trim()) next.description = editing.description.trim();
    const list = rows.slice();
    if (editing.index >= 0) list[editing.index] = next;
    else list.push(next);
    void persist(list);
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить подсеть ${rows[index].name}?`)) return;
    void persist(rows.filter((_, i) => i !== index));
  };

  const columns: Column<SubnetDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    { key: "cidr", title: "CIDR", render: (r) => r.cidr, filter: (r, q) => containsFold(r.cidr, q) },
    {
      key: "owner",
      title: "Сеть",
      render: (r) => ownerOf.get(r.name)
        ? <span className="owner-badge">{ownerOf.get(r.name)}</span>
        : <span className="hint">не входит ни в одну сеть</span>,
      filter: (r, q) => containsFold(ownerOf.get(r.name), q),
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
          <button type="button" className="icon-btn edit" title={`Изменить подсеть ${r.name}`} onClick={() => open(rows.indexOf(r))}><EditIcon /></button>
          <button type="button" className="icon-btn delete" title={`Удалить подсеть ${r.name}`} onClick={() => remove(rows.indexOf(r))}><DeleteIcon /></button>
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-subnets">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Подсетей нет — добавьте первую"
        hint={<><h3>Подсети</h3><p className="hint">Именованные CIDR-блоки, из которых собираются сети и наборы.</p></>}
        actions={<button type="button" className="primary" title="Добавить подсеть" onClick={() => open(-1)}>+ Подсеть</button>}
      />
      <Modal
        open={!!editing}
        title={editing && editing.index >= 0 ? "Изменить подсеть" : "Новая подсеть"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || save.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="lan" />
            </label>
            <label>
              CIDR
              <input value={editing.cidr} onChange={(e) => setEditing({ ...editing, cidr: e.target.value })} placeholder="10.0.0.0/24" />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}

// Та же последовательность проверок, что в легаси: имя и CIDR обязательны,
// имя уникально, CIDR не пересекается с существующими.
function subnetHint(draft: Draft, rows: SubnetDoc[]): string {
  if (!draft.name.trim()) return "Имя обязательно";
  if (!draft.cidr.trim()) return "CIDR обязателен";
  const nameHint = uniqueNameHint(draft.name, rows.map((r) => r.name), draft.index);
  if (nameHint) return nameHint; // имя уже занято (пустое отсечено выше)
  const clash = rows.find((r, i) => i !== draft.index && ipv4CidrOverlap(r.cidr, draft.cidr));
  if (clash) return `Пересекается с ${clash.name} (${clash.cidr})`;
  return "";
}
