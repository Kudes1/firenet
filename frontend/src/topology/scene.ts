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
    unionColor?: string;
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
  };
};

export type Scene = { nodes: SceneNode[]; edges: SceneEdge[]; viewport?: { x: number; y: number; zoom: number } };

// Позиция по умолчанию для объекта без записи в layout: устройства и сети
// раскладываются на разные сетки, чтобы не накладываться при первом открытии.
export function defaultPoint(kind: "device" | "network", index: number) {
  const x = 40 + (index % 5) * 200;
  const y = kind === "device" ? 40 + Math.floor(index / 5) * 160 : 300 + Math.floor(index / 5) * 160;
  return { x, y };
}

export const unionColor = (index: number) => UNION_COLORS[index % UNION_COLORS.length];

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
  const unions = topology.unions ?? [];

  const colorOf = new Map<string, string>();
  unions.forEach((u, i) => {
    const color = unionColor(i);
    for (const d of u.devices ?? []) colorOf.set(`device:${d}`, color);
    for (const n of u.networks ?? []) colorOf.set(`network:${n}`, color);
  });

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
        unionColor: colorOf.get(`device:${d.name}`),
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
        unionColor: colorOf.get(`network:${n.name}`),
      },
    });
  });

  const placed = new Set(nodes.map((n) => n.id));
  const offsets = linkOffsets(links);
  const edges: SceneEdge[] = [];

  links.forEach((l, i) => {
    const source = `device:${l.a.device}`;
    const target = `device:${l.b.device}`;
    // Связь без позиции хотя бы одного конца не рисуется: некуда проводить.
    if (!placed.has(source) || !placed.has(target)) return;
    const key = layoutLinkKey(l.a.device, l.b.device);
    const wps = layout.links?.[key]?.[offsets[i]];
    edges.push({
      id: `link:${key}#${offsets[i]}`,
      type: "link",
      source,
      target,
      data: {
        offset: offsets[i],
        filtered: !!l.filter,
        filter: l.filter,
        waypoints: wps,
      },
    });
  });

  networks.forEach((n) => {
    for (const a of n.attach ?? []) {
      const source = `device:${a.device}`;
      const target = `network:${n.name}`;
      if (!placed.has(source) || !placed.has(target)) continue;
      edges.push({
        id: `attach:${n.name}|${a.device}`,
        type: "attach",
        source,
        target,
        data: { offset: 0, filtered: false },
      });
    }
  });

  const camera = layout.camera;
  const viewport = camera && camera.z > 0 ? { x: camera.x, y: camera.y, zoom: camera.z } : undefined;

  return { nodes, edges, viewport };
}
