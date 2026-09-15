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
const KIND_CLASS: Record<string, string> = { router: "device-kind-router", switch: "device-kind-switch" };

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
    { key: "name", title: "Имя", width: "22%", minWidth: 160, render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "kind",
      title: "Тип",
      width: "16%",
      minWidth: 130,
      render: (r) => <span className={`device-kind ${KIND_CLASS[r.kind] ?? "device-kind-other"}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>,
    },
    {
      key: "union",
      title: "Объединение",
      width: "20%",
      minWidth: 150,
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
      width: "30%",
      minWidth: 180,
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      width: "12%",
      minWidth: 84,
      filterReset: true,
      render: (r) => (
        <div className="device-actions">
          <button type="button" className="icon-btn device-action edit" title={`Изменить устройство ${r.name}`} aria-label={`Изменить устройство ${r.name}`} onClick={() => open(rows.indexOf(r))}><EditIcon /></button>
          <button type="button" className="icon-btn device-action delete" title={`Удалить устройство ${r.name}`} aria-label={`Удалить устройство ${r.name}`} onClick={() => run([{ kind: "delete-device", deviceName: r.name }], "Устройство удалено")}><DeleteIcon /></button>
        </div>
      ),
    },
  ];

  const device = editing === null ? null : rows[editing];

  return (
    <main className="page devices-page" data-testid="page-devices">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Устройств нет — создайте их на схеме"
        resizable
        storageKey="firenet:devices:column-widths"
        hint={(
          <div className="devices-heading">
            <h1>Устройства</h1>
            <p className="hint">Маршрутизаторы и коммутаторы топологии.</p>
          </div>
        )}
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
