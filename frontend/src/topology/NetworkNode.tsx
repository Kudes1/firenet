import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { NET_H, NET_W } from "./icons";

// Узел сети — «облако»: цвет обводки по объединению, внутри имя и состав.
// Хэндл — только при isConnectable (см. камни в шапке Task 18).
export const NetworkNode = memo(function NetworkNode({ data, selected, isConnectable }: NodeProps) {
  const { name, unionColor, subnets, description } = data as unknown as {
    name: string; unionColor?: string; subnets?: string[]; description?: string;
  };
  return (
    <div
      className={`topo-node network-node${selected ? " selected" : ""}`}
      title={description || undefined}
      style={{ width: NET_W, height: NET_H, borderColor: unionColor }}
    >
      <span className="node-label">{name}</span>
      {!!subnets?.length && <span className="node-hint">{subnets.join(", ")}</span>}
      {isConnectable && <Handle type="target" position={Position.Left} />}
    </div>
  );
});
