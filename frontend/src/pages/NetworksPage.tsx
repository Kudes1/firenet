import { useMemo, useState } from "react";
import { useProjectResource, useTopologyOperations } from "../api/queries";
import type { NetworkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { NetworkEditForm } from "../topology/editForms";
import { DeleteIcon, EditIcon } from "../components/icons";

export default function NetworksPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const ops = useTopologyOperations();
  const [editing, setEditing] = useState<number | null>(null);

  const rows = topology.data?.networks ?? [];
  const allSubnets = subnets.data?.subnets ?? [];
  const cidrOf = useMemo(() => {
    const map = new Map(allSubnets.map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [allSubnets]);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    if (rows[index]) setEditing(index);
  };

  const run = async (operation: Record<string, unknown>, message: string) => {
    try {
      await ops.mutateAsync([operation as never]);
      setEditing(null);
      notify(message, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const columns: Column<NetworkDoc>[] = [
    { key: "name", title: "Имя", width: "22%", minWidth: 160, render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "subnets",
      title: "Подсети",
      width: "38%",
      minWidth: 250,
      render: (r) => (r.subnets?.length
        ? r.subnets.map((s) => <span className="owner-badge" key={s}>{s}</span>)
        : <span className="hint">нет подсетей</span>),
      filter: (r, q) => matchSubnetMembers(r.subnets, cidrOf, q),
    },
    {
      key: "description",
      title: "Описание",
      width: "28%",
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
        <div className="network-actions">
          <button type="button" className="icon-btn network-action edit" title={`Изменить сеть ${r.name}`} aria-label={`Изменить сеть ${r.name}`} onClick={() => open(rows.indexOf(r))}><EditIcon /></button>
          <button type="button" className="icon-btn network-action delete" title={`Удалить сеть ${r.name}`} aria-label={`Удалить сеть ${r.name}`} onClick={() => run({ kind: "delete-network", networkName: r.name }, "Сети сохранены")}><DeleteIcon /></button>
        </div>
      ),
    },
  ];

  const network = editing === null ? null : rows[editing];

  return (
    <main className="page networks-page" data-testid="page-networks">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Сетей нет — создайте их на схеме"
        resizable
        storageKey="firenet:networks:column-widths"
        hint={(
          <div className="networks-heading">
            <h1>Сети</h1>
            <p className="hint">L2-сегменты: привязка к устройствам и список подсетей.</p>
          </div>
        )}
      />
      <Modal
        open={!!network}
        wide
        title={network ? `Изменить сеть ${network.name}` : ""}
        onClose={() => setEditing(null)}
      >
        {network && (
          <NetworkEditForm
            network={network}
            networks={rows}
            allSubnets={allSubnets}
            existingNames={rows.map((r) => r.name)}
            saving={ops.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(operations) => void run(operations[0] as unknown as Record<string, unknown>, "Сети сохранены")}
          />
        )}
      </Modal>
    </main>
  );
}
