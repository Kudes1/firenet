import { useState } from "react";
import { useProjectResource, useTopologyOperations } from "../api/queries";
import type { DeviceDoc, TopologyDoc, UnionDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold } from "../lib/search";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { DeviceEditForm } from "../topology/editForms";
import { DeleteIcon, EditIcon } from "../components/icons";

const KIND_LABEL: Record<string, string> = { router: "маршрутизатор", switch: "коммутатор" };

export default function DevicesPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const ops = useTopologyOperations();
  const [editing, setEditing] = useState<number | null>(null);

  const rows = topology.data?.devices ?? [];
  const unions = topology.data?.unions ?? [];

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    if (rows[index]) setEditing(index);
  };

  const run = async (operations: Parameters<typeof ops.mutateAsync>[0], message: string) => {
    try {
      await ops.mutateAsync(operations);
      setEditing(null);
      notify(message, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const columns: Column<DeviceDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    { key: "kind", title: "Тип", render: (r) => KIND_LABEL[r.kind] ?? r.kind },
    {
      key: "union",
      title: "Объединение",
      render: (r) => {
        const union = unions.find((u) => (u.devices ?? []).includes(r.name));
        return union
          ? <span className="owner-badge">{union.name}</span>
          : <span className="hint">без объединения</span>;
      },
      filter: (r, q) => containsFold(unions.find((u) => (u.devices ?? []).includes(r.name))?.name, q),
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
      filterReset: true,
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить устройство ${r.name}`} onClick={() => open(rows.indexOf(r))}><EditIcon /></button>
          <button type="button" className="icon-btn delete" title={`Удалить устройство ${r.name}`} onClick={() => run([{ kind: "delete-device", deviceName: r.name }], "Устройство удалено")}><DeleteIcon /></button>
        </>
      ),
    },
  ];

  const device = editing === null ? null : rows[editing];

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
        open={!!device}
        title={device ? `Изменить устройство ${device.name}` : ""}
        onClose={() => setEditing(null)}
      >
        {device && (
          <DeviceEditForm
            device={device}
            unions={unions as UnionDoc[]}
            existingNames={rows.map((r) => r.name)}
            saving={ops.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(operations) => void run(operations, "Устройство сохранено")}
          />
        )}
      </Modal>
    </main>
  );
}
