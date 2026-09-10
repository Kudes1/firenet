import { BaseEdge, type EdgeProps } from "@xyflow/react";

// Геометрия линии — перенос pointAt/spreadOffset из легаси (netmap.js):
// связь — отрезок центр-цент; резервные (параллельные) связи смещаются
// перпендикуляром в середине, превращаясь в лёгкую дугу.
const spreadOffset = (index: number) => {
  const magnitude = Math.ceil(index / 2) * 14;
  return index % 2 === 0 ? magnitude : -magnitude;
};

// Точка на отрезке ab на доле t, смещённая перпендикуляром на offset.
function pointAt(a: { x: number; y: number }, b: { x: number; y: number }, t: number, offset: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: a.x + dx * t + (-dy / len) * offset, y: a.y + dy * t + (dx / len) * offset };
}

// Путь связи: явные waypoints — ломаная центр→waypoints→центр (как в легаси,
// полигон со скруглением даёт stroke-linejoin), иначе прямая, для параллельных
// связей — дуга через смещённую середину.
function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, offset: number,
  waypoints?: Array<{ x: number; y: number }>) {
  const pts = waypoints?.length ? [from, ...waypoints, to] : null;
  if (pts) return pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const mid = pointAt(from, to, 0.5, spreadOffset(offset));
  return `M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`;
}

// Ребро связи. Концы — центры узлов из data (from/to), НЕ хэндлы: RF
// привязывает sourceX/targetX к точкам на границах, а легаси рисовал
// связи между центрами. Резервные связи разносятся по data.offset,
// фильтрованная связь рисуется пунктиром.
// RF не ставит на ребро тестируемый testid (там rf__edge-<id>), а сам id
// ребра (link:r1|sw1#0) известен только здесь — навешиваем data-testid на
// корневой <g>. data-* в тип BaseEdgeProps не входит, поэтому обёртка <g>
// нужна и ради testid (см. камни в шапке Task 18).
export function LinkEdge({ id, data, selected, markerEnd }: EdgeProps) {
  const { offset = 0, filtered = false, waypoints, from, to } = (data ?? {}) as {
    offset?: number; filtered?: boolean; waypoints?: Array<{ x: number; y: number }>;
    from?: { x: number; y: number }; to?: { x: number; y: number };
  };
  const path = from && to ? edgePath(from, to, offset, waypoints) : "";

  return (
    <g data-testid={id}>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: filtered ? "6 4" : undefined,
        }}
        className={filtered ? "link-edge filtered" : "link-edge"}
      />
    </g>
  );
}
