import { useEffect, useMemo, useState } from "react";
import { useProjectResource } from "../api/queries";
import { api } from "../api/client";
import type { DeviceDoc, EntityDoc, LinkDoc, NetworkDoc, SubnetsDoc, TopologyOperation, UnionDoc } from "../api/types";
import { uniqueNameHint } from "../lib/validate";
import { canonicalLink } from "../lib/links";
import { useDraft } from "../draft/DraftContext";
import MemberList from "../components/ui/MemberList";
import { notify } from "../components/notify";

// Формы редактирования без оболочки Modal: страницы-таблицы и канва
// оборачивают их в свой Modal и подставляют свой способ сохранения
// (страницы — mutateAsync, канва — очередь useTopologyEditor).

type SubmitProps = {
  onSubmit: (operations: TopologyOperation[]) => void;
  onCancel: () => void;
  saving?: boolean;
};

export function DeviceEditForm({
  device, unions, existingNames, onSubmit, onCancel, saving,
}: SubmitProps & {
  device: DeviceDoc;
  unions: UnionDoc[];
  existingNames: string[];
}) {
  const [name, setName] = useState(device.name);
  const [description, setDescription] = useState(device.description ?? "");
  const [union, setUnion] = useState(
    unions.find((u) => (u.devices ?? []).includes(device.name))?.name ?? "",
  );
  const hint = uniqueNameHint(name, existingNames, existingNames.indexOf(device.name));

  const submit = () => {
    if (hint) return;
    const next: DeviceDoc = { name: name.trim(), kind: device.kind };
    if (description.trim()) next.description = description.trim();
    const previousUnion = unions.find((u) => (u.devices ?? []).includes(device.name))?.name;
    // update-device каскадно переименовывает устройство во всех объединениях
    // (topology_operations.go:215), поэтому перенос ссылается на НОВОЕ имя,
    // если оно сменилось: к моменту union-remove в батче rename уже применён.
    const renamed = next.name !== device.name;
    const unionTarget = renamed ? next.name : device.name;
    const operations: TopologyOperation[] = [{ kind: "update-device", deviceName: device.name, device: next }];
    if (previousUnion && previousUnion !== union) {
      operations.push({ kind: "union-remove-device", unionName: previousUnion, deviceName: unionTarget });
    }
    if (union && union !== previousUnion) {
      operations.push({ kind: "union-add-device", unionName: union, deviceName: unionTarget });
    }
    onSubmit(operations);
  };

  return (
    <div className="modal-grid">
      <label>
        Имя
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Объединение
        <select value={union} onChange={(e) => setUnion(e.target.value)}>
          <option value="">— без объединения —</option>
          {unions.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
        </select>
      </label>
      <label>
        Описание
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {hint && <p className="cell-hint">{hint}</p>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Отмена</button>
        <button type="button" className="primary" disabled={!!hint || saving} onClick={submit}>Сохранить</button>
      </div>
    </div>
  );
}

export function NetworkEditForm({
  network, networks, allSubnets, existingNames, onSubmit, onCancel, saving,
}: SubmitProps & {
  network: NetworkDoc;
  networks: NetworkDoc[];
  allSubnets: { name: string; cidr: string }[];
  existingNames: string[];
}) {
  const [name, setName] = useState(network.name);
  const [description, setDescription] = useState(network.description ?? "");
  const [subnets, setSubnets] = useState<string[]>([...(network.subnets ?? [])]);
  const hint = uniqueNameHint(name, existingNames, existingNames.indexOf(network.name));

  const cidrOf = useMemo(() => {
    const map = new Map(allSubnets.map((s) => [s.name, s.cidr]));
    return (n: string) => map.get(n) ?? "";
  }, [allSubnets]);

  // Инвариант легаси: подсеть входит не более чем в одну сеть, поэтому
  // кандидат должен быть свободен либо уже принадлежать этой сети.
  const candidates = allSubnets
    .filter((s) => !networks.some((n) => n.name !== network.name && (n.subnets ?? []).includes(s.name)))
    .filter((s) => !subnets.includes(s.name))
    .map((s) => `${s.name} (${s.cidr})`);

  const submit = () => {
    if (hint) return;
    const next: NetworkDoc = { name: name.trim(), subnets, attach: network.attach ?? [] };
    if (description.trim()) next.description = description.trim();
    onSubmit([{ kind: "update-network", networkName: network.name, network: next }]);
  };

  return (
    <div className="modal-grid">
      <label>
        Имя
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Описание
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Подсети
        <MemberList
          members={subnets}
          detailOf={cidrOf}
          onRemove={(s) => setSubnets(subnets.filter((x) => x !== s))}
          candidates={candidates}
          addPlaceholder="все подсети — начните вводить для поиска"
          onAdd={(raw) => setSubnets([...subnets, raw.split(" (")[0]])}
          empty="Подсети не добавлены"
        />
      </label>
      {hint && <p className="cell-hint">{hint}</p>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>Отмена</button>
        <button type="button" className="primary" disabled={!!hint || saving} onClick={submit}>Сохранить</button>
      </div>
    </div>
  );
}

export function LinkFilterForm({
  link, onSave,
}: {
  link: LinkDoc;
  onSave: (next: LinkDoc) => Promise<void>;
}) {
  const { a, b } = link;
  const [x, y] = canonicalLink(a.device, b.device);
  // Экспорты хранятся по сторонам A/B документа; канонический порядок может
  // их переставлять — переносим вместе с концами (1:1 со LinksPage.rows).
  const swapped = x !== a.device;
  const [aExports, setAExports] = useState<string[]>(link.filter?.aExports ?? []);
  const [bExports, setBExports] = useState<string[]>(link.filter?.bExports ?? []);
  const [exports, setExports] = useState<{ a: EntityDoc[]; b: EntityDoc[] }>({ a: [], b: [] });
  const { apiPath } = useDraft();

  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const cidrOf = useMemo(() => {
    const map = new Map((subnets.data?.subnets ?? []).map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [subnets.data]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.get<{ entities: EntityDoc[] }>(apiPath(`link-exports?side=a&a=${x}&b=${y}`)),
      api.get<{ entities: EntityDoc[] }>(apiPath(`link-exports?side=b&a=${x}&b=${y}`)),
    ]).then(([sideA, sideB]) => {
      if (!cancelled) setExports({ a: sideA.entities, b: sideB.entities });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [apiPath, x, y]);

  const persist = async (nextA: string[], nextB: string[]) => {
    setAExports(nextA);
    setBExports(nextB);
    const filter = swapped ? { aExports: nextB, bExports: nextA } : { aExports: nextA, bExports: nextB };
    await onSave({ a, b, filter });
    notify("Связи сохранены", "ok");
  };

  const sides = [
    { key: "a" as const, device: x, mine: aExports, theirs: bExports, candidates: exports.a },
    { key: "b" as const, device: y, mine: bExports, theirs: aExports, candidates: exports.b },
  ];

  return (
    <div className="link-panel-grid">
      {sides.map((side) => (
        <fieldset className={side.key === "a" ? "link-end-col-a" : "link-end-col-b"} key={side.key}>
          <legend>{side.device}</legend>
          <div className="filter-dirs">
            <div>
              <p className="filter-dir-title">Экспорт</p>
              <MemberList
                members={side.mine}
                detailOf={cidrOf}
                onRemove={(name) => {
                  const next = side.mine.filter((v) => v !== name);
                  void persist(side.key === "a" ? next : aExports, side.key === "b" ? next : bExports);
                }}
                candidates={side.candidates.map((e) => `${e.name} (${e.cidr ?? ""})`)}
                onAdd={(raw) => {
                  const name = raw.split(" (")[0];
                  if (side.mine.includes(name)) return;
                  void persist(
                    side.key === "a" ? [...aExports, name] : aExports,
                    side.key === "b" ? [...bExports, name] : bExports,
                  );
                }}
                empty="Ничего не экспортируется"
              />
            </div>
            <div>
              <p className="filter-dir-title">Импорт</p>
              {/* Импорт стороны — экспорт соседа: read-only, как в легаси. */}
              <MemberList readOnly members={side.theirs} detailOf={cidrOf} empty="Ничего не импортируется" />
            </div>
          </div>
        </fieldset>
      ))}
    </div>
  );
}
