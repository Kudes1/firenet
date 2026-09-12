import { BaseEdge, useReactFlow, type EdgeProps } from "@xyflow/react";
import { useCallback, useEffect, useState } from "react";
import { useEdgeActions } from "./edgeActions";

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

// Полигон пути: ломаная центр→waypoints→центр (как в легаси, stroke-linejoin
// даёт скругление вершин), иначе дуга через смещённую середину.
function edgePoints(from: { x: number; y: number }, to: { x: number; y: number }, offset: number,
  waypoints?: Array<{ x: number; y: number }>) {
  if (waypoints?.length) return [from, ...waypoints, to];
  const mid = pointAt(from, to, 0.5, spreadOffset(offset));
  return [from, mid, to];
}

const toPath = (pts: Array<{ x: number; y: number }>) =>
  pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");

// Проекция p на сегмент ab — ближайшая точка линии (хит-тест двойного клика).
function projectOnSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
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
  const { offset = 0, filtered = false, waypoints, from, to, diagnosticMark } = (data ?? {}) as {
    offset?: number; filtered?: boolean; waypoints?: Array<{ x: number; y: number }>;
    from?: { x: number; y: number }; to?: { x: number; y: number }; diagnosticMark?: string;
  };
  const actions = useEdgeActions();
  const { screenToFlowPosition } = useReactFlow();
  const editable = !!actions;

  // Двойной клик по линии: ближайший сегмент полилинии (только реальные
  // waypoints — синтетическая средняя точка дуги в полилинию не входит),
  // точка вставляется проекцией клика на сегмент. Двойной клик по маркеру
  // точки — удаление. Оба действия шлют полный массив точек связи.
  const handleDoubleClick = useCallback((event: React.MouseEvent) => {
    if (!actions || !from || !to) return;
    event.stopPropagation();
    const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const existing = waypoints ?? [];
    const without = existing.filter((w) => Math.hypot(w.x - flow.x, w.y - flow.y) > 8);
    if (without.length !== existing.length) {
      actions.changeWaypoints(id, without);
      return;
    }
    const line = [from, ...existing, to];
    let best = { dist: Infinity, at: -1, point: { x: 0, y: 0 } };
    for (let i = 0; i < line.length - 1; i++) {
      const projection = projectOnSegment(flow, line[i], line[i + 1]);
      const dist = Math.hypot(projection.x - flow.x, projection.y - flow.y);
      if (dist < best.dist) best = { dist, at: i, point: projection };
    }
    if (best.at < 0) return;
    const next = [...existing];
    next.splice(best.at, 0, best.point);
    actions.changeWaypoints(id, next);
  }, [actions, from, to, id, waypoints, screenToFlowPosition]);

  // Drag точки изгиба: локальное смещение в стейте на время drag, фиксация
  // одним изменением на pointerup (не спамя очередь операций).
  const [drag, setDrag] = useState<{ index: number; at: { x: number; y: number } } | null>(null);
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setDrag({ index: drag.index, at: flow });
    };
    const up = (event: PointerEvent) => {
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const next = [...(waypoints ?? [])];
      next[drag.index] = flow;
      actions?.changeWaypoints(id, next);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, waypoints, id, actions, screenToFlowPosition]);

  const startDrag = (index: number) => (event: React.PointerEvent) => {
    if (!actions) return;
    event.stopPropagation();
    // Стартовая точка — текущая позиция маркера. С нулевой точкой маркер
    // между pointerdown и первым pointermove отрисовывался бы в начале
    // координат: пользователь видел бы прыжок точки в левый верхний угол,
    // а dblclick по маркеру не дошёл бы до него (цель первого клика уехала).
    setDrag({ index, at: (waypoints ?? [])[index] ?? { x: 0, y: 0 } });
  };

  const live = drag ? (waypoints ?? []).map((w, i) => (i === drag.index ? drag.at : w)) : waypoints;
  const livePath = toPath(from && to ? edgePoints(from, to, offset, live) : []);

  return (
    <g data-testid={id}>
      <BaseEdge
        id={id}
        path={livePath}
        markerEnd={markerEnd}
        style={{
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: filtered ? "6 4" : undefined,
        }}
        className={[filtered ? "link-edge filtered" : "link-edge", diagnosticMark].filter(Boolean).join(" ")}
      />
      {editable && (
        <>
          {/* Широкая прозрачная подложка: ловит клик рядом с линией, а не
              только точно по тонкому path (RF-проблема хит-теста рёбер). */}
          <path d={livePath} className="link-hit" stroke="transparent" strokeWidth={14} fill="none"
            pointerEvents="stroke" onDoubleClick={handleDoubleClick} />
          {selected && (live ?? []).map((w, i) => (
            <circle
              key={i}
              data-testid={`waypoint:${id}:${i}`}
              cx={w.x} cy={w.y} r={5}
              className="waypoint-handle"
              // Контейнер ребра .react-flow__edge ставит pointer-events:
              // visibleStroke; унаследовав его, маркер ловил бы курсор только
              // обводкой, а не всем кругом. Круг целиком — цель drag/dblclick.
              pointerEvents="all"
              onDoubleClick={(event) => {
                event.stopPropagation();
                actions!.changeWaypoints(id, (waypoints ?? []).filter((_, j) => j !== i));
              }}
              onPointerDown={startDrag(i)}
            />
          ))}
        </>
      )}
    </g>
  );
}
