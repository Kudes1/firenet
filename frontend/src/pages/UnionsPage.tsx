import { useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { TopologyDoc, UnionDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; description: string };

export default function UnionsPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = topology.data?.unions ?? [];

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    setEditing(row
      ? { index, name: row.name, description: row.description ?? "" }
      : { index: -1, name: "", description: "" });
  };

  const hint = editing ? uniqueNameHint(editing.name, rows.map((r) => r.name), editing.index) : "";

  const persist = async (unions: UnionDoc[]) => {
    if (!topology.data) return;
    try {
      await save.mutateAsync({ ...topology.data, unions });
      setEditing(null);
      notify("Объединения сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const previous = rows[editing.index] as UnionDoc | undefined;
    const union: UnionDoc = {
      name: editing.name.trim(),
      // Состав назначается на холсте: страница его не меняет, но и не
      // затирает при переименовании.
      devices: previous?.devices ?? [],
      networks: previous?.networks ?? [],
    };
    if (editing.description.trim()) union.description = editing.description.trim();
    const next = rows.slice();
    if (editing.index >= 0) next[editing.index] = union;
    else next.push(union);
    void persist(next);
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить объединение ${rows[index].name}?`)) return;
    void persist(rows.filter((_, i) => i !== index));
  };

  const columns: Column<UnionDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "devices",
      title: "Устройства",
      render: (r) => (r.devices?.length
        ? r.devices.map((d) => <span className="owner-badge" key={d}>{d}</span>)
        : <span className="hint">нет устройств</span>),
      filter: (r, q) => (r.devices ?? []).some((d) => containsFold(d, q)),
    },
    {
      key: "networks",
      title: "Сети",
      render: (r) => (r.networks?.length
        ? r.networks.map((n) => <span className="owner-badge" key={n}>{n}</span>)
        : <span className="hint">нет сетей</span>),
      filter: (r, q) => (r.networks ?? []).some((n) => containsFold(n, q)),
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
          <button type="button" className="icon-btn edit" title={`Изменить объединение ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить объединение ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-unions">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Объединений нет — создайте на схеме"
        hint={<><h3>Объединения</h3><p className="hint">Визуальные группы устройств и сетей.</p></>}
        actions={<button type="button" className="primary" title="Добавить объединение" onClick={() => open(-1)}>+ Объединение</button>}
      />
      <Modal
        open={!!editing}
        title={editing && editing.index >= 0 ? "Изменить объединение" : "Новое объединение"}
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
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <p className="cell-hint">Состав объединения назначается на холсте топологии через контекстное меню.</p>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}
