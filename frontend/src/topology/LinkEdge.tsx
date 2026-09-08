import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

// Ребро связи. Резервные (параллельные) связи разносятся по data.offset,
// фильтрованная связь рисуется пунктиром, waypoints добавляют изломы.
// RF не ставит на ребро тестируемого testid (там rf__edge-<id>), а сам id
// ребра (link:r1|sw1#0) известен только здесь — навешиваем data-testid на
// корневой <g>. data-* в тип BaseEdgeProps не входит, поэтому обёртка <g>
// нужна и ради testid (см. камни в шапке Task 18).
export function LinkEdge({
  id, sourceX, sourceY, targetX, targetY, data, selected, markerEnd,
}: EdgeProps) {
  const { offset = 0, filtered = false, waypoints } = (data ?? {}) as {
    offset?: number; filtered?: boolean; waypoints?: Array<{ x: number; y: number }>;
  };
  const spread = offset * 12;
  const points = waypoints?.length
    ? [{ x: sourceX, y: sourceY + spread }, ...waypoints, { x: targetX, y: targetY + spread }]
    : undefined;

  const [path] = getSmoothStepPath({
    sourceX,
    sourceY: sourceY + spread,
    targetX,
    targetY: targetY + spread,
    // getSmoothStepPath принимает sourcePosition/targetPosition опционально.
    ...(points ? { sourcePosition: undefined } : {}),
  });

  // Явные waypoints идут напрямую: getSmoothStepPath их не принимает, поэтому
  // для них собираем ломаную вручную.
  const finalPath = points
    ? `M ${points[0].x} ${points[0].y} ` + points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ")
    : path;

  return (
    <g data-testid={id}>
      <BaseEdge
        id={id}
        path={finalPath}
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
