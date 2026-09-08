import { useMemo, useState } from "react";
import { useProjectResource, useTopologyOperations } from "../api/queries";
import type { DeviceDoc, TopologyDoc, TopologyOperation } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; kind: string; union: string; description: string };

const KIND_LABEL: Record<string, string> = { switch: "коммутатор", router: "маршрутизатор" };

export default function DevicesPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const ops = useTopologyOperations();
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = topology.data?.devices ?? [];
  const unions = topology.data?.unions ?? [];

  // Членство в объединении хранится на объединении, поэтому страница
  // находит его обратным поиском.
  const unionOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of unions) for (const d of u.devices ?? []) map.set(d, u.name);
    return map;
  }, [unions]);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    if (!row) return;
    setEditing({
      index, name: row.name, kind: row.kind,
      union: unionOf.get(row.name) ?? "", description: row.description ?? "",
    });
  };

  const hint = editing ? uniqueNameHint(editing.name, rows.map((r) => r.name), editing.index) : "";

  const run = async (operations: TopologyOperation[], message: string) => {
    try {
      await ops.mutateAsync(operations);
      setEditing(null);
      notify(message, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const original = rows[editing.index];
    const name = editing.name.trim();
    const device: DeviceDoc = { name, kind: original.kind };
    if (editing.description.trim()) device.description = editing.description.trim();

    const previousUnion = unionOf.get(original.name);
    // update-device на бэкенде сам каскадно переименовывает устройство во всех
    // объединениях (topology_operations.go: renameStrings), поэтому операции
    // переноса ссылаются на НОВОЕ имя и добавляются только при смене union —
    // 1:1 с легаси devices.js:saveDraft.
    const operations: TopologyOperation[] = [
      { kind: "update-device", deviceName: original.name, device },
    ];
    if (previousUnion && previousUnion !== editing.union) {
      operations.push({ kind: "union-remove-device", unionName: previousUnion, deviceName: name });
    }
    if (editing.union && editing.union !== previousUnion) {
      operations.push({ kind: "union-add-device", unionName: editing.union, deviceName: name });
    }
    void run(operations, "Устройство сохранено");
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить устройство ${rows[index].name}?`)) return;
    void run([{ kind: "delete-device", deviceName: rows[index].name }], "Устройство удалено");
  };

  const columns: Column<DeviceDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    { key: "kind", title: "Тип", render: (r) => KIND_LABEL[r.kind] ?? r.kind },
    {
      key: "union",
      title: "Объединение",
      render: (r) => unionOf.get(r.name)
        ? <span className="owner-badge">{unionOf.get(r.name)}</span>
        : <span className="hint">без объединения</span>,
      filter: (r, q) => containsFold(unionOf.get(r.name), q),
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
          <button type="button" className="icon-btn edit" title={`Изменить устройство ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить устройство ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-devices">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Устройств нет — создайте их на схеме"
        hint={<><h3>Устройства</h3><p className="hint">Маршрутизаторы и коммутаторы топологии.</p></>}
      />
      <Modal
        open={!!editing}
        title="Изменить устройство"
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
              Объединение
              <select value={editing.union} onChange={(e) => setEditing({ ...editing, union: e.target.value })}>
                <option value="">— без объединения —</option>
                {unions.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
              </select>
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
