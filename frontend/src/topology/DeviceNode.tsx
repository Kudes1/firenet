import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { DEVICE_H, DEVICE_W, kindStyle } from "./icons";

// Узел устройства: рамка по типу (радиус и цвет), глиф типа перед именем.
// memo — перерисовка нужна только при смене данных или выделения.
export const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps) {
  const { name, kind, description } = data as unknown as {
    name: string; kind: string; description?: string;
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
      }}
    >
      {style.glyph && (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d={style.glyph} fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )}
      <span className="node-label">{name} ({kind})</span>

    </div>
  );
});
