import { useMemo, useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { SetDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchPrefixQuery, matchSubnetMembers } from "../lib/search";
import { parseHostAddress, uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { DeleteIcon, EditIcon } from "../components/icons";

type Draft = { index: number; name: string; subnets: string[]; addresses: string[]; description: string };

export default function SetsPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [addressError, setAddressError] = useState("");

  const rows = topology.data?.sets ?? [];
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
    setAddressInput("");
    setAddressError("");
    const row = rows[index];
    setEditing(row
      ? { index, name: row.name, subnets: [...(row.subnets ?? [])], addresses: [...(row.addresses ?? [])], description: row.description ?? "" }
      : { index: -1, name: "", subnets: [], addresses: [], description: "" });
  };

  const addAddress = () => {
    if (!editing) return;
    const parsed = parseHostAddress(addressInput);
    if (!parsed) {
      setAddressError("Адрес: голый IP или маска /32 (для IPv6 — /128)");
      return;
    }
    if (editing.addresses.some((a) => a.split("/")[0] === parsed.split("/")[0])) {
      setAddressError("Адрес уже добавлен");
      return;
    }
    setEditing({ ...editing, addresses: [...editing.addresses, parsed] });
    setAddressInput("");
    setAddressError("");
  };

  const hint = editing ? setHint(editing, rows) : "";

  const persist = async (sets: SetDoc[]) => {
    if (!topology.data) return;
    try {
      await save.mutateAsync({ ...topology.data, sets });
      setEditing(null);
      notify("Наборы сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const set: SetDoc = { name: editing.name.trim(), subnets: editing.subnets, addresses: editing.addresses };
    if (editing.description.trim()) set.description = editing.description.trim();
    const next = rows.slice();
    if (editing.index >= 0) next[editing.index] = set;
    else next.push(set);
    void persist(next);
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить набор ${rows[index].name}?`)) return;
    void persist(rows.filter((_, i) => i !== index));
  };

  const columns: Column<SetDoc>[] = [
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
      key: "addresses",
      title: "Адреса",
      render: (r) => (r.addresses?.length
        ? r.addresses.map((a) => <span className="owner-badge" key={a}>{a}</span>)
        : <span className="hint">нет адресов</span>),
      filter: (r, q) => (r.addresses ?? []).some((a) => matchPrefixQuery(a, q)),
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
          <button type="button" className="icon-btn edit" title={`Изменить набор ${r.name}`} onClick={() => open(rows.indexOf(r))}><EditIcon /></button>
          <button type="button" className="icon-btn delete" title={`Удалить набор ${r.name}`} onClick={() => remove(rows.indexOf(r))}><DeleteIcon /></button>
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-sets">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Наборов нет — добавьте первый"
        hint={<><h3>Наборы</h3><p className="hint">Именованные группы адресов для правил.</p></>}
        actions={<button type="button" className="primary" title="Добавить набор" onClick={() => open(-1)}>+ Набор</button>}
      />
      <Modal
        open={!!editing}
        wide
        title={editing && editing.index >= 0 ? "Изменить набор" : "Новый набор"}
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
            <label>
              Подсети
              <MemberList
                members={editing.subnets}
                detailOf={cidrOf}
                onRemove={(s) => setEditing({ ...editing, subnets: editing.subnets.filter((x) => x !== s) })}
                candidates={allSubnets.filter((s) => !editing.subnets.includes(s.name)).map((s) => `${s.name} (${s.cidr})`)}
                onAdd={(raw) => setEditing({ ...editing, subnets: [...editing.subnets, raw.split(" (")[0]] })}
                empty="Подсети не добавлены"
              />
            </label>
            <label>
              Адреса
              <MemberList
                members={editing.addresses}
                onRemove={(a) => setEditing({ ...editing, addresses: editing.addresses.filter((x) => x !== a) })}
                empty="Адреса не добавлены"
              />
              <div className="member-add">
                <input
                  value={addressInput}
                  placeholder="10.0.0.5"
                  onChange={(e) => setAddressInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAddress(); } }}
                />
                <button type="button" title="Добавить адрес" onClick={addAddress}>+</button>
              </div>
              {(addressError || hint) && <p className="cell-hint">{addressError || hint}</p>}
            </label>
          </div>
        )}
      </Modal>
    </main>
  );
}

function setHint(draft: Draft, rows: SetDoc[]): string {
  const nameHint = uniqueNameHint(draft.name, rows.map((r) => r.name), draft.index);
  if (nameHint) return nameHint;
  if (!draft.subnets.length && !draft.addresses.length) return "Нужна хотя бы одна подсеть или адрес";
  return "";
}
