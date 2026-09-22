import type { LayoutDoc, LayoutPoint, LinkDoc, TopologyDoc } from "../api/types";
import { layoutLinkKey } from "../lib/links";
import { DEVICE_H, DEVICE_W, NET_H, NET_W, UNION_COLORS } from "./icons";

export { DEVICE_H, DEVICE_W, NET_H, NET_W };

export type SceneNode = {
  id: string;
  type: "device" | "network";
  position: { x: number; y: number };
  data: {
    name: string;
    kind: string;
    description?: string;
    subnets?: string[];
  };
};

export type SceneEdge = {
  id: string;
  type: "link" | "attach";
  source: string;
  target: string;
  data: {
    offset: number;
    filtered: boolean;
    filter?: LinkDoc["filter"];
    waypoints?: LayoutPoint[];
    // Концы линии в координатах сцены — центры узлов (как в легаси), а не
    // хэндлы на границах: RF ставит конец ребра в хэндл, поэтому центры
    // передаются в данных и LinkEdge рисует по ним.
    from: LayoutPoint;
    to: LayoutPoint;
  };
};

export type Scene = { nodes: SceneNode[]; edges: SceneEdge[]; viewport?: { x: number; y: number; zoom: number } };

// Палитра различимых оттенков; цвет объединения = его порядок в документе.
const UNION_PAD = 30;
export const unionColor = (index: number) => UNION_COLORS[index % UNION_COLORS.length];

export type UnionBox = { name: string; color: string; x: number; y: number; w: number; h: number };

// Позиция участника объединения по типу и имени. Канва передаёт живые
// позиции узлов, чтобы контур следовал за перетаскиванием сразу.
export type PositionOf = (kind: "device" | "network", name: string) => LayoutPoint | undefined;

// unionBoxes считает bbox участников каждого объединения с отступом UNION_PAD
// (легаси unionBox в topo_scene.js). Объединение без позиционированных
// участников не рисуется.
export function unionBoxes(topology: TopologyDoc, positionOf: PositionOf): UnionBox[] {
  const sizes: Record<string, [number, number]> = { device: [DEVICE_W, DEVICE_H], network: [NET_W, NET_H] };
  return (topology.unions ?? []).flatMap((u, i) => {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const kind of ["device", "network"] as const) {
      for (const name of u[kind === "device" ? "devices" : "networks"] ?? []) {
        const p = positionOf(kind, name);
        if (!p) continue;
        const [w, h] = sizes[kind];
        x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x + w); y2 = Math.max(y2, p.y + h);
      }
    }
    if (x1 === Infinity) return [];
    return [{ name: u.name, color: unionColor(i), x: x1 - UNION_PAD, y: y1 - UNION_PAD, w: x2 - x1 + 2 * UNION_PAD, h: y2 - y1 + 2 * UNION_PAD }];
  });
}

// Позиция по умолчанию для объекта без записи в layout: устройства и сети
// раскладываются на разные сетки, чтобы не накладываться при первом открытии.
export function defaultPoint(kind: "device" | "network", index: number) {
  const x = 40 + (index % 5) * 200;
  const y = kind === "device" ? 40 + Math.floor(index / 5) * 160 : 300 + Math.floor(index / 5) * 160;
  return { x, y };
}

export type ParsedEdgeId =
  | { kind: "link"; a: string; b: string; offset: number }
  | { kind: "attach"; network: string; device: string };

export function formatLinkEdgeId(a: string, b: string, offset: number): string {
  return `link:${layoutLinkKey(a, b)}#${offset}`;
}

export function formatAttachEdgeId(network: string, device: string): string {
  return `attach:${network}|${device}`;
}

const pairOf = (raw: string): [string, string] | null => {
  const parts = raw.split("|");
  return parts.length === 2 && parts[0] && parts[1] && !parts[0].includes("#") && !parts[1].includes("#")
    ? [parts[0], parts[1]]
    : null;
};

