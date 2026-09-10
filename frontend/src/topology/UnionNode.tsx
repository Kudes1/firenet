import type { NodeProps } from "@xyflow/react";
import { memo } from "react";

// Узел-контур объединения: полупрозрачный прямоугольник с подписью в левом
// верхнем углу (легаси rrect + text). Не интерактивен — живёт под участниками.
export const UnionNode = memo(function UnionNode({ data }: NodeProps) {
  const { name, color, w, h } = data as unknown as { name: string; color: string; w: number; h: number };
  return (
    <svg className="union-outline" width={w} height={h} aria-hidden>
      <rect className="union-outline-rect" width={w} height={h} rx={14} stroke={color} fill={color} />
      <text className="union-outline-label" x={12} y={0} fill={color}>{name}</text>
    </svg>
  );
});
