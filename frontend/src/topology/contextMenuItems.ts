import type { TopologyDoc } from "../api/types";
import type { MenuItem } from "./ContextMenu";
import { canonicalLink } from "../lib/links";

export type CanvasTarget =
  | { kind: "node"; id: string } // device:<name> | network:<name>
  | { kind: "link"; id: string; a: string; b: string; filtered: boolean }
  | { kind: "attach"; id: string; network: string; device: string };

export type ContextMenuActions = {
  editDevice: (name: string) => void;
  editNetwork: (name: string) => void;
  editLinkFilter: (a: string, b: string) => void;
  setUnion: (name: string, kind: "device" | "network", union: string | null) => void;
  deleteNode: (id: string) => void;
  deleteLink: (a: string, b: string) => void;
  detachNetwork: (network: string, device: string) => void;
};

type Input = {
  doc: TopologyDoc;
  target: CanvasTarget;
  editable: boolean;
  // Фильтры требуют, чтобы связь уже существовала на сервере.
  isLinkPending?: (a: string, b: string) => boolean;
  // RF-выделение на момент ПКМ: если курсор на одном из выбранных узлов,
  // операции объединения применяются ко всем (паритет с легаси).
  selection?: string[];
  actions: ContextMenuActions;
};

type NamedNode = { name: string; kind: "device" | "network" };

// menuItemsFor легаси: редактирование, объединения (с учётом мультивыбора),
// удаление по идентичности — kind/name фиксируются строками при построении
// меню, а не ссылками на живой документ.
export function contextMenuItems({ doc, target, editable, isLinkPending, selection = [], actions }: Input): MenuItem[] {
  if (target.kind === "link") {
    const { a, b } = target;
    const [x, y] = canonicalLink(a, b);
    return [
      {
        label: target.filtered ? "Редактировать фильтр" : "Фильтровать",
        action: editable && !isLinkPending?.(a, b) ? () => actions.editLinkFilter(a, b) : undefined,
      },
      { label: `Удалить связь ${x}–${y}`, danger: true, action: editable ? () => actions.deleteLink(a, b) : undefined },
    ];
  }
  if (target.kind === "attach") {
    const { network, device } = target;
    return [
      { label: `Удалить привязку ${network}–${device}`, danger: true, action: editable ? () => actions.detachNetwork(network, device) : undefined },
    ];
  }

  // Узел: устройство или сеть.
  const kind = target.id.startsWith("device:") ? "device" : "network";
  const name = target.id.slice(kind.length + 1);
  const node: NamedNode = { name, kind };

  // Мультивыбор: курсор на выбранном узле → операции объединения для всех
  // выбранных узлов (связи/привязки в объединения не входят — отбрасываются).
  const selectedNodeIds = selection.filter((id) => id.startsWith("device:") || id.startsWith("network:"));
  const selectedNodes = selectedNodeIds.includes(target.id) && selectedNodeIds.length > 1
    ? selectedNodeIds
      .map((id): NamedNode | null => (id.startsWith("device:") || id.startsWith("network:")
        ? { name: id.slice(id.indexOf(":") + 1), kind: id.startsWith("device:") ? "device" : "network" }
        : null))
      .filter((n): n is NamedNode => n !== null)
    : [node];

  const inUnion = (union: { devices?: string[]; networks?: string[] }) =>
    selectedNodes.some((n) => (union[n.kind === "device" ? "devices" : "networks"] ?? []).includes(n.name));

  const unions = doc.unions ?? [];
  const items: MenuItem[] = [
    {
      label: "Редактировать",
      action: editable
        ? () => (kind === "device" ? actions.editDevice(name) : actions.editNetwork(name))
        : undefined,
    },
  ];
  if (unions.some(inUnion)) {
    items.push({
      label: "Убрать из объединения",
      action: editable ? () => selectedNodes.forEach((n) => actions.setUnion(n.name, n.kind, null)) : undefined,
    });
  }
  // Кандидаты — объединения, куда входит хотя бы один из выбранных узлов:
  // недостающие добавляются, уже сидящие пропускаются (повторного
  // union-add нет). Членство проверяется по полю типа КАЖДОГО узла,
  // а не типом узла под курсором.
  const missing = (u: { name: string; devices?: string[]; networks?: string[] }) =>
    selectedNodes.filter((n) => !((u[n.kind === "device" ? "devices" : "networks"] ?? []).includes(n.name)));
  const candidates = unions
    .filter((u) => missing(u).length > 0)
    .map((u) => ({
      label: `В объединение «${u.name}»`,
      action: editable
        ? () => missing(u).forEach((n) => actions.setUnion(n.name, n.kind, u.name))
        : undefined,
    }));
  items.push({
    label: "Добавить в объединение",
    children: candidates,
    searchable: candidates.length > 1,
  });

  const label = kind === "device" ? `устройство ${name}` : `сеть ${name}`;
  items.push({
    label: `Удалить ${label}`,
    danger: true,
    action: editable ? () => actions.deleteNode(target.id) : undefined,
  });
  return items;
}