export function parseEdgeId(id: string): ParsedEdgeId | null {
  const sep = id.indexOf(":");
  if (sep < 0) return null;
  const type = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  if (type === "attach") {
    const pair = pairOf(rest);
    return pair ? { kind: "attach", network: pair[0], device: pair[1] } : null;
  }
  if (type === "link") {
    const hash = rest.lastIndexOf("#");
    if (hash < 0) return null;
    const token = rest.slice(hash + 1);
    const pair = pairOf(rest.slice(0, hash));
    return /^(0|[1-9]\d*)$/.test(token) && pair
      ? { kind: "link", a: pair[0], b: pair[1], offset: Number(token) }
      : null;
  }
  return null;
}

// linkOffsets разносит резервные связи (одинаковая пара устройств) по
// индексу-дубликату, чтобы они рисовались параллельными линиями.
function linkOffsets(links: LinkDoc[]): number[] {
  const seen = new Map<string, number>();
  return links.map((l) => {
    const key = layoutLinkKey(l.a.device, l.b.device);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}

// buildScene — единственный источник nodes/edges для React Flow. Чистая
// функция: документ и layout на входе, позиции и данные на выходе, никаких
// обращений к DOM и никакого состояния страницы.
export function buildScene(topology: TopologyDoc, layout: LayoutDoc): Scene {
  const devices = topology.devices ?? [];
  const networks = topology.networks ?? [];
  const links = topology.links ?? [];

  // В сцену попадают только объекты с позицией в layout: сервер хранит
  // лишь то, что пользователь реально расставил, а позицию по умолчанию
  // (defaultPoint) страница присваивает при создании нового объекта.
  const nodes: SceneNode[] = [];
  devices.forEach((d) => {
    const position = layout.devices?.[d.name];
    if (!position) return;
    nodes.push({
      id: `device:${d.name}`,
      type: "device",
      position,
      data: {
        name: d.name,
        kind: d.kind,
        description: d.description,
      },
    });
  });
  networks.forEach((n) => {
    const position = layout.networks?.[n.name];
    if (!position) return;
    nodes.push({
      id: `network:${n.name}`,
      type: "network",
      position,
      data: {
        name: n.name,
        kind: "network",
        description: n.description,
        subnets: n.subnets,
      },
    });
  });

  // Центры узлов: легаси проводил все связи между центрами (линии уходят
  // под тела узлов), а не между точками на границах.
  const centerOf = new Map<string, LayoutPoint>();
  for (const n of nodes) {
    const [w, h] = n.type === "network" ? [NET_W, NET_H] : [DEVICE_W, DEVICE_H];
    centerOf.set(n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2 });
  }
  const offsets = linkOffsets(links);
  const edges: SceneEdge[] = [];

  links.forEach((l, i) => {
    const source = `device:${l.a.device}`;
    const target = `device:${l.b.device}`;
    // Связь без позиции хотя бы одного конца не рисуется: некуда проводить.
    const from = centerOf.get(source);
    const to = centerOf.get(target);
    if (!from || !to) return;
    const key = layoutLinkKey(l.a.device, l.b.device);
    const wps = layout.links?.[key]?.[offsets[i]];
    edges.push({
      id: formatLinkEdgeId(l.a.device, l.b.device, offsets[i]),
      type: "link",
      source,
      target,
      data: {
        offset: offsets[i],
        filtered: !!l.filter,
        filter: l.filter,
        waypoints: wps,
        from,
        to,
      },
    });
  });

  networks.forEach((n) => {
    for (const a of n.attach ?? []) {
      const source = `device:${a.device}`;
      const target = `network:${n.name}`;
      const from = centerOf.get(source);
      const to = centerOf.get(target);
      if (!from || !to) continue;
      edges.push({
        id: formatAttachEdgeId(n.name, a.device),
        type: "attach",
        source,
        target,
        data: { offset: 0, filtered: false, from, to },
      });
    }
  });

  const camera = layout.camera;
  const viewport = camera && camera.z > 0 ? { x: camera.x, y: camera.y, zoom: camera.z } : undefined;

  return { nodes, edges, viewport };
}
