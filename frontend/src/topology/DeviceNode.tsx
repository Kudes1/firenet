import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { DEVICE_H, DEVICE_W, kindStyle } from "./icons";

// Узел устройства: рамка по типу (радиус и цвет), глиф типа перед именем.
// memo — перерисовка нужна только при смене данных или выделения.
// Хэндлы рендерятся только при isConnectable: RF не убирает их из DOM при
// nodesConnectable={false}, а лишь делает pointer-events:none (см. камни).
export const DeviceNode = memo(function DeviceNode({ data, selected, isConnectable }: NodeProps) {
  const { name, kind, unionColor, description } = data as unknown as {
    name: string; kind: string; unionColor?: string; description?: string;
  };
  const style = kindStyle(kind);
  return (
    <div
      className={`topo-node device-node kind-${kind}${selected ? " selected" : ""}`}
      title={description || undefined}
      style={{
        width: DEVICE_W,
        height: DEVICE_H,
        borderRadius: style.rx,
        borderColor: unionColor,
      }}
    >
      {style.glyph && (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d={style.glyph} fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )}
      <span className="node-label">{name} ({kind})</span>
      {isConnectable && <Handle type="source" position={Position.Right} />}
      {isConnectable && <Handle type="target" position={Position.Left} />}
    </div>
  );
});
